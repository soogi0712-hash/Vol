// 역매공파 KR 실전 자동매매 — 지속실행 daemon (P0-35) — 실행: npm run yeokmae:kr-live [-- --dry-run | --once]
//   장중 살아있는 loop: STARTUP(재시작 복원) → 매 cycle (reconcile due? / BUY due? / SELL·EXIT / wait) 반복. Ctrl+C 까지 종료 안 함.
//   BUY(일봉 CONFIRMED, 112/224_UPGRADE)와 SELL(장중 -5/+8/-15/20일)의 주기 분리 — BUY 낮은빈도(캐시 read only), SELL 짧은주기.
//   ⚠️ 실 POST 는 postEnabled(krRealOrderEnabled ∧ t0424 정상 ∧ !dry-run) ∧ 정규장(KRX 09:00–15:30)일 때만. 수동보유 자동 SELL 금지.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached } from './ls-client';
import { makeScrubber } from './mask';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { getLSKRPrice, getLSKRBalance, getLSKRHoldings, placeLSKRBuyOrder, placeLSKRSellOrder, cancelLSKRBuyOrder, queryLSKROrderExecUnified, resolveKRMbrNo, krSession } from '../src/lib/ls-api';
import { YEOKMAE_STRATEGY_VALIDATED } from '../src/lib/yeokmae';
import { YeokmaePositionStore } from './yeokmae-position-store';
import { OrderStore, type OrderBuyEvidence } from './order-store';
import { evaluateManagedRecovery, mergeBuyEvidence, readEntryAvgOverride } from './yeokmae/position-recover';
import { executeKRBuyOrder, type KRTraderDeps } from './kr-trader';
import { DailyCache, YEOKMAE_DAILY_ROOT } from './yeokmae-daily-cache';
import { scanCachedDiscovery, confirmedCandles, loadNameMap } from './yeokmae/discovery-scan';
import { selectKRBuyCandidates, computeKRCapitalGuard, resolveKRExitPolicy, reconcileKRLedgerVsHoldings, krRealOrderEnabled, type KRBuyCandidate } from './yeokmae/kr-live-core';
import { executeKRSellOrder } from './kr-seller';
import { runYeokmaeKRSell, type KRSellIO } from './yeokmae-kr-sell-run';
import { resolveLoopIntervals, isDue, runManagedSellCycle, type Quote } from './yeokmae/loop-core';
import { TradeJournal, computeDailyReport, formatDailyReport } from './yeokmae-trade-journal';
import { writeHeartbeat } from './heartbeat';
import { buildYeokmaeSnapshot } from '../src/lib/yeokmae';
import { join } from 'node:path';

// order-store 파일 → 매수증거(읽기전용). 없으면 빈 증거.
function orderEvidence(key: string): OrderBuyEvidence { const s = new OrderStore(key); s.load(); return s.buyEvidence(); }

function scanKRPendingBuy(dir = join(YEOKMAE_DAILY_ROOT, '..')): { totalKRW: number; symbols: Set<string> } {
  const symbols = new Set<string>(); let totalKRW = 0;
  if (!existsSync(dir)) return { totalKRW, symbols };
  for (const f of readdirSync(dir)) {
    const m = /^us-orders-(YEOKMAE_KR_.+)\.json$/.exec(f);
    if (!m) continue;
    try {
      const body = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      for (const po of (body.pending ?? [])) if (po && po.side === 'buy') { totalKRW += (Number(po.qty) || 0) * (Number(po.price) || 0); symbols.add(m[1].replace('YEOKMAE_KR_', '')); }
    } catch { /* skip */ }
  }
  return { totalKRW, symbols };
}

