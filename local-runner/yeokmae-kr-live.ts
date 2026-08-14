// 역매공파 KR 실전 계획/검증 리포트 (P0-33) — 실행: npm run yeokmae:kr-live -- [--plan]
//   ⚠️ 이번 빌드는 주문 0(PLAN/REPORT). 실 BUY/SELL POST 는 후속(사용자가 SELL 정책/자본 확정 + 게이트 ON 후).
//   BUY 후보(UPGRADE-only, CONFIRMED-only) + 자본가드(총100만/종목10만, cash-only) + 청산정책 + 매매일지 + 검증상태 보고.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached } from './ls-client';
import { makeScrubber } from './mask';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { getLSKRPrice, getLSKRBalance } from '../src/lib/ls-api';
import { YEOKMAE_STRATEGY_VALIDATED, YEOKMAE_SEMANTICS_VERIFIED } from '../src/lib/yeokmae';
import { YeokmaePositionStore } from './yeokmae-position-store';
import { DailyCache, YEOKMAE_DAILY_ROOT } from './yeokmae-daily-cache';
import { scanCachedDiscovery, confirmedCandles, loadNameMap } from './yeokmae/discovery-scan';
import { selectKRBuyCandidates, computeKRCapitalGuard, resolveKRExitPolicy, KR_A_REALTIME_HALT_CONNECTED } from './yeokmae/kr-live-core';
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

  log.info('===== [YEOKMAE-KR-LIVE] KR 실전 계획/검증 리포트 (⚠️ 이번 빌드 BUY/SELL POST=0) =====');
  log.info(`[YEOKMAE-KR-VALIDATION] YEOKMAE_STRATEGY_VALIDATED=${YEOKMAE_STRATEGY_VALIDATED} YEOKMAE_SEMANTICS_VERIFIED=${YEOKMAE_SEMANTICS_VERIFIED} · KR live switch(YEOKMAE_KR_LIVE_TRADING)=${krLive} · LS_LIVE_TRADING=${liveTrading} YEOKMAE_LIVE_TRADING=${yeokmaeLive} legacyBbBlocked=${legacyBbBlocked}`);
  log.info(`[YEOKMAE-KR-CAPITAL] totalCapitalKRW=${totalCapitalKRW} perTradeKRW=${perTradeKRW} → 최대 약 ${Math.floor(totalCapitalKRW / perTradeKRW)}종목 분산. 신용/미수 금지(cash-only).`);
  log.info(`[YEOKMAE-KR-BUY-SOURCE] source=YEOKMAE(112_UPGRADE OR 224_UPGRADE only, CONFIRMED-only) · ORIGINAL/LONG_TERM=관찰만 · BB/RSI BUY=완전 비활성(legacyBbBlocked=${legacyBbBlocked})`);
  log.info(`[YEOKMAE-KR-EXIT-POLICY] stopLoss=${exit.stopLossPct ?? '미결정'} takeProfit=${exit.takeProfitPct ?? '미결정'} maxHoldDays=${exit.maxHoldDays ?? '미결정'} emergencyStop=-${exit.emergencyStopPct}%(항상활성) confirmed=${exit.confirmed}`);
  if (exit.pendingDecisions.length) log.warn(`[YEOKMAE-KR-EXIT-PENDING] 사용자 결정 필요: [${exit.pendingDecisions.join(' · ')}] — 확정 전 실 SELL READY 아님(BUY만 쌓기 금지).`);
  log.info(`[YEOKMAE-KR-ABC-T] A(제외종목)=부분연결(t8436 전일종가>0만; 관리/거래정지 실시간=${KR_A_REALTIME_HALT_CONNECTED ? '연결' : '미연결(t8436 미제공)'}) B(보통주)/C(ETF·SPAC)=t8436 실필드 연결 · T=close×volume(원) proxy(단위 원 일치, raw value 필드 미사용)`);
  log.warn('[YEOKMAE-KR-SELL-GAP] ⚠️ KR SELL executor/placeLSKRSellOrder/종목별 보유수량(sellable) TR 이 repo 에 없음 → 자동 SELL 미구현. 이 상태로 실전 READY 아님(item7). SELL 구현 + 사용자 손절/익절 확정 필요.');

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
  const heldSymbols = new Set(krPositions.map(p => p.symbol));
  const investedKRW = krPositions.reduce((s, p) => s + p.qty * p.entryAvgPrice, 0);
  const pend = scanKRPendingBuy();
  log.info(`[YEOKMAE-KR-HOLDINGS] KR 보유=${krPositions.length}종목 investedKRW=${Math.round(investedKRW)} pendingBuyKRW=${Math.round(pend.totalKRW)} (총사용=${Math.round(investedKRW + pend.totalKRW)}/${totalCapitalKRW})`);

  // 캐시 신호 → UPGRADE-only 후보(보유/pending 제외)
  const { cached, results, corrupt } = scanCachedDiscovery('KR');
  const nameOf = loadNameMap('KR');
  if (cached === 0) { log.warn('[YEOKMAE-KR-LIVE] KR 캐시 없음 — 먼저 npm run yeokmae:build-kr-history 로 pool 구축.'); }
  const candidates = selectKRBuyCandidates(results, { heldSymbols, pendingSymbols: pend.symbols });
  log.info(`[YEOKMAE-KR-CANDIDATES] cached=${cached} corrupt=${corrupt} UPGRADE후보=${candidates.length} (BOTH_UPGRADE=${candidates.filter(c => c.tier === 'BOTH_UPGRADE').length})`);

  // 후보별 자본가드 계획(순차 누적) — 실 가격 조회, 주문 0.
  let runningInvested = investedKRW, runningPending = pend.totalKRW;
  const maxReport = Math.max(3, Math.floor(totalCapitalKRW / perTradeKRW) + 3);
  let planned = 0;
  for (const c of candidates.slice(0, maxReport)) {
    let price = 0;
    try { price = (await getLSKRPrice(cfg, token, c.symbol)).price; } catch (e) { log.warn(`[YEOKMAE-KR-PLAN] ${c.symbol} 시세 실패 → skip. ${scrub(String(e))}`); continue; }
    const guard = computeKRCapitalGuard({ totalCapitalKRW, perTradeKRW, investedKRW: runningInvested, pendingKRW: runningPending, price, orderableCash });
    log.info(`[YEOKMAE-KR-PLAN] symbol=${c.symbol} name=${nameOf.get(c.symbol) ?? '?'} tier=${c.tier} signalType=[${c.signalTypes.join(',')}] signalDate=${c.signalDate} price=${price} finalQty=${guard.finalQty} investKRW=${Math.round(guard.candidateKRW)} canNewBuy=${guard.canNewBuy} reason=${guard.reason} (budgetQty=${guard.budgetQty} capacityQty=${guard.capacityQty} cashQty=${guard.cashQty})`);
    if (guard.canNewBuy) { runningInvested += guard.candidateKRW; planned++; }   // 계획상 누적(실제 주문 아님)
  }
  log.info(`[YEOKMAE-KR-PLAN-SUMMARY] 계획가능 BUY=${planned}종목 · 계획후 총사용=${Math.round(runningInvested + runningPending)}/${totalCapitalKRW}KRW`);

  // 매매일지 + 일일리포트(오늘) — 기록 기반 집계.
  const journal = new TradeJournal('KR'); journal.load();
  const today = new Date().toISOString().slice(0, 10);
  const holdings = krPositions.map(p => {
    const cache = new DailyCache('KR', p.symbol); cache.load();
    const snap = cache.corrupt ? null : buildYeokmaeSnapshot(p.symbol, confirmedCandles(cache));
    return { symbol: p.symbol, qty: p.qty, entryAvgPrice: p.entryAvgPrice, lastPrice: snap?.ohlcv.close ?? null };
  });
  const report = computeDailyReport({ market: 'KR', date: today, signals: candidates.length, entries: journal.entries(), holdings });
  log.info(formatDailyReport(report));

  log.info('──── [YEOKMAE-KR-LIVE-STOP] ────');
  log.info('  이번 빌드 주문 0. 실전 시작 전 사용자 확인 필요:');
  log.info(`   1) BUY 조건: 112_UPGRADE OR 224_UPGRADE (CONFIRMED-only). ORIGINAL 자동대체 없음.`);
  log.info(`   2) 총자본=${totalCapitalKRW}KRW · 종목당=${perTradeKRW}KRW · cash-only(신용/미수 금지).`);
  log.info(`   3) SELL/손절/익절: 현재 KR SELL 미구현 + 손절/익절값 미결정 → ${exit.pendingDecisions.length ? '결정 필요' : '확정됨'}. 비상손실 -${exit.emergencyStopPct}%.`);
  log.info(`   4) 미검증 원본조건: A(관리/거래정지 실시간 미연결), semantics(SHIFT/STDDEV/ICHIMOKU/EMA seed) 미검증, T=close×volume proxy.`);
  log.info(`   5) 실전 CMD(게이트 ON 후): 후속 커밋에서 KR SELL executor 연결 완료 + YEOKMAE_KR_LIVE_TRADING=true + YEOKMAE_KR_EXIT_CONFIRMED=true 후 안내.`);
  log.info('[YEOKMAE-SAFETY] 관찰/계획 전용 · 주문 0 · REAL_ORDER_FROM_YEOKMAE=false');
}
main();
