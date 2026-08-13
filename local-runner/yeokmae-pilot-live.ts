// 역매공파 소액 PILOT 실거래 실행기 (P0-35P2) — 실행: npm run yeokmae:pilot-live -- KR   |   -- US
//   ⚠️ 이 명령에서만 PILOT 실주문이 가능(다른 명령은 절대 주문 안 함). 기존 안전 BUY executor(executeBuyOrder/executeKRBuyOrder)
//      를 그대로 재사용 → reconciliation/pending/cash-only/idempotency/fresh orderable 를 모두 거친 뒤에만 POST.
//   최종 실주문 = LS_LIVE_TRADING ∧ YEOKMAE_LIVE_TRADING ∧ YEOKMAE_PILOT_LIVE ∧ PILOT 게이트 통과 ∧ YEOKMAE 포지션 0개.
//   YEOKMAE_STRATEGY_VALIDATED/SEMANTICS_VERIFIED 는 false 유지(별도 사용자 승인 경로). 하나라도 불명확이면 fail-closed(POST 0).
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached, resolveUSQuote } from './ls-client';
import { loadUSSymbols } from './universe';
import { makeScrubber } from './mask';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrderStore } from './order-store';
import { executeBuyOrder, type TraderDeps } from './trader';
import { executeKRBuyOrder, type KRTraderDeps } from './kr-trader';
import { YeokmaePositionStore } from './yeokmae-position-store';
import { YEOKMAE_DAILY_ROOT } from './yeokmae-daily-cache';
import {
  getLSKRPrice, getLSUSPrice, getLSKRBalance, getLSUSDeposit, getLSUSHoldings, isCashOnly, usCashOnlyUsdCap, computeUSOrderQty,
  placeLSUSBuyOrder, queryLSUSOrderExec, cancelLSUSOrder, placeLSKRBuyOrder, queryLSKROrderExec, cancelLSKRBuyOrder,
  LS_US_ORDEREXEC_EMPTY_CODES,
} from '../src/lib/ls-api';
import {
  buildYeokmaeLiveCandidate, evaluateYeokmaePilotGate, formatYeokmaePilotChecklist,
  pilotRealOrderEnabled, runYeokmaePilotBuy, formatYeokmaeExitPolicy,
  DEFAULT_YEOKMAE_EXIT_CONFIG, YEOKMAE_PILOT_MAX_POSITIONS,
  YEOKMAE_STRATEGY_VALIDATED, YEOKMAE_SEMANTICS_VERIFIED, type YeokmaeSignalType,
} from '../src/lib/yeokmae';

const SIGNAL_KEYS: YeokmaeSignalType[] = ['112_ORIGINAL', '224_ORIGINAL', '112_UPGRADE', '224_UPGRADE', 'LONG_TERM'];
const marketDate = (tzOffsetH: number): string => { const d = new Date(Date.now() + tzOffsetH * 3600_000); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; };

