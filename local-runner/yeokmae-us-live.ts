// 역매공파 US 실전 자동매매 — 지속실행 daemon (P0-34L) — 실행: npm run yeokmae:us-live [-- --dry-run | --once]
//   장중 살아있는 loop: STARTUP → (reconcile/holdings/BUY/SELL·EXIT/wait) 반복. Ctrl+C 까지 종료 안 함(graceful shutdown).
//   BUY(일봉 CONFIRMED 신호)와 SELL(장중 가격 -5/+8/-15/20일)의 주기 분리 — BUY 낮은빈도(캐시 read only), SELL 짧은주기.
//   ⚠️ 매 cycle g3204 재다운로드 금지(persistent cache 사용, 증분은 build-us-history). 기존 US 안전 인프라/정책 무변경.
//   ⚠️ 실 BUY/SELL POST 는 postEnabled(usRealOrderEnabled ∧ holdings 정상 ∧ !dry-run) ∧ 정규장 세션일 때만. 수동보유 자동 SELL 금지.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached, resolveUSQuote } from './ls-client';
import { makeScrubber } from './mask';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
  getLSUSPrice, getLSUSHoldings, getLSUSDeposit, usCashOnlyUsdCap, usEtSession,
  placeLSUSBuyOrder, placeLSUSSellOrder, queryLSUSOrderExec, cancelLSUSOrder,
  LS_US_ORDEREXEC_EMPTY_CODES,
} from '../src/lib/ls-api';
import { usCrossWonVerified } from './live-config';
import { YEOKMAE_STRATEGY_VALIDATED } from '../src/lib/yeokmae';
import { YeokmaePositionStore, type YeokmaePosition } from './yeokmae-position-store';
import { OrderStore, type OrderBuyEvidence } from './order-store';
import { evaluateManagedRecovery, mergeBuyEvidence, readEntryAvgOverride, readExchcdOverride, extractAccountFills, type AccountFill } from './yeokmae/position-recover';
import { programInvestedUSD } from './us-position';
import { executeBuyOrder, type TraderDeps } from './trader';
import { executeSellOrder } from './us-seller';
import { fetchUSDaily } from './yeokmae/us-daily';
import { DailyCache, YEOKMAE_DAILY_ROOT } from './yeokmae-daily-cache';
import { scanCachedDiscovery, confirmedCandles, loadNameMap } from './yeokmae/discovery-scan';
import {
  usRealOrderEnabled, usSellEnabled, resolveUSExitPolicy, selectUSBuyCandidates, computeUSYeokmaeCapitalGuard,
  reconcileUSLedgerVsHoldings, type USBuyCandidate,
} from './yeokmae/us-live-core';
import { resolveUSLoopIntervals, isDue, runUSSellCycle, type USQuote } from './yeokmae/us-loop-core';
import { runYeokmaeUSSell, type USSellIO } from './yeokmae-us-sell-run';
import { TradeJournal, computeDailyReport, formatDailyReport } from './yeokmae-trade-journal';
import { writeHeartbeat } from './heartbeat';
import { buildYeokmaeSnapshot } from '../src/lib/yeokmae';
import { join } from 'node:path';

function loadUSExchcdMap(): Map<string, { exchcd: string; exchange: string }> {
  const m = new Map<string, { exchcd: string; exchange: string }>();
  // 공식 전체 마스터 맵(build-us-history 생성) 먼저 — 넓은 커버리지(AIOT/AMSF 등 복원용).
  const full = join(YEOKMAE_DAILY_ROOT, 'US.symbol-exchcd.json');
  if (existsSync(full)) { try { const j = JSON.parse(readFileSync(full, 'utf8')); for (const [sym, ex] of Object.entries(j.exchcd ?? {})) if (sym && ex) m.set(sym, { exchcd: String(ex), exchange: 'US' }); } catch { /* noop */ } }
  // reverse-candidates 로 exchange 라벨 보강(있으면 덮어씀).
  const f = join(YEOKMAE_DAILY_ROOT, 'US.reverse-candidates.json');
  if (existsSync(f)) { try { const j = JSON.parse(readFileSync(f, 'utf8')); for (const c of (j.candidates ?? [])) if (c.symbol && c.exchcd) m.set(c.symbol, { exchcd: String(c.exchcd), exchange: c.exchange ?? 'US' }); } catch { /* noop */ } }
  return m;
}
// order-store 파일 → 매수증거(읽기전용). 없으면 빈 증거.
function orderEvidence(key: string): OrderBuyEvidence { const s = new OrderStore(key); s.load(); return s.buyEvidence(); }

