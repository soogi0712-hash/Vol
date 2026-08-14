// 역매공파 US 실전 자동매매 (P0-34) — 실행: npm run yeokmae:us-live -- [--dry-run]
//   실 BUY/SELL POST 는 단일 최종게이트 postEnabled = usRealOrderEnabled(LS_LIVE ∧ YEOKMAE_LIVE ∧ YEOKMAE_US_LIVE_TRADING
//     ∧ YEOKMAE_US_EXIT_CONFIRMED ∧ US_DAILY_HISTORY_READY ∧ BUY/SELL path) ∧ COSOQ00201 holdings 정상 ∧ --dry-run 미지정 일 때만.
//   BUY(UPGRADE-only, CONFIRMED-only) + 자본가드(총100만/종목10만 KRW→USD 실환율, cash-only) + 위험청산(원장 대상만) + 수동보유 보호.
//   ⚠️ 기존 BB(20,2)+RSI BUY 완전 OFF(실주문 경로). 기존 US 주문/체결/보유/reconcile/SELL/capital 인프라 보존, BUY source 만 YEOKMAE.
//   ⚠️ US 는 KR 과 완전 별개 게이트 — KR 승인으로 US 가 자동 활성화되지 않는다. 수동/기존 보유 절대 자동 SELL 금지.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached, resolveUSQuote } from './ls-client';
import { makeScrubber } from './mask';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
  getLSUSPrice, getLSUSHoldings, getLSUSDeposit, usCashOnlyUsdCap,
  placeLSUSBuyOrder, placeLSUSSellOrder, queryLSUSOrderExec, cancelLSUSOrder,
  LS_US_ORDEREXEC_EMPTY_CODES, LS_US_SELL_TR_CONFIRMED,
} from '../src/lib/ls-api';
import { usCrossWonVerified } from './live-config';
import { YEOKMAE_STRATEGY_VALIDATED } from '../src/lib/yeokmae';
import { YeokmaePositionStore } from './yeokmae-position-store';
import { OrderStore } from './order-store';
import { programInvestedUSD } from './us-position';
import { executeBuyOrder, type TraderDeps } from './trader';
import { executeSellOrder } from './us-seller';
import { fetchUSDaily } from './yeokmae/us-daily';
import { DailyCache, YEOKMAE_DAILY_ROOT } from './yeokmae-daily-cache';
import { scanCachedDiscovery, confirmedCandles, loadNameMap } from './yeokmae/discovery-scan';
import {
  usRealOrderEnabled, resolveUSExitPolicy, selectUSBuyCandidates, computeUSYeokmaeCapitalGuard,
  evaluateUSExit, reconcileUSLedgerVsHoldings, US_BUY_PATH_READY, US_SELL_PATH_READY,
} from './yeokmae/us-live-core';
import { runYeokmaeUSSell, type USSellIO } from './yeokmae-us-sell-run';
import { TradeJournal, computeDailyReport, formatDailyReport } from './yeokmae-trade-journal';
import { buildYeokmaeSnapshot } from '../src/lib/yeokmae';
import { join } from 'node:path';

