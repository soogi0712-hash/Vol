// 역매공파 KR 실전 자동매매 (P0-33B) — 실행: npm run yeokmae:kr-live -- [--dry-run]
//   실 BUY/SELL POST 는 단일 최종게이트 postEnabled = krRealOrderEnabled(LS_LIVE ∧ YEOKMAE_LIVE ∧ YEOKMAE_KR_LIVE ∧ YEOKMAE_KR_EXIT_CONFIRMED)
//     ∧ t0424 rsp_cd=00000(진단) ∧ --dry-run 미지정 일 때만. 하나라도 불충족 → fail-closed(주문 0).
//   BUY(UPGRADE-only, CONFIRMED-only) + 자본가드(총100만/종목10만, cash-only) + 위험청산(원장 대상만) + 수동보유 보호 + 매매일지.
//   ⚠️ 수동/기존 보유(t0424 O, 원장 X)는 절대 자동 SELL 금지 · BUY 후보 제외(commingling 방지). US 미개방(KR 전용).
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached } from './ls-client';
import { makeScrubber } from './mask';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { getLSKRPrice, getLSKRBalance, getLSKRHoldings, placeLSKRBuyOrder, placeLSKRSellOrder, cancelLSKRBuyOrder, queryLSKROrderExecUnified, resolveKRMbrNo, LS_KR_SELL_TR_CONFIRMED } from '../src/lib/ls-api';
import { YEOKMAE_STRATEGY_VALIDATED, YEOKMAE_SEMANTICS_VERIFIED } from '../src/lib/yeokmae';
import { YeokmaePositionStore } from './yeokmae-position-store';
import { OrderStore } from './order-store';
import { executeKRBuyOrder, type KRTraderDeps } from './kr-trader';
import { DailyCache, YEOKMAE_DAILY_ROOT } from './yeokmae-daily-cache';
import { scanCachedDiscovery, confirmedCandles, loadNameMap } from './yeokmae/discovery-scan';
import { selectKRBuyCandidates, computeKRCapitalGuard, resolveKRExitPolicy, evaluateKRExit, reconcileKRLedgerVsHoldings, krRealOrderEnabled, KR_A_REALTIME_HALT_CONNECTED } from './yeokmae/kr-live-core';
import { executeKRSellOrder } from './kr-seller';
import { runYeokmaeKRSell, type KRSellIO } from './yeokmae-kr-sell-run';
import { TradeJournal, computeDailyReport, formatDailyReport } from './yeokmae-trade-journal';
import { buildYeokmaeSnapshot } from '../src/lib/yeokmae';
import { join } from 'node:path';

// KR pending BUY 총액(원) — us-orders-YEOKMAE_KR_*.json 의 side='buy' pending 합(KRW). 재시작 무관.
function scanKRPendingBuy(dir = join(YEOKMAE_DAILY_ROOT, '..')): { totalKRW: number; symbols: Set<string> } {
  const symbols = new Set<string>(); let totalKRW = 0;
  if (!existsSync(dir)) return { totalKRW, symbols };
  for (const f of readdirSync(dir)) {
    const m = /^us-orders-(YEOKMAE_KR_.+)\.json$/.exec(f);
    if (!m) continue;
    try {
      const body = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      for (const po of (body.pending ?? [])) if (po && po.side === 'buy') { totalKRW += (Number(po.qty) || 0) * (Number(po.price) || 0); const s = m[1].replace('YEOKMAE_KR_', ''); symbols.add(s); }
    } catch { /* skip */ }
  }
  return { totalKRW, symbols };
}