function scanUSYeokmaePendingBuy(dir = join(YEOKMAE_DAILY_ROOT, '..')): { totalUSD: number; symbols: Set<string> } {
  const symbols = new Set<string>(); let totalUSD = 0;
  if (!existsSync(dir)) return { totalUSD, symbols };
  for (const f of readdirSync(dir)) {
    const mm = /^us-orders-(YEOKMAE_US_.+)\.json$/.exec(f);
    if (!mm) continue;
    try {
      const body = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      for (const po of (body.pending ?? [])) if (po && po.side === 'buy') { totalUSD += (Number(po.qty) || 0) * (Number(po.price) || 0); symbols.add(mm[1].replace('YEOKMAE_US_', '')); }
    } catch { /* skip */ }
  }
  return { totalUSD, symbols };
}

async function main() {
  loadEnvLocal();
  const log = createLogger('yeokmae-us-live');
  const env = process.env;
  const argv = process.argv.slice(2);
  const dryRunFlag = argv.includes('--dry-run');
  const onceFlag = argv.includes('--once');
  const liveTrading = env.LS_LIVE_TRADING === 'true';
  const yeokmaeLive = env.YEOKMAE_LIVE_TRADING === 'true';
  const usLive = env.YEOKMAE_US_LIVE_TRADING === 'true';
  const legacyBbBlocked = env.LEGACY_BB_LIVE_ENABLED !== 'true';
  const totalCapitalKRW = Number(env.LS_US_TOTAL_CAPITAL_KRW || 1_000_000) || 1_000_000;
  const perTradeKRW = Number(env.US_PER_TRADE_KRW || 100_000) || 100_000;
  const exit = resolveUSExitPolicy(env);
  const usQuote = resolveUSQuote();
  const delaygb = usQuote.delaygb ?? 'R';   // ⚠️ DELAYED 인데 LS_US_DELAYGB 미설정이면 'R'(실시간) fallback → 미권한 계정은 0 rows
  const crossWon = usCrossWonVerified();
  const intervals = resolveUSLoopIntervals(env);

  log.info(`===== [YEOKMAE-US-LIVE] US 역매공파 실전 자동매매 (지속실행 daemon${dryRunFlag ? ' · --dry-run POST=0' : ''}${onceFlag ? ' · --once' : ''}) =====`);
  log.info(`[YEOKMAE-US-VALIDATION] YEOKMAE_STRATEGY_VALIDATED=${YEOKMAE_STRATEGY_VALIDATED}(레거시 하드블록, US경로 미사용) · LS_LIVE_TRADING=${liveTrading} YEOKMAE_LIVE_TRADING=${yeokmaeLive} YEOKMAE_US_LIVE_TRADING=${usLive} legacyBbBlocked=${legacyBbBlocked} crossWonVerified=${crossWon}`);
  // P0-38: 해외시세 구분 진단 — g3204/g3101 이 rsp_cd=00000 인데 rows=0 이면 delaygb/시세권한 의심(TR/InBlock 은 공식 확인됨).
  log.info(`[YEOKMAE-US-QUOTE] mode=${usQuote.mode} delaygb=${delaygb}${usQuote.delaygb == null ? "(fallback 'R' — LS_US_DELAYGB 미설정)" : ''}${usQuote.error ? ` ⚠️ ${usQuote.error}` : ''} · REALTIME='R'(공식), DELAYED 지연코드는 LS_US_DELAYGB 로 지정(추측 금지). g3204 rows=0 + rsp_cd=00000 → 지연코드/시세신청 확인.`);
  log.info(`[YEOKMAE-US-CAPITAL] totalCapitalKRW=${totalCapitalKRW}(KR 과 별개) perTradeKRW=${perTradeKRW} → 실 baseXchRate 로 USD 환산(고정환율 금지). 신용/미수 금지(cash-only).`);
  log.info(`[YEOKMAE-US-BUY-SOURCE] source=YEOKMAE(112_UPGRADE OR 224_UPGRADE only, CONFIRMED 일봉만) · ORIGINAL/LONG_TERM=관찰만 · BB(20,2)+RSI BUY=완전 비활성(legacyBbBlocked=${legacyBbBlocked})`);
  log.info(`[YEOKMAE-US-EXIT-POLICY] stopLoss=${exit.stopLossPct ?? '미결정'} takeProfit=${exit.takeProfitPct ?? '미결정'} maxHoldDays=${exit.maxHoldDays ?? '미결정'} emergencyStop=-${exit.emergencyStopPct}%(항상활성) confirmed=${exit.confirmed} · ⚠️ 운영 risk policy(원본 역매공파 SELL 아님)`);
  log.info(`[YEOKMAE-US-INTERVALS] sell=${intervals.sellMs}ms reconcile=${intervals.reconcileMs}ms buyRecalc=${intervals.buyRecalcMs}ms loopLog=${intervals.loopLogMs}ms (rate limiter ≥1.1s 직렬 준수)`);
  if (exit.pendingDecisions.length) log.warn(`[YEOKMAE-US-EXIT-PENDING] 사용자 결정 필요: [${exit.pendingDecisions.join(' · ')}]`);

  let cfg; try { cfg = loadConfig(); } catch (e) { log.error(`[YEOKMAE-US-LIVE] FAIL_CLOSED(config: ${String(e)})`); process.exit(2); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); } catch (e) { log.error(`[YEOKMAE-US-LIVE] FAIL_CLOSED(token: ${scrub(String(e))})`); process.exit(2); return; }

  // ── STARTUP: 재시작 안전 — 원장/pending 복원 + 일봉 history 준비상태 probe(1회). ──
  const exchOf = loadUSExchcdMap();
  const posStore = new YeokmaePositionStore(); posStore.load();
  const nameOf = loadNameMap('US');
  const journal = new TradeJournal('US'); journal.load();
  const today0 = new Date().toISOString().slice(0, 10);
  const etDate0 = today0.replace(/-/g, '');

  // item1: g3204 일봉 실 rows>0 확인(1회, 매 cycle 재다운로드 금지) + 캐시 ready(600+봉) 종목수.
  let historyReady = false, readyCount = 0, cachedSymbols = 0, probeRows = 0; let probeSym = '-';
  {
    const scan = scanCachedDiscovery('US');
    cachedSymbols = scan.cached; readyCount = scan.results.filter(d => d.ready).length;
    const probePick = exchOf.get('AAPL') ? 'AAPL' : (exchOf.size ? [...exchOf.keys()][0] : '');
    let probeOk = false;
    if (probePick) {
      const ex = exchOf.get(probePick)!;
      try { const r = await fetchUSDaily(token, { symbol: probePick, exchcd: ex.exchcd, delaygb }, { nowMs: Date.now(), targetBars: 1, windowDays: 40, maxPages: 1 }); probeOk = r.ok && r.bars.length > 0; probeRows = r.bars.length; probeSym = probePick; }
      catch (e) { log.warn(`[YEOKMAE-US-DAILY-PROBE] ${probePick} g3204 예외 → probe 실패. ${scrub(String(e))}`); }
    }
    historyReady = probeOk && readyCount > 0;
    log.info(`[YEOKMAE-US-DAILY-PROBE] probeSymbol=${probeSym} exchcd=${probePick ? exchOf.get(probePick)?.exchcd : '-'} g3204 rows=${probeRows} probeOk=${probeOk} (gubun='2' 일봉, 1회 확인)`);
    log.info(`[YEOKMAE-US-HISTORY-CAPACITY] cachedSymbols=${cachedSymbols} ready(600+봉)=${readyCount} historyReady=${historyReady}${!historyReady ? ' → INSUFFICIENT_HISTORY(실주문 게이트 닫힘). npm run yeokmae:build-us-history 로 pool 구축.' : ''}`);
  }

  // ── 루프 공유 상태 ──
  let candidates: USBuyCandidate[] = [];
  const brokerQtyMap = new Map<string, number>();
  const loggedManual = new Set<string>();
  let usHoldingsOk = false;
  let cashOnlyUsd = 0, baseXchRate = 0;

  // 예수금/환율/현금(cash-only, CROSS-WON) 갱신.
  async function refreshDeposit(): Promise<void> {
    try { const dep = await getLSUSDeposit(cfg, token); baseXchRate = dep.baseXchRate; cashOnlyUsd = usCashOnlyUsdCap(dep, { crossWonVerified: crossWon }); }
    catch (e) { baseXchRate = 0; cashOnlyUsd = 0; log.warn(`[YEOKMAE-US-ACCOUNT] 예수금 조회 실패 → 환율/현금 0(자본가드 fail-closed). ${scrub(String(e))}`); }
  }
  // holdings reconcile(더 긴 주기) — brokerQtyMap 갱신 + 수동보유 보호 + 원장 대조.
  async function doReconcile(): Promise<void> {
    const usPositions = posStore.corrupt ? [] : posStore.all().filter(p => p.exchcd !== 'KR' && p.qty > 0);
    const heldSymbols = new Set(usPositions.map(p => p.symbol));
    try {
      const h = await getLSUSHoldings(cfg, token);
      usHoldingsOk = h.ok;
      brokerQtyMap.clear();
      for (const x of h.holdings) brokerQtyMap.set(x.symbol, x.balQty);
      log.info(`[YEOKMAE-US-HOLDINGS-DIAG] rsp_cd=${h.rspCd || '-'} rsp_msg=${h.rspMsg || '-'} rows=${h.rawRows} broker보유=${h.holdings.length}종목 원장=${usPositions.length}종목 (정상 → ${usHoldingsOk ? '정상' : 'fail-closed(BUY·SELL 차단)'})`);
      if (!usHoldingsOk) log.warn(`[YEOKMAE-US-HOLDINGS-DIAG] holdings 조회 성공코드 미확인 → 임의 성공처리 금지 · BUY/SELL fail-closed.`);
      // ── P0-37: 과거 Vol BUY 증거 + broker 보유 일치 시 managed-position 복원(수동보유 오인 해소). ──
      //   US 는 COSOQ00201 이 공식평단 미제공 → 평단은 env override(YEOKMAE_US_ENTRY_AVG_<sym>) 또는 order-store 주문가.
      //   exchcd 는 candidates 캐시(exchOf) > env override(YEOKMAE_US_EXCHCD_<sym>). 미해결이면 fail-closed(수동 유지).
      if (usHoldingsOk) {
        // 계좌이벤트(AS0/AS1) 실체결 증거 로드(읽기전용) — AIOT/AMSF 실 체결평단/수량.
        const evStore = new OrderStore('__account_events__'); evStore.load();
        const accountFills = extractAccountFills(evStore.tracked);
        for (const x of h.holdings) {
          if (heldSymbols.has(x.symbol)) continue;
          const ev = mergeBuyEvidence([orderEvidence(x.symbol), orderEvidence(`YEOKMAE_US_${x.symbol}`)], x.symbol);
          const fill: AccountFill | null = accountFills.get(x.symbol) ?? null;
          // exchcd 공식 우선순위: 계좌이벤트 AS0 거래소코드(주문 OrdMktCode) > g3190 마스터맵 > env override.
          const exchcd = (fill?.mktCode || '') || exchOf.get(x.symbol)?.exchcd || readExchcdOverride(env, x.symbol);
          const dec = evaluateManagedRecovery({ symbol: x.symbol, market: 'US', brokerQty: x.balQty, brokerAvgPrice: null, evidence: ev, accountFill: fill, exchcd, entryAvgOverride: readEntryAvgOverride(env, 'US', x.symbol) });
          if (dec.action === 'RECOVER') {
            posStore.applyYeokmaeBuyFill({ symbol: x.symbol, exchcd: dec.exchcd, entryDate: dec.entryDate ?? new Date().toISOString().slice(0, 10), fillQty: dec.qty, fillPrice: dec.entryAvgPrice, confirmedSignalDate: dec.entryDate, matchedSignals: [] });
            posStore.flush(); heldSymbols.add(x.symbol);
            log.info(`[YEOKMAE-US-RECONCILE] symbol=${x.symbol} status=MATCH managed=true qty=${dec.qty} exchcd=${dec.exchcd} entryAvg=${dec.entryAvgPrice}(${dec.avgSource}) → 복원(${dec.reason})`);
          } else if (dec.action === 'FAILCLOSED') {
            if (!loggedManual.has(x.symbol)) { loggedManual.add(x.symbol); log.warn(`[YEOKMAE-US-RECOVER-FAILCLOSED] symbol=${x.symbol} balQty=${x.balQty} → 복원 보류(수동보유 유지). ${dec.reason}`); }
          }
        }
      }
      const heldNow = new Set(posStore.all().filter(p => p.exchcd !== 'KR' && p.qty > 0).map(p => p.symbol));
      for (const r of reconcileUSLedgerVsHoldings([...heldNow].map(s => ({ symbol: s, qty: brokerQtyMap.get(s) ?? 0 })), h.holdings)) {
        if (r.status !== 'MATCH') log.warn(`[YEOKMAE-US-RECONCILE] ${r.symbol} ledgerQty=${posStore.get(r.symbol)?.qty ?? 0} brokerQty=${r.brokerQty} sellable=${r.brokerSellable} status=${r.status} — 자동삭제 금지, MATCH 아니면 자동 exit 보류.`);
      }
      for (const x of h.holdings) {
        if (!heldNow.has(x.symbol) && !loggedManual.has(x.symbol)) { loggedManual.add(x.symbol); log.warn(`[YEOKMAE-US-MANUAL-HOLDING] symbol=${x.symbol} balQty=${x.balQty} sellable=${x.sellableQty} → 프로그램 원장 외(수동/기존 보유·증거없음). 자동 SELL 절대 금지 · BUY 후보 제외(commingling 방지).`); }
      }
    } catch (e) { usHoldingsOk = false; log.error(`[YEOKMAE-US-HOLDINGS-DIAG] COSOQ00201 조회 예외 → BUY/SELL fail-closed. ${scrub(String(e))}`); }
  }

  const traderDeps: TraderDeps = {
    place: (pp) => placeLSUSBuyOrder(cfg, token, pp),
    query: (pp) => queryLSUSOrderExec(cfg, token, pp, { emptyCodes: LS_US_ORDEREXEC_EMPTY_CODES }),
    cancel: (pp) => cancelLSUSOrder(cfg, token, pp),
    cashOrderable: async () => { try { const d = await getLSUSDeposit(cfg, token); return { ok: d.ok, cash: usCashOnlyUsdCap(d, { crossWonVerified: crossWon }), rspCd: d.rspCd, rspMsg: scrub(d.rspMsg), httpStatus: d.diag?.status ?? null }; } catch { return { ok: false, cash: 0 }; } },
    now: () => Date.now(), log: (m) => log.info(m),
  };
  const sellIO: USSellIO = {
    reconcile: async (pp) => { const q = await queryLSUSOrderExec(cfg, token, { exchcd: pp.exchcd, symbol: pp.symbol, ordDate: pp.ordDate }, { emptyCodes: LS_US_ORDEREXEC_EMPTY_CODES }); return { ok: q.classification === 'SUCCESS' || q.classification === 'EMPTY', classification: q.classification }; },
    executeSell: executeSellOrder,
    sellDeps: {
      place: (pp) => placeLSUSSellOrder(cfg, token, pp),
      query: (pp) => queryLSUSOrderExec(cfg, token, pp, { emptyCodes: LS_US_ORDEREXEC_EMPTY_CODES }),
      sellableQty: async (pp) => { try { const h = await getLSUSHoldings(cfg, token); const hh = h.holdings.find(x => x.symbol === pp.symbol); return { ok: h.ok, qty: hh?.sellableQty ?? 0 }; } catch { return { ok: false, qty: 0 }; } },
      now: () => Date.now(), log: (m) => log.info(m),
    },
  };

  // BUY 사이클(낮은빈도) — persistent cache read only(g3204 재다운로드 없음) → 후보 재계산 + 자본가드 + (postEnabled&정규장? 실 POST : PLAN).
  async function doBuyCycle(postEnabled: boolean, sessionOrderable: boolean): Promise<void> {
    const scan = scanCachedDiscovery('US');
    const usPositions = posStore.all().filter(p => p.exchcd !== 'KR' && p.qty > 0);
    const heldSymbols = new Set(usPositions.map(p => p.symbol));
    const brokerSymbols = new Set(brokerQtyMap.keys());
    const pend = scanUSYeokmaePendingBuy();
    const buyExclude = new Set<string>([...heldSymbols, ...brokerSymbols]);
    candidates = selectUSBuyCandidates(scan.results, exchOf, { heldSymbols: buyExclude, pendingSymbols: pend.symbols });
    log.info(`[YEOKMAE-US-BUY-CHECK] candidates=${candidates.length} (BOTH=${candidates.filter(c => c.tier === 'BOTH_UPGRADE').length}) 제외=원장${heldSymbols.size}+계좌${brokerSymbols.size}+pending${pend.symbols.size} postEnabled=${postEnabled} session=${sessionOrderable ? 'REGULAR' : 'CLOSED(주문보류)'}`);
    candidates.slice(0, 5).forEach((c, i) => log.info(`[YEOKMAE-US-RANK] #${i + 1} symbol=${c.symbol} name=${nameOf.get(c.symbol) ?? '?'} exch=${c.exchange}(${c.exchcd}) tier=${c.tier} signalDate=${c.signalDate}`));
    if (!postEnabled || !sessionOrderable) return;   // dry-run/게이트오프/장외 → 후보만 표시(POST 0)

    await refreshDeposit();
    const investedUSD = programInvestedUSD(usPositions.map(p => ({ qty: p.qty, avgPrice: p.entryAvgPrice })));
    let runningInvestedUSD = investedUSD, runningPendingUSD = pend.totalUSD;
    const maxReport = Math.max(3, Math.floor(totalCapitalKRW / perTradeKRW) + 3);
    const today = new Date().toISOString().slice(0, 10); const etDate = today.replace(/-/g, '');
    for (const c of candidates.slice(0, maxReport)) {
      let price = 0;
      try { price = (await getLSUSPrice(cfg, token, c.symbol, c.exchcd, delaygb)).price; } catch (e) { log.warn(`[YEOKMAE-US-CAPITAL-GUARD] ${c.symbol} 시세 실패 → skip. ${scrub(String(e))}`); continue; }
      const guard = computeUSYeokmaeCapitalGuard({ totalCapitalKRW, perTradeKRW, investedUSD: runningInvestedUSD, pendingUSD: runningPendingUSD, bestAsk: price, baseXchRate, cashOnlyUsd });
      log.info(`[YEOKMAE-US-CAPITAL-GUARD] symbol=${c.symbol} tier=${c.tier} price=$${price} finalQty=${guard.finalQty} investUSD=${guard.candidateUSD.toFixed(2)}(≈${Math.round(guard.candidateKRW)}KRW) canNewBuy=${guard.canNewBuy} reason=${guard.reason} (perTradeQty=${guard.perTradeQty} cashQty=${guard.cashQty} capacityQty=${guard.capacityQty})`);
      if (!guard.canNewBuy) continue;
      const orders = new OrderStore(`YEOKMAE_US_${c.symbol}`); orders.load();
      const out = await executeBuyOrder(traderDeps, { orders, exchcd: c.exchcd, symbol: c.symbol, candleDatetime: c.signalDate ?? etDate, qty: guard.finalQty, price, etDate, dailyMaxBuys: 1, reqTag: 'YEOKMAE-US-BUY' });
      log.info(`[YEOKMAE-US-BUY] symbol=${c.symbol} status=${out.status} ordNo=${out.ordNo ?? '-'} qty=${guard.finalQty} price=$${price} reason=${out.reason}${out.abortCode ? ` abortCode=${out.abortCode}` : ''}`);
      const filledQty = out.status === 'placed-filled' ? guard.finalQty : 0;
      if (filledQty > 0) {
        posStore.applyYeokmaeBuyFill({ symbol: c.symbol, exchcd: c.exchcd, entryDate: today, fillQty: filledQty, fillPrice: price, confirmedSignalDate: c.signalDate, matchedSignals: c.signalTypes });
        posStore.flush();
        journal.append({ ts: new Date().toISOString(), market: 'US', side: 'BUY', symbol: c.symbol, name: nameOf.get(c.symbol) ?? '?', signalType: c.signalTypes, signalDate: c.signalDate, orderPrice: price, fillPrice: price, qty: filledQty, investedKRW: baseXchRate > 0 ? Math.round(filledQty * price * baseXchRate) : null, exitReason: null, realizedPnL: null, ordNo: out.ordNo, status: out.status });
        journal.flush();
        runningInvestedUSD += filledQty * price;
      }
    }
  }

  // SELL/EXIT 사이클(짧은주기) — 관리 포지션 위험청산 평가. 현재가는 검증된 g3101(getLSUSPrice) 재조회(임의/stale 금지).
  async function doSellCycle(postEnabled: boolean, sessionOrderable: boolean, verbose: boolean): Promise<{ sells: number; evaluated: number }> {
    const usPositions = posStore.all().filter(p => p.exchcd !== 'KR' && p.qty > 0);
    const res = await runUSSellCycle({
      quote: async (pp): Promise<USQuote> => { try { const q = await getLSUSPrice(cfg, token, pp.symbol, pp.exchcd, delaygb); return { ok: q.price > 0, price: q.price, stale: false }; } catch (e) { return { ok: false, price: 0, stale: true, reason: scrub(String(e)) }; } },
      brokerQtyOf: (symbol) => brokerQtyMap.has(symbol) ? brokerQtyMap.get(symbol)! : null,
      runSell: async ({ position, price, decision }) => {
        const orders = new OrderStore(`YEOKMAE_US_${position.symbol}`); orders.load();
        const today = new Date().toISOString().slice(0, 10); const etDate = today.replace(/-/g, '');
        const r = await runYeokmaeUSSell(sellIO, {
          posStore, orders, position, exchcd: position.exchcd, journal, name: nameOf.get(position.symbol) ?? '?',
          exitAction: decision.action, exitReason: decision.reason, pnlPct: decision.pnlPct,
          currentPrice: price, etDate, sellLive: postEnabled, exitConfirmed: exit.confirmed, dryRun: !postEnabled,
          log: (m) => log.info(m),
        });
        return { posted: r.status === 'placed-filled' || r.status === 'placed-partial' || r.status === 'placed-pending' };
      },
      log: (m) => log.info(m),
    }, { positions: usPositions, policy: exit, sessionOrderable, verbose, tag: 'US' });
    if (verbose || res.sells > 0 || res.skippedStale > 0 || res.skippedUnmatched > 0) {
      log.info(`[YEOKMAE-US-EXIT-CHECK] managedPositions=${usPositions.length} evaluated=${res.evaluated} sells=${res.sells} holds=${res.holds} stale=${res.skippedStale} unmatched=${res.skippedUnmatched} deferredClosed=${res.deferredClosed}`);
    }
    return { sells: res.sells, evaluated: res.evaluated };
  }

  // ── graceful shutdown ──
  let stopping = false; let wake: (() => void) | null = null;
  const interruptibleSleep = (ms: number) => new Promise<void>((resolve) => { const t = setTimeout(() => { wake = null; resolve(); }, ms); wake = () => { clearTimeout(t); wake = null; resolve(); }; });
  const onStop = () => {
    if (stopping) { process.exit(130); return; }
    stopping = true;
    log.info('[YEOKMAE-US-SHUTDOWN] 종료신호 수신(SIGINT/SIGTERM) — 새 주문 중단, store flush 후 정상 종료 진행…');
    if (wake) wake();
  };
  process.on('SIGINT', onStop); process.on('SIGTERM', onStop);   // Docker stop 은 SIGTERM

  // ── STARTUP 초기 복원: reconcile(holdings) + 초기 BUY 후보 계산 + 게이트 로그. ──
  await doReconcile();
  const initialGate = usRealOrderEnabled({ liveTrading, yeokmaeLive, usLive, exitConfirmed: exit.confirmed, historyReady });
  const initialSell = usSellEnabled({ liveTrading, yeokmaeLive, usLive, exitConfirmed: exit.confirmed });
  log.info(`[YEOKMAE-US-REAL-ORDER-GATE] BUY_ENABLED=${initialGate.enabled}(historyReady=${historyReady} reasons=[${initialGate.reasons.join(',') || '없음'}]) · SELL_ENABLED=${initialSell.enabled}(history 무관 reasons=[${initialSell.reasons.join(',') || '없음'}]) dryRun=${dryRunFlag}`);
  {
    const buyPost = initialGate.enabled && usHoldingsOk && !dryRunFlag;
    const sellPost = initialSell.enabled && usHoldingsOk && !dryRunFlag;
    log.info(`[YEOKMAE-US-LIVE-CFG] buyEnabled=${buyPost} sellEnabled=${sellPost} totalCapital=${totalCapitalKRW} perTrade=${perTradeKRW} stopLoss=${exit.stopLossPct == null ? '미설정' : '-' + exit.stopLossPct} takeProfit=${exit.takeProfitPct == null ? '미설정' : '+' + exit.takeProfitPct} maxHold=${exit.maxHoldDays ?? '미설정'} emergency=-${exit.emergencyStopPct} (holdingsOk=${usHoldingsOk} historyReady=${historyReady} dryRun=${dryRunFlag}) · ⚠️ SELL 은 historyReady 무관(청산 항상 감시)`);
  }

  // ── 메인 루프(Ctrl+C 까지) ──
  let cycle = 0; let lastReconcileAt: number | null = Date.now(); let lastBuyAt: number | null = null; let lastLogAt: number | null = null;
  log.info(`[YEOKMAE-US-LOOP] daemon 시작 — Ctrl+C 로 종료. sell=${intervals.sellMs}ms 주기.`);
  while (!stopping) {
    cycle++;
    const now = Date.now();
    const et = usEtSession(new Date());
    const sessionOrderable = et.session === 'REGULAR';

    if (isDue(lastReconcileAt, intervals.reconcileMs, now)) { await doReconcile(); lastReconcileAt = now; }
    // BUY 게이트(일봉 history 필요) 와 SELL 게이트(history 무관 — 청산은 현재가+원장) 분리(P0-38).
    const buyGate = usRealOrderEnabled({ liveTrading, yeokmaeLive, usLive, exitConfirmed: exit.confirmed, historyReady });
    const sellGate = usSellEnabled({ liveTrading, yeokmaeLive, usLive, exitConfirmed: exit.confirmed });
    const buyPostEnabled = buyGate.enabled && usHoldingsOk && !dryRunFlag;
    const sellPostEnabled = sellGate.enabled && usHoldingsOk && !dryRunFlag;

    const verboseThisCycle = isDue(lastLogAt, intervals.loopLogMs, now) || cycle === 1;   // CHECK 상세는 throttle
    if (isDue(lastBuyAt, intervals.buyRecalcMs, now) || cycle === 1) { await doBuyCycle(buyPostEnabled, sessionOrderable); lastBuyAt = now; }
    const sell = await doSellCycle(sellPostEnabled, sessionOrderable, verboseThisCycle);

    // [YEOKMAE-US-LOOP] 은 매 cycle 출력(살아있음 확인) — 상세 CHECK 로그만 throttle.
    const managedNow = posStore.all().filter(p => p.exchcd !== 'KR' && p.qty > 0).length;
    writeHeartbeat('US', { cycle, session: et.session, buyPostEnabled, sellPostEnabled, managed: managedNow });   // Docker healthcheck
    log.info(`[YEOKMAE-US-LOOP] cycle=${cycle} session=${et.session} buyPostEnabled=${buyPostEnabled} sellPostEnabled=${sellPostEnabled} historyReady=${historyReady} managed=${managedNow} candidates=${candidates.length} evaluated=${sell.evaluated} sellsThisCycle=${sell.sells}`);
    if (verboseThisCycle) lastLogAt = now;

    if (stopping || onceFlag) break;
    await interruptibleSleep(intervals.sellMs);
  }

  // ── shutdown: store flush + 일일리포트 + 종료. ──
  try { posStore.flush(); journal.flush(); } catch { /* noop */ }
  const usPositions = posStore.all().filter(p => p.exchcd !== 'KR' && p.qty > 0);
  const holdings = usPositions.map(p => { const cache = new DailyCache('US', p.symbol); cache.load(); const snap = cache.corrupt ? null : buildYeokmaeSnapshot(p.symbol, confirmedCandles(cache)); return { symbol: p.symbol, qty: p.qty, entryAvgPrice: p.entryAvgPrice, lastPrice: snap?.ohlcv.close ?? null }; });
  log.info(formatDailyReport(computeDailyReport({ market: 'US', date: today0, signals: candidates.length, entries: journal.entries(), holdings }), 'YEOKMAE-US-DAILY-REPORT'));
  log.info(`[YEOKMAE-US-SHUTDOWN] 완료 — cycles=${cycle} managed=${usPositions.length} · store flush 완료 · 정상 종료.${onceFlag ? ' (--once)' : ''}`);
  log.info(`[YEOKMAE-SAFETY] KR 과 별개 게이트(KR 승인으로 US 자동활성 금지) · 수동/기존 보유 자동 SELL 금지 · REAL_ORDER_FROM_YEOKMAE(표시라벨)=${env.REAL_ORDER_FROM_YEOKMAE === 'true'}`);
  process.exit(0);
}
main();