// US.reverse-candidates.json → symbol→{exchcd,exchange} (주문 라우팅용 실 exchcd). 네트워크 0.
function loadUSExchcdMap(): Map<string, { exchcd: string; exchange: string }> {
  const m = new Map<string, { exchcd: string; exchange: string }>();
  const f = join(YEOKMAE_DAILY_ROOT, 'US.reverse-candidates.json');
  if (!existsSync(f)) return m;
  try { const j = JSON.parse(readFileSync(f, 'utf8')); for (const c of (j.candidates ?? [])) if (c.symbol && c.exchcd) m.set(c.symbol, { exchcd: String(c.exchcd), exchange: c.exchange ?? 'US' }); } catch { /* noop */ }
  return m;
}
// US YEOKMAE pending BUY 총액(USD) — us-orders-YEOKMAE_US_*.json side='buy' pending 합. KR/BB 와 격리(교차오염 방지).
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
  const dryRunFlag = process.argv.slice(2).includes('--dry-run');
  const liveTrading = env.LS_LIVE_TRADING === 'true';
  const yeokmaeLive = env.YEOKMAE_LIVE_TRADING === 'true';
  const usLive = env.YEOKMAE_US_LIVE_TRADING === 'true';
  const legacyBbBlocked = env.LEGACY_BB_LIVE_ENABLED !== 'true';
  const totalCapitalKRW = Number(env.LS_US_TOTAL_CAPITAL_KRW || 1_000_000) || 1_000_000;
  const perTradeKRW = Number(env.US_PER_TRADE_KRW || 100_000) || 100_000;
  const exit = resolveUSExitPolicy(env);
  const delaygb = resolveUSQuote().delaygb ?? 'R';
  const crossWon = usCrossWonVerified();

  log.info('===== [YEOKMAE-US-LIVE] US 역매공파 실전 자동매매 =====');
  log.info(`[YEOKMAE-US-VALIDATION] YEOKMAE_STRATEGY_VALIDATED=${YEOKMAE_STRATEGY_VALIDATED}(레거시 하드블록, US경로 미사용) · LS_LIVE_TRADING=${liveTrading} YEOKMAE_LIVE_TRADING=${yeokmaeLive} YEOKMAE_US_LIVE_TRADING=${usLive} legacyBbBlocked=${legacyBbBlocked} crossWonVerified=${crossWon}`);
  log.info(`[YEOKMAE-US-CAPITAL] totalCapitalKRW=${totalCapitalKRW}(KR 과 별개) perTradeKRW=${perTradeKRW} → 실 baseXchRate 로 USD 환산(고정환율 금지). 신용/미수 금지(cash-only).`);
  log.info(`[YEOKMAE-US-BUY-SOURCE] source=YEOKMAE(112_UPGRADE OR 224_UPGRADE only, CONFIRMED 일봉만) · ORIGINAL/LONG_TERM=관찰만 · BB(20,2)+RSI BUY=완전 비활성(legacyBbBlocked=${legacyBbBlocked})`);
  log.info(`[YEOKMAE-US-EXIT-POLICY] stopLoss=${exit.stopLossPct ?? '미결정'} takeProfit=${exit.takeProfitPct ?? '미결정'} maxHoldDays=${exit.maxHoldDays ?? '미결정'} emergencyStop=-${exit.emergencyStopPct}%(항상활성) confirmed=${exit.confirmed} · ⚠️ 운영 risk policy(원본 역매공파 SELL 아님)`);
  if (exit.pendingDecisions.length) log.warn(`[YEOKMAE-US-EXIT-PENDING] 사용자 결정 필요: [${exit.pendingDecisions.join(' · ')}]`);

  let cfg; try { cfg = loadConfig(); } catch (e) { log.error(`[YEOKMAE-US-LIVE] FAIL_CLOSED(config: ${String(e)})`); process.exit(2); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); } catch (e) { log.error(`[YEOKMAE-US-LIVE] FAIL_CLOSED(token: ${scrub(String(e))})`); process.exit(2); return; }

  // 실 예수금/환율/현금(cash-only, CROSS-WON) — baseXchRate 는 실 기준환율(고정 금지).
  let baseXchRate = 0, cashOnlyUsd = 0, usdOrderable = 0;
  try {
    const dep = await getLSUSDeposit(cfg, token);
    baseXchRate = dep.baseXchRate; usdOrderable = dep.usdOrderable; cashOnlyUsd = usCashOnlyUsdCap(dep, { crossWonVerified: crossWon });
    log.info(`[YEOKMAE-US-ACCOUNT] rsp_cd=${dep.rspCd} baseXchRate=${baseXchRate} usdOrderable=${usdOrderable.toFixed(2)} cashOnlyUsd(cap)=${cashOnlyUsd.toFixed(2)} krwCash=${Math.round(dep.krwCash)}`);
  } catch (e) { log.warn(`[YEOKMAE-US-ACCOUNT] 예수금 조회 실패 → 환율/현금 0(자본가드 fail-closed). ${scrub(String(e))}`); }

  // ── item1: g3204 일봉 실 rows>0 확인(런타임 probe) + 캐시 ready(600+봉) 종목수 → US_DAILY_HISTORY_READY. ──
  const exchOf = loadUSExchcdMap();
  const { cached, results, corrupt } = scanCachedDiscovery('US');
  const nameOf = loadNameMap('US');
  const readyCount = results.filter(d => d.ready).length;
  let probeOk = false; let probeRows = 0; let probeSym = '-';
  const probePick = exchOf.get('AAPL') ? 'AAPL' : (exchOf.size ? [...exchOf.keys()][0] : '');
  if (probePick) {
    const ex = exchOf.get(probePick)!;
    try {
      const r = await fetchUSDaily(token, { symbol: probePick, exchcd: ex.exchcd, delaygb }, { nowMs: Date.now(), targetBars: 1, windowDays: 40, maxPages: 1 });
      probeOk = r.ok && r.bars.length > 0; probeRows = r.bars.length; probeSym = probePick;
    } catch (e) { log.warn(`[YEOKMAE-US-DAILY-PROBE] ${probePick} g3204 예외 → probe 실패. ${scrub(String(e))}`); }
  }
  const historyReady = probeOk && readyCount > 0;
  log.info(`[YEOKMAE-US-DAILY-PROBE] probeSymbol=${probeSym} exchcd=${probePick ? exchOf.get(probePick)?.exchcd : '-'} g3204 rows=${probeRows} probeOk=${probeOk} (gubun='2' 일봉)`);
  log.info(`[YEOKMAE-US-HISTORY-CAPACITY] cachedSymbols=${cached} ready(600+봉)=${readyCount} corrupt=${corrupt} historyReady=${historyReady}${!historyReady ? ' → INSUFFICIENT_HISTORY(실주문 게이트 닫힘). npm run yeokmae:build-us-history 로 pool 구축.' : ''}`);

  // ── item9: US 실주문 최종 게이트(KR 과 완전 별개). ──
  const usRealOrder = usRealOrderEnabled({ liveTrading, yeokmaeLive, usLive, exitConfirmed: exit.confirmed, historyReady });
  log.info(`[YEOKMAE-US-REAL-ORDER-GATE] US_YEOKMAE_REAL_ORDER_ENABLED=${usRealOrder.enabled} buyPathReady=${usRealOrder.buyPathReady} sellPathReady=${usRealOrder.sellPathReady} historyReady=${usRealOrder.historyReady} reasons=[${usRealOrder.reasons.join(',') || '없음(전부충족)'}] dryRun=${dryRunFlag}`);

  // 보유(US YEOKMAE 원장) + pending(USD)
  const posStore = new YeokmaePositionStore(); posStore.load();
  const usPositions = posStore.corrupt ? [] : posStore.all().filter(p => p.exchcd !== 'KR' && p.qty > 0);   // exchcd='81'/'82'(US). KR 원장 제외.
  const heldSymbols = new Set(usPositions.map(p => p.symbol));
  const investedUSD = programInvestedUSD(usPositions.map(p => ({ qty: p.qty, avgPrice: p.entryAvgPrice })));
  const pend = scanUSYeokmaePendingBuy();
  log.info(`[YEOKMAE-US-HOLDINGS] US 원장보유=${usPositions.length}종목 investedUSD=${investedUSD.toFixed(2)} pendingBuyUSD=${pend.totalUSD.toFixed(2)}`);

  // ── item6/사용자요구: 실주문 전 COSOQ00201 holdings read-only 진단 + 원장 reconcile + 수동보유 보호. ──
  //   rsp_cd 정상(ok)이어야 usHoldingsOk=true. 실패 → 임의 성공처리 금지 → BUY·SELL 모두 fail-closed.
  //   ⚠️ holdings 는 계좌 전체(수동/기존 포함). 프로그램 원장(heldSymbols)에 없는 종목 = 수동보유 → 절대 자동 SELL 금지.
  const holdingBySym = new Map<string, { balQty: number; sellableQty: number }>();
  const brokerSymbols = new Set<string>();
  let usHoldingsOk = false;
  try {
    const h = await getLSUSHoldings(cfg, token);
    usHoldingsOk = h.ok;
    log.info(`[YEOKMAE-US-HOLDINGS-DIAG] rsp_cd=${h.rspCd || '-'} rsp_msg=${h.rspMsg || '-'} rows=${h.rawRows} broker보유=${h.holdings.length}종목 (정상 → ${usHoldingsOk ? '정상' : 'fail-closed(BUY·SELL 차단)'})`);
    for (const x of h.holdings) { holdingBySym.set(x.symbol, { balQty: x.balQty, sellableQty: x.sellableQty }); brokerSymbols.add(x.symbol); }
    if (!usHoldingsOk) log.warn(`[YEOKMAE-US-HOLDINGS-DIAG] holdings 조회 성공코드 미확인 → 임의 성공처리 금지 · BUY/SELL fail-closed.`);
    for (const r of reconcileUSLedgerVsHoldings(usPositions.map(p => ({ symbol: p.symbol, qty: p.qty })), h.holdings)) {
      const msg = `[YEOKMAE-US-RECONCILE] ${r.symbol} ledgerQty=${r.ledgerQty} brokerQty=${r.brokerQty} sellable=${r.brokerSellable} status=${r.status}`;
      if (r.status === 'MATCH') log.info(msg); else log.warn(msg + ' — 자동삭제 금지, 보수적 처리(SELL 은 min(원장,매도가능)).');
    }
    for (const x of h.holdings) {
      if (!heldSymbols.has(x.symbol)) log.warn(`[YEOKMAE-US-MANUAL-HOLDING] symbol=${x.symbol} balQty=${x.balQty} sellable=${x.sellableQty} → 프로그램 원장 외(수동/기존 보유). 자동 SELL 절대 금지 · BUY 후보 제외(commingling 방지).`);
    }
  } catch (e) { usHoldingsOk = false; log.error(`[YEOKMAE-US-HOLDINGS-DIAG] COSOQ00201 조회 예외 → BUY/SELL fail-closed. ${scrub(String(e))}`); }

  // ── 최종 실주문 스위치: 게이트 ∧ holdings 정상 ∧ !dryRun. ──
  const postEnabled = usRealOrder.enabled && usHoldingsOk && !dryRunFlag;
  log.info(`[YEOKMAE-US-LIVE-CFG] realOrderEnabled=${postEnabled} totalCapital=${totalCapitalKRW} perTrade=${perTradeKRW}`
    + ` stopLoss=${exit.stopLossPct == null ? '미설정' : '-' + exit.stopLossPct} takeProfit=${exit.takeProfitPct == null ? '미설정' : '+' + exit.takeProfitPct}`
    + ` maxHold=${exit.maxHoldDays ?? '미설정'} emergency=-${exit.emergencyStopPct} baseXchRate=${baseXchRate} perTradeUSD=${baseXchRate > 0 ? (perTradeKRW / baseXchRate).toFixed(2) : 'n/a'}`
    + ` (gate=${usRealOrder.enabled} holdingsOk=${usHoldingsOk} historyReady=${historyReady} dryRun=${dryRunFlag})`);

  // 후보(UPGRADE-only) — 원장보유 ∪ 계좌보유(수동 commingling 방지) ∪ pending 제외. exchcd 조인 + 랭킹.
  const buyExclude = new Set<string>([...heldSymbols, ...brokerSymbols]);
  const candidates = selectUSBuyCandidates(results, exchOf, { heldSymbols: buyExclude, pendingSymbols: pend.symbols });
  log.info(`[YEOKMAE-US-CANDIDATE] cached=${cached} UPGRADE후보=${candidates.length} (BOTH_UPGRADE=${candidates.filter(c => c.tier === 'BOTH_UPGRADE').length}) 제외=원장${heldSymbols.size}+계좌${brokerSymbols.size}+pending${pend.symbols.size}`);
  candidates.slice(0, 10).forEach((c, i) => log.info(`[YEOKMAE-US-RANK] #${i + 1} symbol=${c.symbol} name=${nameOf.get(c.symbol) ?? '?'} exch=${c.exchange}(${c.exchcd}) tier=${c.tier} signalType=[${c.signalTypes.join(',')}] signalDate=${c.signalDate}`));

  const journal = new TradeJournal('US'); journal.load();
  const today = new Date().toISOString().slice(0, 10);
  const etDate = today.replace(/-/g, '');

  // ── BUY: 후보별 자본가드(KRW→USD 실환율) → postEnabled 면 executeBuyOrder(안전경로) 실 POST, 아니면 PLAN(주문 0). ──
  const traderDeps: TraderDeps = {
    place: (pp) => placeLSUSBuyOrder(cfg, token, pp),
    query: (pp) => queryLSUSOrderExec(cfg, token, pp, { emptyCodes: LS_US_ORDEREXEC_EMPTY_CODES }),
    cancel: (pp) => cancelLSUSOrder(cfg, token, pp),
    cashOrderable: async () => { try { const d = await getLSUSDeposit(cfg, token); return { ok: d.ok, cash: usCashOnlyUsdCap(d, { crossWonVerified: crossWon }), rspCd: d.rspCd, rspMsg: scrub(d.rspMsg), httpStatus: d.diag?.status ?? null }; } catch { return { ok: false, cash: 0 }; } },
    now: () => Date.now(), log: (m) => log.info(m),
  };
  let runningInvestedUSD = investedUSD, runningPendingUSD = pend.totalUSD;
  const maxReport = Math.max(3, Math.floor(totalCapitalKRW / perTradeKRW) + 3);
  let planned = 0, executedBuys = 0;
  for (const c of candidates.slice(0, maxReport)) {
    let price = 0;
    try { price = (await getLSUSPrice(cfg, token, c.symbol, c.exchcd, delaygb)).price; } catch (e) { log.warn(`[YEOKMAE-US-CAPITAL-GUARD] ${c.symbol} 시세 실패 → skip. ${scrub(String(e))}`); continue; }
    const guard = computeUSYeokmaeCapitalGuard({ totalCapitalKRW, perTradeKRW, investedUSD: runningInvestedUSD, pendingUSD: runningPendingUSD, bestAsk: price, baseXchRate, cashOnlyUsd });
    log.info(`[YEOKMAE-US-CAPITAL-GUARD] symbol=${c.symbol} name=${nameOf.get(c.symbol) ?? '?'} tier=${c.tier} price=$${price} finalQty=${guard.finalQty} investUSD=${guard.candidateUSD.toFixed(2)}(≈${Math.round(guard.candidateKRW)}KRW) canNewBuy=${guard.canNewBuy} reason=${guard.reason} (perTradeQty=${guard.perTradeQty} cashQty=${guard.cashQty} capacityQty=${guard.capacityQty})`);
    if (!guard.canNewBuy) continue;
    if (!postEnabled) { runningInvestedUSD += guard.candidateUSD; planned++; continue; }   // PLAN 누적(실제 주문 아님)
    // 실 BUY — 종목별 OrderStore(YEOKMAE_US_<sym>) + candle idempotency(당일 재진입 차단, dailyMaxBuys=1). candle=confirmed 신호일.
    const orders = new OrderStore(`YEOKMAE_US_${c.symbol}`); orders.load();
    const out = await executeBuyOrder(traderDeps, { orders, exchcd: c.exchcd, symbol: c.symbol, candleDatetime: c.signalDate ?? etDate, qty: guard.finalQty, price, etDate, dailyMaxBuys: 1, reqTag: 'YEOKMAE-US-BUY' });
    log.info(`[YEOKMAE-US-BUY] symbol=${c.symbol} name=${nameOf.get(c.symbol) ?? '?'} status=${out.status} ordNo=${out.ordNo ?? '-'} qty=${guard.finalQty} price=$${price} reason=${out.reason}${out.abortCode ? ` abortCode=${out.abortCode}` : ''}`);
    const filledQty = out.status === 'placed-filled' ? guard.finalQty : 0;   // US 는 체결가 필드 없음 → 전량체결 시 지정가로 근사(pilot 과 동일).
    if (filledQty > 0) {
      posStore.applyYeokmaeBuyFill({ symbol: c.symbol, exchcd: c.exchcd, entryDate: today, fillQty: filledQty, fillPrice: price, confirmedSignalDate: c.signalDate, matchedSignals: c.signalTypes });
      posStore.flush();
      journal.append({ ts: new Date().toISOString(), market: 'US', side: 'BUY', symbol: c.symbol, name: nameOf.get(c.symbol) ?? '?', signalType: c.signalTypes, signalDate: c.signalDate, orderPrice: price, fillPrice: price, qty: filledQty, investedKRW: baseXchRate > 0 ? Math.round(filledQty * price * baseXchRate) : null, exitReason: null, realizedPnL: null, ordNo: out.ordNo, status: out.status });
      journal.flush();
      runningInvestedUSD += filledQty * price; executedBuys++;
    }
  }
  log.info(`[YEOKMAE-US-BUY-SUMMARY] postEnabled=${postEnabled} 계획BUY=${planned} 실행BUY=${executedBuys}`);

  // SELL 게이트 — 동일 최종게이트(postEnabled). holdings 실패 시 자동 fail-closed.
  const sellLive = postEnabled;
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
  for (const pos of usPositions) {
    let price = 0;
    try { price = (await getLSUSPrice(cfg, token, pos.symbol, pos.exchcd, delaygb)).price; } catch (e) { log.warn(`[YEOKMAE-US-POSITION] ${pos.symbol} 시세 실패 → 청산판정 보류. ${scrub(String(e))}`); continue; }
    const holdDays = pos.holdDays ?? 0;
    const decision = evaluateUSExit({ entryAvgPrice: pos.entryAvgPrice, currentPrice: price, holdDays, policy: exit });
    const bh = holdingBySym.get(pos.symbol);
    log.info(`[YEOKMAE-US-POSITION] symbol=${pos.symbol} name=${nameOf.get(pos.symbol) ?? '?'} qty=${pos.qty} entryAvg=${pos.entryAvgPrice.toFixed(2)} price=${price} pnl=${decision.pnlPct == null ? 'n/a' : decision.pnlPct.toFixed(2) + '%'} holdDays=${holdDays} brokerSellable=${bh?.sellableQty ?? 'n/a'} exit=${decision.action}${decision.reason ? `(${decision.reason})` : ''} ${decision.note}`);
    if (decision.action !== 'SELL') continue;
    const orders = new OrderStore(`YEOKMAE_US_${pos.symbol}`); orders.load();
    await runYeokmaeUSSell(sellIO, {
      posStore, orders, position: pos, exchcd: pos.exchcd, journal, name: nameOf.get(pos.symbol) ?? '?',
      exitAction: decision.action, exitReason: decision.reason, pnlPct: decision.pnlPct,
      currentPrice: price, etDate, sellLive, exitConfirmed: exit.confirmed, dryRun: !sellLive,
      log: (m) => log.info(m),
    });
  }

  // 매매일지 + 일일리포트(오늘)
  const holdings = usPositions.map(p => {
    const cache = new DailyCache('US', p.symbol); cache.load();
    const snap = cache.corrupt ? null : buildYeokmaeSnapshot(p.symbol, confirmedCandles(cache));
    return { symbol: p.symbol, qty: p.qty, entryAvgPrice: p.entryAvgPrice, lastPrice: snap?.ohlcv.close ?? null };
  });
  const report = computeDailyReport({ market: 'US', date: today, signals: candidates.length, entries: journal.entries(), holdings });
  log.info(formatDailyReport(report, 'YEOKMAE-US-DAILY-REPORT'));

  log.info('──── [YEOKMAE-US-LIVE-END] ────');
  log.info(`  실행결과: postEnabled=${postEnabled} 실행BUY=${executedBuys} · BUY=112/224_UPGRADE(CONFIRMED-only, ORIGINAL 자동대체 없음, BB/RSI OFF) · cash-only.`);
  log.info(`  청산: EMERGENCY(-${exit.emergencyStopPct}%) > STOP_LOSS(${exit.stopLossPct == null ? '미설정' : '-' + exit.stopLossPct + '%'}) > TAKE_PROFIT(${exit.takeProfitPct == null ? '미설정' : '+' + exit.takeProfitPct + '%'}) > MAX_HOLD(${exit.maxHoldDays ?? '미설정'}거래일). 대상=프로그램 원장뿐(수동/기존 보유 절대 자동 SELL 금지).`);
  if (!postEnabled) {
    log.info(`  ⚠️ 실주문 비활성 사유: gate=${usRealOrder.enabled}${usRealOrder.reasons.length ? `[${usRealOrder.reasons.join(',')}]` : ''} holdingsOk=${usHoldingsOk} historyReady=${historyReady} dryRun=${dryRunFlag}. 필요조건: LS_LIVE_TRADING=true ∧ YEOKMAE_LIVE_TRADING=true ∧ YEOKMAE_US_LIVE_TRADING=true ∧ YEOKMAE_US_EXIT_CONFIRMED=true ∧ g3204 historyReady ∧ COSOQ00201 정상 ∧ --dry-run 미지정.`);
  }
  log.info(`[YEOKMAE-SAFETY] US_YEOKMAE_REAL_ORDER_ENABLED=${usRealOrder.enabled} holdingsOk=${usHoldingsOk} postEnabled=${postEnabled} · KR 과 별개 게이트(KR 승인으로 US 자동활성 금지) · REAL_ORDER_FROM_YEOKMAE(표시라벨, 게이트 아님)=${env.REAL_ORDER_FROM_YEOKMAE === 'true'}`);
}
main();