async function main() {
  loadEnvLocal();
  const log = createLogger('yeokmae-pilot-live');
  const market = ((process.argv[2] || '').toUpperCase());
  if (market !== 'KR' && market !== 'US') { log.error('사용법: npm run yeokmae:pilot-live -- KR | US'); process.exit(1); return; }
  const fail = (reason: string): never => { log.error(`[YEOKMAE-PILOT-ORDER] FAIL_CLOSED(${reason}) → 주문 없음.`); process.exit(2) as never; throw new Error(reason); };

  const liveTrading = process.env.LS_LIVE_TRADING === 'true';
  const yeokmaeLive = process.env.YEOKMAE_LIVE_TRADING === 'true';
  const pilotLive = process.env.YEOKMAE_PILOT_LIVE === 'true';
  const legacyBbBlocked = process.env.LEGACY_BB_LIVE_ENABLED !== 'true';
  const budgetUSD = Number(process.env.LS_US_PER_TRADE_BUDGET_USD || 60) || 60;

  log.info(`===== [YEOKMAE-PILOT-LIVE] market=${market} — 소액 PILOT 실거래 실행기 =====`);
  log.info(`[YEOKMAE-SAFETY] LS_LIVE_TRADING=${liveTrading} YEOKMAE_LIVE_TRADING=${yeokmaeLive} YEOKMAE_PILOT_LIVE=${pilotLive} · YEOKMAE_STRATEGY_VALIDATED=${YEOKMAE_STRATEGY_VALIDATED} YEOKMAE_SEMANTICS_VERIFIED=${YEOKMAE_SEMANTICS_VERIFIED} · PILOT=사용자승인 소액시험(검증완료 아님)`);
  log.info(formatYeokmaeExitPolicy(DEFAULT_YEOKMAE_EXIT_CONFIG));

  // 1) config/token — fail-closed
  let cfg; try { cfg = loadConfig(); } catch (e) { return void fail(`config: ${String(e)}`); }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); } catch (e) { return void fail(`token: ${scrub(String(e))}`); }

  // 2) confirmed 신호 파일 → 후보(첫 confirmed 화살표). 없으면 fail-closed.
  const file = join(YEOKMAE_DAILY_ROOT, `${market}.real-signals.json`);
  if (!existsSync(file)) return void fail(`신호 파일 없음: ${file}`);
  let signals: any[] = [];
  try { signals = JSON.parse(readFileSync(file, 'utf8')).signals ?? []; } catch { return void fail(`신호 파일 파싱 실패`); }
  const first = signals.find(s => SIGNAL_KEYS.some(k => s[k] === true));
  if (!first) return void fail('confirmed 5신호 ON 종목 없음(reverse-only/near-match/provisional 은 후보 아님)');
  const matchedSignals = SIGNAL_KEYS.filter(k => first[k] === true);
  const candidate = buildYeokmaeLiveCandidate({ symbol: first.symbol, exchange: first.exchange, confirmedDate: first.confirmedDate, matchedSignals, isProvisional: false, searcherFormula: !!first.searcherFormula, verifiedFailed: first.verifiedFailed ?? [], unverifiedExternal: first.unverified ?? ['A', 'B', 'C', 'T'] });
  if (!candidate) return void fail('후보 생성 실패(confirmed 화살표 아님)');

  // 3) YEOKMAE 포지션 수(재시작 복원) — 1개라도 있으면 신규 금지
  const posStore = new YeokmaePositionStore(); posStore.load();
  if (posStore.corrupt) return void fail('YEOKMAE 포지션 파일 손상(strategyTag 불명)');
  const currentYeokmaePositions = posStore.all().length;

  // 4) quote(REST) + 수량 + cash — 시장별. price<=0 → fail-closed(quote stale).
  let exchcd = ''; let price = 0; let qty = 0; let cashOnly = false; let capitalGuardOk = false; let orderable = 0;
  if (market === 'US') {
    const us = loadUSSymbols(); const sym = us.ok.find(s => s.symbol === candidate.symbol.toUpperCase());
    if (!sym) return void fail(`US 종목 미확인: ${candidate.symbol}`);
    exchcd = sym.exchcd; const delaygb = resolveUSQuote().delaygb ?? 'R';
    let q; try { q = await getLSUSPrice(cfg, token, sym.symbol, sym.exchcd, delaygb); } catch (e) { return void fail(`US 시세 조회 실패: ${scrub(String(e))}`); }
    price = q.price;
    let dep; try { dep = await getLSUSDeposit(cfg, token); } catch (e) { return void fail(`US 예수금 조회 실패: ${scrub(String(e))}`); }
    if (!dep.ok) return void fail('US 예수금 조회 실패(ok=false)');
    cashOnly = isCashOnly(dep);
    const cashCap = usCashOnlyUsdCap(dep, {});
    orderable = price > 0 ? Math.floor(cashCap / price) : 0;
    const qd = computeUSOrderQty({ perTradeBudgetUsd: budgetUSD, orderableQty: orderable, bestAsk: price, maxQty: null });
    qty = qd.finalQty; capitalGuardOk = qty >= 1 && cashOnly;
  } else {
    exchcd = 'KR';
    let q; try { q = await getLSKRPrice(cfg, token, candidate.symbol); } catch (e) { return void fail(`KR 시세 조회 실패: ${scrub(String(e))}`); }
    price = q.price;
    let bal; try { bal = await getLSKRBalance(cfg, token); } catch (e) { return void fail(`KR 잔고 조회 실패: ${scrub(String(e))}`); }
    cashOnly = bal.orderableCash > 0;
    orderable = price > 0 ? Math.floor(bal.orderableCash / price) : 0;
    // 기존 KR 규칙(ls-kr-scan): maxQty=1 강제. 임의 하드코딩 아님 — 기존 상한 재사용 + 결제가능 확인.
    qty = Math.max(0, Math.min(1, orderable));
    capitalGuardOk = qty >= 1 && cashOnly;
  }
  if (!(price > 0)) return void fail('실시간가 미확보(quote stale) → 손절/익절 오발동 방지 위해 주문 금지');

  // 5) PILOT 게이트 — reconciliation/pending 은 executor 가 최종 강제(여기선 로컬 pending + dup 만 사전확인)
  const orders = new OrderStore(`YEOKMAE_${market}_${candidate.symbol}`); orders.load();
  if (orders.corrupt) return void fail('주문상태 파일 손상');
  const noPending = !orders.hasPending();
  const notDuplicateOrder = !orders.hasOrderedCandle(candidate.confirmedDate, 'buy');
  const gateInput = {
    candidate, liveTrading, yeokmaeLive, pilotLive, legacyBbBlocked,
    cashOnly, capitalGuardOk, perSymbolBudgetOk: qty >= 1, noPending,
    reconciliationOk: true,   // 최종 강제는 executeBuyOrder/executeKRBuyOrder 내부 대사(실패 시 abort → POST 0)
    notDuplicateOrder, currentYeokmaePositions, maxPilotPositions: YEOKMAE_PILOT_MAX_POSITIONS,
  };
  const gate = evaluateYeokmaePilotGate(gateInput);
  const orderAmount = qty * price;
  log.info(formatYeokmaePilotChecklist(gateInput, { strategyTag: 'YEOKMAE', orderBudgetUSD: budgetUSD, calcQty: qty, committedKRW: 0, remainingKRW: 0, sellPolicyArmed: true, exitConfig: DEFAULT_YEOKMAE_EXIT_CONFIG }));
  log.info(`  currentPrice=${price} qty=${qty} orderAmount=${orderAmount.toFixed(2)} orderable=${orderable}`);

  // 6) 최종 실주문 하드 게이트
  const final = pilotRealOrderEnabled({ liveTrading, yeokmaeLive, pilotLive, gateAllowed: gate.allowed, currentYeokmaePositions });
  log.info(`[YEOKMAE-PILOT-LIVE-GATE] gateAllowed=${gate.allowed} gateReasons=[${gate.reasons.join(',')}] PILOT_REAL_ORDER_ENABLED=${final.enabled} blockers=[${final.reasons.join(',')}]`);

  // 7) executor 연결 — realOrderEnabled=true 일 때만 POST(runYeokmaePilotBuy 가 강제).
  const etDate = market === 'US' ? marketDate(-5) : marketDate(9);   // ET(대략) / KST
  const buyDeps = market === 'US' ? (() => {
    const traderDeps: TraderDeps = {
      place: (pp) => placeLSUSBuyOrder(cfg, token, pp),
      query: (pp) => queryLSUSOrderExec(cfg, token, pp, { emptyCodes: LS_US_ORDEREXEC_EMPTY_CODES }),
      cancel: (pp) => cancelLSUSOrder(cfg, token, pp),
      cashOrderable: async () => { const d = await getLSUSDeposit(cfg, token); return { ok: d.ok, cash: usCashOnlyUsdCap(d, {}) }; },
      now: () => Date.now(), log: (m) => log.info(m),
    };
    return {
      executeBuy: async (o: any) => { const out = await executeBuyOrder(traderDeps, { orders, exchcd: o.exchcd, symbol: o.symbol, candleDatetime: o.candleDatetime, qty: o.qty, price: o.price, etDate: o.etDate, dailyMaxBuys: 1 }); return { status: out.status, ordNo: out.ordNo, filledQty: out.status === 'placed-filled' ? o.qty : 0, fillPrice: o.price }; },
      recordPosition: (o: any) => { posStore.applyYeokmaeBuyFill(o); posStore.flush(); },
      log: (m: string) => log.info(m),
    };
  })() : (() => {
    const krDeps: KRTraderDeps = {
      place: (pp) => placeLSKRBuyOrder(cfg, token, pp),
      queryExec: (pp) => queryLSKROrderExec(cfg, token, pp),
      cancel: (pp) => cancelLSKRBuyOrder(cfg, token, pp),
      cashOrderable: async () => { try { const b = await getLSKRBalance(cfg, token); return { ok: true, cash: b.orderableCash }; } catch { return { ok: false, cash: 0 }; } },
      now: () => Date.now(), log: (m) => log.info(m),
    };
    return {
      executeBuy: async (o: any) => { const out = await executeKRBuyOrder(krDeps, { orders, shcode: o.symbol, candleDatetime: o.candleDatetime, qty: o.qty, price: o.price, krDate: o.etDate, dailyMaxBuys: 1 }); return { status: out.status, ordNo: out.ordNo, filledQty: out.execQty, fillPrice: o.price }; },
      recordPosition: (o: any) => { posStore.applyYeokmaeBuyFill(o); posStore.flush(); },
      log: (m: string) => log.info(m),
    };
  })();

  const result = await runYeokmaePilotBuy(buyDeps, { realOrderEnabled: final.enabled, candidate, exchcd, qty, price, candleDatetime: candidate.confirmedDate, etDate });
  log.info(`[YEOKMAE-PILOT-STATUS] posted=${result.posted} ordNo=${result.ordNo ?? '-'} reason=${result.reason} — ${result.posted ? '체결 시 strategyTag=YEOKMAE 저장 + P0-34 SELL 정책 활성' : '실주문 없음'}`);
  if (result.posted) log.info(`[YEOKMAE-PILOT-SELL-ARMED] symbol=${candidate.symbol} STOP_LOSS=-${DEFAULT_YEOKMAE_EXIT_CONFIG.stopLossPct}% TAKE_PROFIT=+${DEFAULT_YEOKMAE_EXIT_CONFIG.takeProfitPct}% MAX_HOLD_DAYS=${DEFAULT_YEOKMAE_EXIT_CONFIG.maxHoldDays} · BB SELL 미적용(strategyTag=YEOKMAE 전용).`);
}
main();