async function main() {
  loadEnvLocal();
  const log = createLogger('yeokmae-kr-live');
  const env = process.env;
  const liveTrading = env.LS_LIVE_TRADING === 'true';
  const yeokmaeLive = env.YEOKMAE_LIVE_TRADING === 'true';
  const krLive = env.YEOKMAE_KR_LIVE_TRADING === 'true';
  const legacyBbBlocked = env.LEGACY_BB_LIVE_ENABLED !== 'true';
  const totalCapitalKRW = Number(env.YEOKMAE_KR_TOTAL_CAPITAL_KRW || 1_000_000) || 1_000_000;
  const perTradeKRW = Number(env.YEOKMAE_KR_PER_TRADE_KRW || 100_000) || 100_000;
  const exit = resolveKRExitPolicy(env);
  const dryRunFlag = process.argv.slice(2).includes('--dry-run');
  // ── P0-33B: KR 실주문 최종 게이트(단일 함수·단일 로그). KR 전용 명시 승인 — YEOKMAE_STRATEGY_VALIDATED 요구 안 함(US 미개방). ──
  const krRealOrder = krRealOrderEnabled({ liveTrading, yeokmaeLive, krLive, exitConfirmed: exit.confirmed });

  log.info('===== [YEOKMAE-KR-LIVE] KR 역매공파 실전 자동매매 =====');
  log.info(`[YEOKMAE-KR-VALIDATION] YEOKMAE_STRATEGY_VALIDATED=${YEOKMAE_STRATEGY_VALIDATED}(레거시 하드블록, KR경로 미사용) YEOKMAE_SEMANTICS_VERIFIED=${YEOKMAE_SEMANTICS_VERIFIED} · LS_LIVE_TRADING=${liveTrading} YEOKMAE_LIVE_TRADING=${yeokmaeLive} YEOKMAE_KR_LIVE_TRADING=${krLive} legacyBbBlocked=${legacyBbBlocked}`);
  log.info(`[YEOKMAE-KR-REAL-ORDER-GATE] KR_REAL_ORDER_ENABLED=${krRealOrder.enabled} buyPathReady=${krRealOrder.buyPathReady} sellPathReady=${krRealOrder.sellPathReady} reasons=[${krRealOrder.reasons.join(',') || '없음(전부충족)'}] dryRun=${dryRunFlag}`);
  log.info(`[YEOKMAE-KR-CAPITAL] totalCapitalKRW=${totalCapitalKRW} perTradeKRW=${perTradeKRW} → 최대 약 ${Math.floor(totalCapitalKRW / perTradeKRW)}종목 분산. 신용/미수 금지(cash-only).`);
  log.info(`[YEOKMAE-KR-BUY-SOURCE] source=YEOKMAE(112_UPGRADE OR 224_UPGRADE only, CONFIRMED-only) · ORIGINAL/LONG_TERM=관찰만 · BB/RSI BUY=완전 비활성(legacyBbBlocked=${legacyBbBlocked})`);
  log.info(`[YEOKMAE-KR-EXIT-POLICY] stopLoss=${exit.stopLossPct ?? '미결정'} takeProfit=${exit.takeProfitPct ?? '미결정'} maxHoldDays=${exit.maxHoldDays ?? '미결정'} emergencyStop=-${exit.emergencyStopPct}%(항상활성) confirmed=${exit.confirmed}`);
  if (exit.pendingDecisions.length) log.warn(`[YEOKMAE-KR-EXIT-PENDING] 사용자 결정 필요: [${exit.pendingDecisions.join(' · ')}] — 확정 전 실 SELL READY 아님(BUY만 쌓기 금지).`);
  log.info(`[YEOKMAE-KR-ABC-T] A(제외종목)=부분연결(t8436 전일종가>0만; 관리/거래정지 실시간=${KR_A_REALTIME_HALT_CONNECTED ? '연결' : '미연결(t8436 미제공)'}) B(보통주)/C(ETF·SPAC)=t8436 실필드 연결 · T=close×volume(원) proxy(단위 원 일치, raw value 필드 미사용)`);
  log.info(`[YEOKMAE-KR-SELL-ENGINE] executeKRSellOrder(CSPAT00601 BnsTpCode=1 매도 공식확인=${LS_KR_SELL_TR_CONFIRMED}, 지정가) + 종목별잔고 t0424(mdposqt 매도가능수량) 연결. 위험청산=EMERGENCY(-${exit.emergencyStopPct}%)/STOP_LOSS/TAKE_PROFIT/MAX_HOLD.`);

  let cfg; try { cfg = loadConfig(); } catch (e) { log.error(`[YEOKMAE-KR-LIVE] FAIL_CLOSED(config: ${String(e)})`); process.exit(2); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); } catch (e) { log.error(`[YEOKMAE-KR-LIVE] FAIL_CLOSED(token: ${scrub(String(e))})`); process.exit(2); return; }

  // 실 계좌 현금/평가
  let orderableCash = 0, balEval = 0;
  try { const bal = await getLSKRBalance(cfg, token); orderableCash = bal.orderableCash; balEval = bal.balEval; log.info(`[YEOKMAE-KR-ACCOUNT] orderableCash=${Math.round(orderableCash)} balEval=${Math.round(balEval)} rsp_cd=${bal.rspCd}`); }
  catch (e) { log.warn(`[YEOKMAE-KR-ACCOUNT] 잔고 조회 실패 → 자본가드 현금항목 0 처리. ${scrub(String(e))}`); }

  // 보유(KR YEOKMAE 원장) + pending
  const posStore = new YeokmaePositionStore(); posStore.load();
  const krPositions = posStore.corrupt ? [] : posStore.all().filter(p => p.exchcd === 'KR' && p.qty > 0);
  const heldSymbols = new Set(krPositions.map(p => p.symbol));   // 프로그램 원장 보유(=SELL 대상 후보)
  const investedKRW = krPositions.reduce((s, p) => s + p.qty * p.entryAvgPrice, 0);
  const pend = scanKRPendingBuy();
  log.info(`[YEOKMAE-KR-HOLDINGS] KR 원장보유=${krPositions.length}종목 investedKRW=${Math.round(investedKRW)} pendingBuyKRW=${Math.round(pend.totalKRW)} (총사용=${Math.round(investedKRW + pend.totalKRW)}/${totalCapitalKRW})`);

  // ── item2/사용자요구: 실주문 전 t0424 read-only 1회 진단 + 원장 reconcile + 수동보유 보호. ──
  //   rsp_cd=00000 이어야 t0424ok=true. 다른 코드/예외 → 임의 성공처리 금지 → BUY·SELL 모두 fail-closed.
  //   ⚠️ t0424 는 계좌 전체(수동/기존 포함)를 반환. 프로그램 원장(heldSymbols)에 없는 종목 = 수동보유 → 절대 자동 SELL 금지.
  const holdingBySym = new Map<string, { balQty: number; sellableQty: number; avgPrice: number; currentPrice: number }>();
  const brokerSymbols = new Set<string>();      // t0424 상 실제 계좌 보유(수동+프로그램) → BUY 후보 제외(commingling 방지)
  let t0424ok = false;
  try {
    const h = await getLSKRHoldings(cfg, token);
    t0424ok = h.ok;
    log.info(`[YEOKMAE-KR-HOLDINGS-DIAG] rsp_cd=${h.rspCd || '-'} rsp_msg=${h.rspMsg || '-'} rows=${h.rawRows} (성공코드 00000 → ${t0424ok ? '정상' : 'fail-closed(BUY·SELL 차단)'})`);
    for (const x of h.holdings) { holdingBySym.set(x.symbol, { balQty: x.balQty, sellableQty: x.sellableQty, avgPrice: x.avgPrice, currentPrice: x.currentPrice }); brokerSymbols.add(x.symbol); }
    if (!t0424ok) log.warn(`[YEOKMAE-KR-HOLDINGS-DIAG] rsp_cd≠00000 → 임의 성공처리 금지 · BUY/SELL fail-closed. 실 rsp_cd 확인 후 LS_KR_HOLDINGS_SUCCESS_CODES 등록 필요(추측 금지).`);
    for (const r of reconcileKRLedgerVsHoldings(krPositions, h.holdings)) {
      const msg = `[YEOKMAE-KR-RECONCILE] ${r.symbol} ledgerQty=${r.ledgerQty} brokerQty=${r.brokerQty} sellable=${r.brokerSellable} status=${r.status}`;
      if (r.status === 'MATCH') log.info(msg); else log.warn(msg + ' — 자동삭제 금지, 보수적 처리(SELL 은 min(원장,매도가능)).');
    }
    // 수동/기존 보유 보호 — broker 보유 중 프로그램 원장에 없는 종목은 자동 SELL 금지 대상으로 명시.
    for (const x of h.holdings) {
      if (!heldSymbols.has(x.symbol)) log.warn(`[YEOKMAE-KR-MANUAL-HOLDING] symbol=${x.symbol} balQty=${x.balQty} sellable=${x.sellableQty} avgPrice=${x.avgPrice} → 프로그램 원장 외(수동/기존 보유). 자동 SELL 절대 금지 · BUY 후보 제외(commingling 방지).`);
    }
  } catch (e) { t0424ok = false; log.error(`[YEOKMAE-KR-HOLDINGS-DIAG] t0424 조회 예외 → BUY/SELL fail-closed. ${scrub(String(e))}`); }

  // ── 최종 실주문 스위치: 게이트 ∧ t0424 정상 ∧ !dryRun. 이 아래 모든 실 POST 는 postEnabled 로만. ──
  const postEnabled = krRealOrder.enabled && t0424ok && !dryRunFlag;
  log.info(`[YEOKMAE-KR-LIVE-CFG] realOrderEnabled=${postEnabled} totalCapital=${totalCapitalKRW} perTrade=${perTradeKRW}`
    + ` stopLoss=${exit.stopLossPct == null ? '미설정' : '-' + exit.stopLossPct} takeProfit=${exit.takeProfitPct == null ? '미설정' : '+' + exit.takeProfitPct}`
    + ` maxHold=${exit.maxHoldDays ?? '미설정'} emergency=-${exit.emergencyStopPct}`
    + ` (gate=${krRealOrder.enabled} t0424ok=${t0424ok} dryRun=${dryRunFlag})`);

  // 캐시 신호 → UPGRADE-only 후보(원장보유/pending/계좌보유 제외 — 수동보유 commingling 방지)
  const { cached, results, corrupt } = scanCachedDiscovery('KR');
  const nameOf = loadNameMap('KR');
  if (cached === 0) { log.warn('[YEOKMAE-KR-LIVE] KR 캐시 없음 — 먼저 npm run yeokmae:build-kr-history 로 pool 구축.'); }
  const buyExclude = new Set<string>([...heldSymbols, ...brokerSymbols]);   // 프로그램 원장 + 실계좌 보유(수동 포함) 모두 재진입 금지
  const candidates = selectKRBuyCandidates(results, { heldSymbols: buyExclude, pendingSymbols: pend.symbols });
  log.info(`[YEOKMAE-KR-CANDIDATES] cached=${cached} corrupt=${corrupt} UPGRADE후보=${candidates.length} (BOTH_UPGRADE=${candidates.filter(c => c.tier === 'BOTH_UPGRADE').length}) 제외=원장${heldSymbols.size}+계좌${brokerSymbols.size}+pending${pend.symbols.size}`);

  const journal = new TradeJournal('KR'); journal.load();
  const today = new Date().toISOString().slice(0, 10);
  const krDate = today.replace(/-/g, '');
  const mbr = resolveKRMbrNo(env.LS_KR_MBR_NO);

  // ── BUY: 후보별 자본가드 → postEnabled 면 executeKRBuyOrder(안전경로) 실 POST, 아니면 PLAN(주문 0). ──
  const krBuyDeps: KRTraderDeps = {
    place: (pp) => placeLSKRBuyOrder(cfg, token, pp),
    queryExec: (pp) => queryLSKROrderExecUnified(cfg, token, pp),   // preflight/PILOT 와 동일 strict classifier
    cancel: (pp) => cancelLSKRBuyOrder(cfg, token, pp),
    cashOrderable: async () => { try { const b = await getLSKRBalance(cfg, token); return { ok: true, cash: b.orderableCash }; } catch { return { ok: false, cash: 0 }; } },
    now: () => Date.now(), log: (m) => log.info(m),
  };
  let runningInvested = investedKRW, runningPending = pend.totalKRW;
  const maxReport = Math.max(3, Math.floor(totalCapitalKRW / perTradeKRW) + 3);
  let planned = 0, executedBuys = 0;
  for (const c of candidates.slice(0, maxReport)) {
    let price = 0;
    try { price = (await getLSKRPrice(cfg, token, c.symbol)).price; } catch (e) { log.warn(`[YEOKMAE-KR-PLAN] ${c.symbol} 시세 실패 → skip. ${scrub(String(e))}`); continue; }
    const guard = computeKRCapitalGuard({ totalCapitalKRW, perTradeKRW, investedKRW: runningInvested, pendingKRW: runningPending, price, orderableCash });
    log.info(`[YEOKMAE-KR-PLAN] symbol=${c.symbol} name=${nameOf.get(c.symbol) ?? '?'} tier=${c.tier} signalType=[${c.signalTypes.join(',')}] signalDate=${c.signalDate} price=${price} finalQty=${guard.finalQty} investKRW=${Math.round(guard.candidateKRW)} canNewBuy=${guard.canNewBuy} reason=${guard.reason} (budgetQty=${guard.budgetQty} capacityQty=${guard.capacityQty} cashQty=${guard.cashQty})`);
    if (!guard.canNewBuy) continue;
    if (!postEnabled) { runningInvested += guard.candidateKRW; planned++; continue; }   // PLAN 누적(실제 주문 아님)
    // 실 BUY — 종목별 OrderStore(YEOKMAE_KR_<sym>) + candle idempotency(당일 재진입 차단, dailyMaxBuys=1). candle=confirmed 신호일.
    const orders = new OrderStore(`YEOKMAE_KR_${c.symbol}`); orders.load();
    const out = await executeKRBuyOrder(krBuyDeps, { orders, shcode: c.symbol, candleDatetime: c.signalDate ?? krDate, qty: guard.finalQty, price, krDate, mbrNo: mbr.value, dailyMaxBuys: 1 });
    log.info(`[YEOKMAE-KR-BUY] symbol=${c.symbol} name=${nameOf.get(c.symbol) ?? '?'} status=${out.status} ordNo=${out.ordNo ?? '-'} execQty=${out.execQty} qty=${guard.finalQty} price=${price} reason=${out.reason}${out.abortCode ? ` abortCode=${out.abortCode}` : ''}`);
    const filledQty = (out.status === 'placed-filled' || out.status === 'placed-partial') ? out.execQty : 0;
    if (filledQty > 0) {
      // 진입 평균가 = 지정가(실 체결가 근사). 원장에 exchcd='KR' 기록 → SELL 대상은 이 원장뿐(수동보유 불포함).
      posStore.applyYeokmaeBuyFill({ symbol: c.symbol, exchcd: 'KR', entryDate: today, fillQty: filledQty, fillPrice: price, confirmedSignalDate: c.signalDate, matchedSignals: c.signalTypes });
      posStore.flush();
      journal.append({ ts: new Date().toISOString(), market: 'KR', side: 'BUY', symbol: c.symbol, name: nameOf.get(c.symbol) ?? '?', signalType: c.signalTypes, signalDate: c.signalDate, orderPrice: price, fillPrice: price, qty: filledQty, investedKRW: filledQty * price, exitReason: null, realizedPnL: null, ordNo: out.ordNo, status: out.status });
      journal.flush();
      runningInvested += filledQty * price; executedBuys++;
    }
  }
  log.info(`[YEOKMAE-KR-BUY-SUMMARY] postEnabled=${postEnabled} 계획BUY=${planned} 실행BUY=${executedBuys} · 총사용=${Math.round(runningInvested + runningPending)}/${totalCapitalKRW}KRW`);

  // SELL 실 POST 게이트 — BUY 상태와 무관(item5)하되 동일 최종 게이트(postEnabled)로 gating. t0424 실패 시 자동 fail-closed.
  const sellLive = postEnabled;

  // ── item5/7/8: 보유 KR YEOKMAE 포지션(원장) 위험청산 감시 — 수동보유는 원장에 없어 절대 대상 아님. ──
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
  for (const pos of krPositions) {
    let price = 0;
    try { price = (await getLSKRPrice(cfg, token, pos.symbol)).price; } catch (e) { log.warn(`[YEOKMAE-KR-POSITION] ${pos.symbol} 시세 실패 → 청산판정 보류. ${scrub(String(e))}`); continue; }
    const holdDays = pos.holdDays ?? 0;
    const decision = evaluateKRExit({ entryAvgPrice: pos.entryAvgPrice, currentPrice: price, holdDays, policy: exit });
    const bh = holdingBySym.get(pos.symbol);
    log.info(`[YEOKMAE-KR-POSITION] symbol=${pos.symbol} name=${nameOf.get(pos.symbol) ?? '?'} qty=${pos.qty} entryAvg=${pos.entryAvgPrice.toFixed(2)} price=${price} pnl=${decision.pnlPct == null ? 'n/a' : decision.pnlPct.toFixed(2) + '%'} holdDays=${holdDays} brokerSellable=${bh?.sellableQty ?? 'n/a'} exit=${decision.action}${decision.reason ? `(${decision.reason})` : ''} ${decision.note}`);
    if (decision.action !== 'SELL') continue;
    const orders = new OrderStore(`YEOKMAE_KR_${pos.symbol}`); orders.load();
    await runYeokmaeKRSell(sellIO, {
      posStore, orders, position: pos, journal, name: nameOf.get(pos.symbol) ?? '?',
      exitAction: decision.action, exitReason: decision.reason, pnlPct: decision.pnlPct,
      currentPrice: price, krDate, sellLive, exitConfirmed: exit.confirmed, dryRun: !sellLive, mbrNo: mbr.value,
      log: (m) => log.info(m),
    });
  }

  // 매매일지 + 일일리포트(오늘)
  const holdings = krPositions.map(p => {
    const cache = new DailyCache('KR', p.symbol); cache.load();
    const snap = cache.corrupt ? null : buildYeokmaeSnapshot(p.symbol, confirmedCandles(cache));
    const bh = holdingBySym.get(p.symbol);
    return { symbol: p.symbol, qty: p.qty, entryAvgPrice: p.entryAvgPrice, lastPrice: bh?.currentPrice ?? snap?.ohlcv.close ?? null };
  });
  const report = computeDailyReport({ market: 'KR', date: today, signals: candidates.length, entries: journal.entries(), holdings });
  log.info(formatDailyReport(report, 'YEOKMAE-KR-DAILY-REPORT'));

  log.info('──── [YEOKMAE-KR-LIVE-END] ────');
  log.info(`  실행결과: postEnabled=${postEnabled} 실행BUY=${executedBuys} · BUY=112/224_UPGRADE(CONFIRMED-only, ORIGINAL 자동대체 없음) · cash-only(신용/미수 금지).`);
  log.info(`  청산: EMERGENCY(-${exit.emergencyStopPct}%) > STOP_LOSS(${exit.stopLossPct == null ? '미설정' : '-' + exit.stopLossPct + '%'}) > TAKE_PROFIT(${exit.takeProfitPct == null ? '미설정' : '+' + exit.takeProfitPct + '%'}) > MAX_HOLD(${exit.maxHoldDays ?? '미설정'}거래일). 대상=프로그램 원장뿐(수동/기존 보유 절대 자동 SELL 금지).`);
  if (!postEnabled) {
    log.info(`  ⚠️ 실주문 비활성 사유: gate=${krRealOrder.enabled}${krRealOrder.reasons.length ? `[${krRealOrder.reasons.join(',')}]` : ''} t0424ok=${t0424ok} dryRun=${dryRunFlag}. 필요조건: LS_LIVE_TRADING=true ∧ YEOKMAE_LIVE_TRADING=true ∧ YEOKMAE_KR_LIVE_TRADING=true ∧ YEOKMAE_KR_EXIT_CONFIRMED=true ∧ t0424 rsp_cd=00000 ∧ --dry-run 미지정.`);
  }
  log.info(`[YEOKMAE-SAFETY] KR_REAL_ORDER_ENABLED=${krRealOrder.enabled} t0424ok=${t0424ok} postEnabled=${postEnabled} · US 미개방(KR 전용 경로) · REAL_ORDER_FROM_YEOKMAE(표시라벨, 게이트 아님)=${env.REAL_ORDER_FROM_YEOKMAE === 'true'}`);
}
main();