async function main() {
  loadEnvLocal();
  const log = createLogger('yeokmae-kr-live');
  const env = process.env;
  const argv = process.argv.slice(2);
  const dryRunFlag = argv.includes('--dry-run');
  const onceFlag = argv.includes('--once');
  const liveTrading = env.LS_LIVE_TRADING === 'true';
  const yeokmaeLive = env.YEOKMAE_LIVE_TRADING === 'true';
  const krLive = env.YEOKMAE_KR_LIVE_TRADING === 'true';
  const legacyBbBlocked = env.LEGACY_BB_LIVE_ENABLED !== 'true';
  const totalCapitalKRW = Number(env.YEOKMAE_KR_TOTAL_CAPITAL_KRW || 1_000_000) || 1_000_000;
  const perTradeKRW = Number(env.YEOKMAE_KR_PER_TRADE_KRW || 100_000) || 100_000;
  const exit = resolveKRExitPolicy(env);
  const intervals = resolveLoopIntervals(env, 'KR');

  log.info(`===== [YEOKMAE-KR-LIVE] KR 역매공파 실전 자동매매 (지속실행 daemon${dryRunFlag ? ' · --dry-run POST=0' : ''}${onceFlag ? ' · --once' : ''}) =====`);
  log.info(`[YEOKMAE-KR-VALIDATION] YEOKMAE_STRATEGY_VALIDATED=${YEOKMAE_STRATEGY_VALIDATED}(레거시 하드블록, KR경로 미사용) · LS_LIVE_TRADING=${liveTrading} YEOKMAE_LIVE_TRADING=${yeokmaeLive} YEOKMAE_KR_LIVE_TRADING=${krLive} legacyBbBlocked=${legacyBbBlocked}`);
  log.info(`[YEOKMAE-KR-CAPITAL] totalCapitalKRW=${totalCapitalKRW} perTradeKRW=${perTradeKRW} → 최대 약 ${Math.floor(totalCapitalKRW / perTradeKRW)}종목 분산. 신용/미수 금지(cash-only).`);
  log.info(`[YEOKMAE-KR-BUY-SOURCE] source=YEOKMAE(112_UPGRADE OR 224_UPGRADE only, CONFIRMED 일봉만) · ORIGINAL/LONG_TERM=관찰만 · BB/RSI BUY=완전 비활성(legacyBbBlocked=${legacyBbBlocked})`);
  log.info(`[YEOKMAE-KR-EXIT-POLICY] stopLoss=${exit.stopLossPct ?? '미결정'} takeProfit=${exit.takeProfitPct ?? '미결정'} maxHoldDays=${exit.maxHoldDays ?? '미결정'} emergencyStop=-${exit.emergencyStopPct}%(항상활성) confirmed=${exit.confirmed}`);
  log.info(`[YEOKMAE-KR-INTERVALS] sell=${intervals.sellMs}ms reconcile=${intervals.reconcileMs}ms buyRecalc=${intervals.buyRecalcMs}ms loopLog=${intervals.loopLogMs}ms (rate limiter ≥1.1s 직렬 준수)`);
  if (exit.pendingDecisions.length) log.warn(`[YEOKMAE-KR-EXIT-PENDING] 사용자 결정 필요: [${exit.pendingDecisions.join(' · ')}]`);

  let cfg; try { cfg = loadConfig(); } catch (e) { log.error(`[YEOKMAE-KR-LIVE] FAIL_CLOSED(config: ${String(e)})`); process.exit(2); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); } catch (e) { log.error(`[YEOKMAE-KR-LIVE] FAIL_CLOSED(token: ${scrub(String(e))})`); process.exit(2); return; }

  // ── STARTUP: 재시작 안전 — 원장/pending 복원. ──
  const posStore = new YeokmaePositionStore(); posStore.load();
  const nameOf = loadNameMap('KR');
  const journal = new TradeJournal('KR'); journal.load();
  const mbr = resolveKRMbrNo(env.LS_KR_MBR_NO);
  const today0 = new Date().toISOString().slice(0, 10);

  // 루프 공유 상태
  let candidates: KRBuyCandidate[] = [];
  const brokerQtyMap = new Map<string, number>();
  const sellableBySym = new Map<string, number>();
  const loggedManual = new Set<string>();
  let t0424ok = false;
  let orderableCash = 0;

  async function refreshBalance(): Promise<void> {
    try { const bal = await getLSKRBalance(cfg, token); orderableCash = bal.orderableCash; }
    catch (e) { orderableCash = 0; log.warn(`[YEOKMAE-KR-ACCOUNT] 잔고 조회 실패 → 자본가드 현금항목 0. ${scrub(String(e))}`); }
  }
  // holdings reconcile(더 긴 주기) — t0424 → brokerQtyMap 갱신 + 수동보유 보호 + 원장 대조.
  async function doReconcile(): Promise<void> {
    const krPositions = posStore.corrupt ? [] : posStore.all().filter(p => p.exchcd === 'KR' && p.qty > 0);
    const heldSymbols = new Set(krPositions.map(p => p.symbol));
    try {
      const h = await getLSKRHoldings(cfg, token);
      t0424ok = h.ok;
      brokerQtyMap.clear(); sellableBySym.clear();
      for (const x of h.holdings) { brokerQtyMap.set(x.symbol, x.balQty); sellableBySym.set(x.symbol, x.sellableQty); }
      log.info(`[YEOKMAE-KR-HOLDINGS-DIAG] rsp_cd=${h.rspCd || '-'} rsp_msg=${h.rspMsg || '-'} rows=${h.rawRows} broker보유=${h.holdings.length}종목 원장=${krPositions.length}종목 (성공코드 00000 → ${t0424ok ? '정상' : 'fail-closed(BUY·SELL 차단)'})`);
      if (!t0424ok) log.warn(`[YEOKMAE-KR-HOLDINGS-DIAG] rsp_cd≠00000 → 임의 성공처리 금지 · BUY/SELL fail-closed.`);
      // ── P0-37: 과거 Vol BUY 증거 + broker 보유 일치 시 managed-position 복원(수동보유 오인 해소). ──
      if (t0424ok) {
        for (const x of h.holdings) {
          if (heldSymbols.has(x.symbol)) continue;   // 이미 원장 관리중
          const ev = mergeBuyEvidence([orderEvidence(`YEOKMAE_KR_${x.symbol}`), orderEvidence(`KR_${x.symbol}`)], x.symbol);
          const dec = evaluateManagedRecovery({ symbol: x.symbol, market: 'KR', brokerQty: x.balQty, brokerAvgPrice: x.avgPrice, evidence: ev, exchcd: 'KR', entryAvgOverride: readEntryAvgOverride(env, 'KR', x.symbol) });
          if (dec.action === 'RECOVER') {
            posStore.applyYeokmaeBuyFill({ symbol: x.symbol, exchcd: 'KR', entryDate: dec.entryDate ?? new Date().toISOString().slice(0, 10), fillQty: dec.qty, fillPrice: dec.entryAvgPrice, confirmedSignalDate: dec.entryDate, matchedSignals: [] });
            posStore.flush(); heldSymbols.add(x.symbol);
            log.info(`[YEOKMAE-KR-RECONCILE] symbol=${x.symbol} status=MATCH managed=true qty=${dec.qty} entryAvg=${dec.entryAvgPrice}(${dec.avgSource}) → 복원(${dec.reason})`);
          } else if (dec.action === 'FAILCLOSED') {
            if (!loggedManual.has(x.symbol)) { loggedManual.add(x.symbol); log.warn(`[YEOKMAE-KR-RECOVER-FAILCLOSED] symbol=${x.symbol} balQty=${x.balQty} → 복원 보류(수동보유 유지). ${dec.reason}`); }
          }
        }
      }
      const heldNow = new Set(posStore.all().filter(p => p.exchcd === 'KR' && p.qty > 0).map(p => p.symbol));
      for (const r of reconcileKRLedgerVsHoldings([...heldNow].map(s => ({ symbol: s, qty: brokerQtyMap.get(s) ?? 0 })), h.holdings)) {
        if (r.status !== 'MATCH') log.warn(`[YEOKMAE-KR-RECONCILE] ${r.symbol} ledgerQty=${posStore.get(r.symbol)?.qty ?? 0} brokerQty=${r.brokerQty} sellable=${r.brokerSellable} status=${r.status} — 자동삭제 금지, MATCH 아니면 자동 exit 보류.`);
      }
      for (const x of h.holdings) {
        if (!heldNow.has(x.symbol) && !loggedManual.has(x.symbol)) { loggedManual.add(x.symbol); log.warn(`[YEOKMAE-KR-MANUAL-HOLDING] symbol=${x.symbol} balQty=${x.balQty} sellable=${x.sellableQty} → 프로그램 원장 외(수동/기존 보유·증거없음). 자동 SELL 절대 금지 · BUY 후보 제외(commingling 방지).`); }
      }
    } catch (e) { t0424ok = false; log.error(`[YEOKMAE-KR-HOLDINGS-DIAG] t0424 조회 예외 → BUY/SELL fail-closed. ${scrub(String(e))}`); }
  }

  const krBuyDeps: KRTraderDeps = {
    place: (pp) => placeLSKRBuyOrder(cfg, token, pp),
    queryExec: (pp) => queryLSKROrderExecUnified(cfg, token, pp),
    cancel: (pp) => cancelLSKRBuyOrder(cfg, token, pp),
    cashOrderable: async () => { try { const b = await getLSKRBalance(cfg, token); return { ok: true, cash: b.orderableCash }; } catch { return { ok: false, cash: 0 }; } },
    now: () => Date.now(), log: (m) => log.info(m),
  };
  const sellIO: KRSellIO = {
    reconcile: async (pp) => { const q = await queryLSKROrderExecUnified(cfg, token, { shcode: pp.shcode, ordDate: pp.ordDate, bnsTpCode: '1' }); return { ok: q.ok, classification: q.classification ?? '-' }; },
    executeSell: executeKRSellOrder,
    sellDeps: {
      place: (pp) => placeLSKRSellOrder(cfg, token, pp),
      queryExec: (pp) => queryLSKROrderExecUnified(cfg, token, pp),
      freshSellable: async (pp) => { try { const h = await getLSKRHoldings(cfg, token); const hh = h.holdings.find(x => x.symbol === pp.shcode); return { ok: h.ok, qty: hh?.sellableQty ?? 0 }; } catch { return { ok: false, qty: 0 }; } },
      now: () => Date.now(), log: (m) => log.info(m),
    },
  };

  // BUY 사이클(낮은빈도) — persistent cache read only(재다운로드 없음) → 후보 재계산 + 자본가드 + (postEnabled&정규장? 실 POST : PLAN).
  async function doBuyCycle(postEnabled: boolean, sessionOrderable: boolean): Promise<void> {
    const { cached, results } = scanCachedDiscovery('KR');
    const krPositions = posStore.all().filter(p => p.exchcd === 'KR' && p.qty > 0);
    const heldSymbols = new Set(krPositions.map(p => p.symbol));
    const brokerSymbols = new Set(brokerQtyMap.keys());
    const pend = scanKRPendingBuy();
    const buyExclude = new Set<string>([...heldSymbols, ...brokerSymbols]);
    candidates = selectKRBuyCandidates(results, { heldSymbols: buyExclude, pendingSymbols: pend.symbols });
    log.info(`[YEOKMAE-KR-BUY-CHECK] cached=${cached} candidates=${candidates.length} (BOTH=${candidates.filter(c => c.tier === 'BOTH_UPGRADE').length}) 제외=원장${heldSymbols.size}+계좌${brokerSymbols.size}+pending${pend.symbols.size} postEnabled=${postEnabled} session=${sessionOrderable ? 'REGULAR' : 'CLOSED(주문보류)'}`);
    if (!postEnabled || !sessionOrderable) return;   // dry-run/게이트오프/장외 → 후보만 표시(POST 0)

    await refreshBalance();
    const investedKRW = krPositions.reduce((s, p) => s + p.qty * p.entryAvgPrice, 0);
    let runningInvested = investedKRW, runningPending = pend.totalKRW;
    const maxReport = Math.max(3, Math.floor(totalCapitalKRW / perTradeKRW) + 3);
    const today = new Date().toISOString().slice(0, 10); const krDate = today.replace(/-/g, '');
    for (const c of candidates.slice(0, maxReport)) {
      let price = 0;
      try { price = (await getLSKRPrice(cfg, token, c.symbol)).price; } catch (e) { log.warn(`[YEOKMAE-KR-CAPITAL-GUARD] ${c.symbol} 시세 실패 → skip. ${scrub(String(e))}`); continue; }
      const guard = computeKRCapitalGuard({ totalCapitalKRW, perTradeKRW, investedKRW: runningInvested, pendingKRW: runningPending, price, orderableCash });
      log.info(`[YEOKMAE-KR-CAPITAL-GUARD] symbol=${c.symbol} tier=${c.tier} price=${price} finalQty=${guard.finalQty} investKRW=${Math.round(guard.candidateKRW)} canNewBuy=${guard.canNewBuy} reason=${guard.reason} (budgetQty=${guard.budgetQty} cashQty=${guard.cashQty} capacityQty=${guard.capacityQty})`);
      if (!guard.canNewBuy) continue;
      const orders = new OrderStore(`YEOKMAE_KR_${c.symbol}`); orders.load();
      const out = await executeKRBuyOrder(krBuyDeps, { orders, shcode: c.symbol, candleDatetime: c.signalDate ?? krDate, qty: guard.finalQty, price, krDate, mbrNo: mbr.value, dailyMaxBuys: 1 });
      log.info(`[YEOKMAE-KR-BUY] symbol=${c.symbol} status=${out.status} ordNo=${out.ordNo ?? '-'} execQty=${out.execQty} qty=${guard.finalQty} price=${price} reason=${out.reason}${out.abortCode ? ` abortCode=${out.abortCode}` : ''}`);
      const filledQty = (out.status === 'placed-filled' || out.status === 'placed-partial') ? out.execQty : 0;
      if (filledQty > 0) {
        posStore.applyYeokmaeBuyFill({ symbol: c.symbol, exchcd: 'KR', entryDate: today, fillQty: filledQty, fillPrice: price, confirmedSignalDate: c.signalDate, matchedSignals: c.signalTypes });
        posStore.flush();
        journal.append({ ts: new Date().toISOString(), market: 'KR', side: 'BUY', symbol: c.symbol, name: nameOf.get(c.symbol) ?? '?', signalType: c.signalTypes, signalDate: c.signalDate, orderPrice: price, fillPrice: price, qty: filledQty, investedKRW: filledQty * price, exitReason: null, realizedPnL: null, ordNo: out.ordNo, status: out.status });
        journal.flush();
        runningInvested += filledQty * price;
      }
    }
  }

  // SELL/EXIT 사이클(짧은주기) — 관리 포지션 위험청산. 현재가는 검증된 getLSKRPrice 재조회(임의/stale 금지).
  async function doSellCycle(postEnabled: boolean, sessionOrderable: boolean, verbose: boolean): Promise<{ sells: number; evaluated: number }> {
    const krPositions = posStore.all().filter(p => p.exchcd === 'KR' && p.qty > 0);
    const res = await runManagedSellCycle({
      quote: async (pp): Promise<Quote> => { try { const q = await getLSKRPrice(cfg, token, pp.symbol); return { ok: q.price > 0, price: q.price, stale: false }; } catch (e) { return { ok: false, price: 0, stale: true, reason: scrub(String(e)) }; } },
      brokerQtyOf: (symbol) => brokerQtyMap.has(symbol) ? brokerQtyMap.get(symbol)! : null,
      runSell: async ({ position, price, decision }) => {
        const orders = new OrderStore(`YEOKMAE_KR_${position.symbol}`); orders.load();
        const krDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const r = await runYeokmaeKRSell(sellIO, {
          posStore, orders, position, journal, name: nameOf.get(position.symbol) ?? '?',
          exitAction: decision.action, exitReason: decision.reason, pnlPct: decision.pnlPct,
          currentPrice: price, krDate, sellLive: postEnabled, exitConfirmed: exit.confirmed, dryRun: !postEnabled, mbrNo: mbr.value,
          log: (m) => log.info(m),
        });
        return { posted: r.status === 'placed-filled' || r.status === 'placed-partial' || r.status === 'placed-pending' };
      },
      log: (m) => log.info(m),
    }, { positions: krPositions, policy: exit, sessionOrderable, verbose, tag: 'KR' });
    if (verbose || res.sells > 0 || res.skippedStale > 0 || res.skippedUnmatched > 0) {
      log.info(`[YEOKMAE-KR-EXIT-CHECK] managedPositions=${krPositions.length} evaluated=${res.evaluated} sells=${res.sells} holds=${res.holds} stale=${res.skippedStale} unmatched=${res.skippedUnmatched} deferredClosed=${res.deferredClosed}`);
    }
    return { sells: res.sells, evaluated: res.evaluated };
  }

  // ── graceful shutdown ──
  let stopping = false; let wake: (() => void) | null = null;
  const interruptibleSleep = (ms: number) => new Promise<void>((resolve) => { const t = setTimeout(() => { wake = null; resolve(); }, ms); wake = () => { clearTimeout(t); wake = null; resolve(); }; });
  const onStop = () => { if (stopping) { process.exit(130); return; } stopping = true; log.info('[YEOKMAE-KR-SHUTDOWN] 종료신호 수신 — 새 주문 중단, store flush 후 정상 종료 진행…'); if (wake) wake(); };
  process.on('SIGINT', onStop); process.on('SIGTERM', onStop);

  // ── STARTUP 초기 복원 + 게이트 로그. ──
  await doReconcile();
  const initGate = krRealOrderEnabled({ liveTrading, yeokmaeLive, krLive, exitConfirmed: exit.confirmed });
  log.info(`[YEOKMAE-KR-REAL-ORDER-GATE] KR_REAL_ORDER_ENABLED=${initGate.enabled} buyPathReady=${initGate.buyPathReady} sellPathReady=${initGate.sellPathReady} reasons=[${initGate.reasons.join(',') || '없음(전부충족)'}] dryRun=${dryRunFlag}`);
  {
    const startPost = initGate.enabled && t0424ok && !dryRunFlag;
    log.info(`[YEOKMAE-KR-LIVE-CFG] realOrderEnabled=${startPost} totalCapital=${totalCapitalKRW} perTrade=${perTradeKRW} stopLoss=${exit.stopLossPct == null ? '미설정' : '-' + exit.stopLossPct} takeProfit=${exit.takeProfitPct == null ? '미설정' : '+' + exit.takeProfitPct} maxHold=${exit.maxHoldDays ?? '미설정'} emergency=-${exit.emergencyStopPct} (gate=${initGate.enabled} t0424ok=${t0424ok} dryRun=${dryRunFlag})`);
  }

  // ── 메인 루프(Ctrl+C 까지) ──
  let cycle = 0; let lastReconcileAt: number | null = Date.now(); let lastBuyAt: number | null = null; let lastLogAt: number | null = null;
  log.info(`[YEOKMAE-KR-LOOP] daemon 시작 — Ctrl+C 로 종료. sell=${intervals.sellMs}ms 주기.`);
  while (!stopping) {
    cycle++;
    const now = Date.now();
    const kt = krSession(new Date());
    const sessionOrderable = kt.session === 'REGULAR';

    if (isDue(lastReconcileAt, intervals.reconcileMs, now)) { await doReconcile(); lastReconcileAt = now; }
    const gate = krRealOrderEnabled({ liveTrading, yeokmaeLive, krLive, exitConfirmed: exit.confirmed });
    const postEnabled = gate.enabled && t0424ok && !dryRunFlag;

    const verboseThisCycle = isDue(lastLogAt, intervals.loopLogMs, now) || cycle === 1;
    if (isDue(lastBuyAt, intervals.buyRecalcMs, now) || cycle === 1) { await doBuyCycle(postEnabled, sessionOrderable); lastBuyAt = now; }
    const sell = await doSellCycle(postEnabled, sessionOrderable, verboseThisCycle);

    const managedNow = posStore.all().filter(p => p.exchcd === 'KR' && p.qty > 0).length;
    writeHeartbeat('KR', { cycle, session: kt.session, postEnabled, managed: managedNow });   // Docker healthcheck
    log.info(`[YEOKMAE-KR-LOOP] cycle=${cycle} session=${kt.session} postEnabled=${postEnabled} managed=${managedNow} candidates=${candidates.length} evaluated=${sell.evaluated} sellsThisCycle=${sell.sells}`);
    if (verboseThisCycle) lastLogAt = now;

    if (stopping || onceFlag) break;
    await interruptibleSleep(intervals.sellMs);
  }

  // ── shutdown: store flush + 일일리포트 + 종료. ──
  try { posStore.flush(); journal.flush(); } catch { /* noop */ }
  const krPositions = posStore.all().filter(p => p.exchcd === 'KR' && p.qty > 0);
  const holdings = krPositions.map(p => { const cache = new DailyCache('KR', p.symbol); cache.load(); const snap = cache.corrupt ? null : buildYeokmaeSnapshot(p.symbol, confirmedCandles(cache)); return { symbol: p.symbol, qty: p.qty, entryAvgPrice: p.entryAvgPrice, lastPrice: snap?.ohlcv.close ?? null }; });
  log.info(formatDailyReport(computeDailyReport({ market: 'KR', date: today0, signals: candidates.length, entries: journal.entries(), holdings }), 'YEOKMAE-KR-DAILY-REPORT'));
  log.info(`[YEOKMAE-KR-SHUTDOWN] 완료 — cycles=${cycle} managed=${krPositions.length} · store flush 완료 · 정상 종료.${onceFlag ? ' (--once)' : ''}`);
  log.info(`[YEOKMAE-SAFETY] KR 전용 게이트(US 미개방) · 수동/기존 보유 자동 SELL 금지 · REAL_ORDER_FROM_YEOKMAE(표시라벨)=${env.REAL_ORDER_FROM_YEOKMAE === 'true'}`);
  process.exit(0);
}
main();
