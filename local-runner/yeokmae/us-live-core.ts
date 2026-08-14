// 역매공파 US 실전 코어 (P0-34) — 순수·테스트용. US 실주문 게이트 / KRW→USD 자본가드(실 baseXchRate) / 후보랭킹.
//   ⚠️ 원본 검색기/5신호 수식 무변경. 신용·미수 금지(cash-only). UPGRADE 만 실 BUY(ORIGINAL/LONG_TERM 관찰).
//   US 는 KR 과 완전 별개 게이트 — KR 승인으로 US 가 자동 활성화되지 않는다. 기존 US 안전 인프라(BUY/SELL/reconcile) 재사용.
import { LS_US_SELL_TR_CONFIRMED } from '../../src/lib/ls-api';
import { computeUSCapitalGuard } from '../us-position';
import { evaluateKRExit, type KRExitPolicy, type KRExitReason, type KRExitDecision } from './kr-live-core';
import type { SymbolDiscovery } from './discovery';

// 운영 exit 정책/판정은 시장 무관(KR 과 동일 로직) — 재수출로 러너가 단일 소스 사용.
export { evaluateKRExit as evaluateUSExit };
export type { KRExitPolicy as USExitPolicy, KRExitReason as USExitReason, KRExitDecision as USExitDecision };

// ── US 실주문 최종 게이트 (P0-34, item9) — KR 과 완전 별개. ──
//   US_YEOKMAE_REAL_ORDER_ENABLED = LS_LIVE_TRADING ∧ YEOKMAE_LIVE_TRADING ∧ YEOKMAE_US_LIVE_TRADING
//     ∧ YEOKMAE_US_EXIT_CONFIRMED ∧ US_DAILY_HISTORY_READY ∧ US_BUY_PATH_READY ∧ US_SELL_PATH_READY.
//   ⚠️ YEOKMAE_STRATEGY_VALIDATED(레거시 하드블록) 요구하지 않음 — US 전용 명시 승인(PILOT 과 동일 철학).
//   US_BUY_PATH_READY: COSAT00301 매수(OrdPtnCode 02) 실계정 검증(00040/00136) + cash-only(CROSS-WON) + candle idempotency.
//   US_SELL_PATH_READY: COSAT00301 매도(01) 공식확인(LS_US_SELL_TR_CONFIRMED) + COSOQ00201 fresh sellableQty + fail-closed.
//   US_DAILY_HISTORY_READY: g3204 일봉 실 rows>0 확인(런타임 probe) ∧ 캐시 ready(600+봉) 종목>0 (러너가 계산해 주입).
export const US_BUY_PATH_READY = true;
export const US_SELL_PATH_READY = LS_US_SELL_TR_CONFIRMED;
export interface USRealOrderInput { liveTrading: boolean; yeokmaeLive: boolean; usLive: boolean; exitConfirmed: boolean; historyReady: boolean; }
export interface USRealOrderResult { enabled: boolean; reasons: string[]; buyPathReady: boolean; sellPathReady: boolean; historyReady: boolean; }
export function usRealOrderEnabled(p: USRealOrderInput): USRealOrderResult {
  const reasons: string[] = [];
  if (!p.liveTrading) reasons.push('LS_LIVE_TRADING_off');
  if (!p.yeokmaeLive) reasons.push('YEOKMAE_LIVE_TRADING_off');
  if (!p.usLive) reasons.push('YEOKMAE_US_LIVE_TRADING_off');
  if (!p.exitConfirmed) reasons.push('YEOKMAE_US_EXIT_CONFIRMED_off');
  if (!p.historyReady) reasons.push('US_DAILY_HISTORY_NOT_READY');
  if (!US_BUY_PATH_READY) reasons.push('US_BUY_PATH_NOT_READY');
  if (!US_SELL_PATH_READY) reasons.push('US_SELL_PATH_NOT_READY');
  return { enabled: reasons.length === 0, reasons, buyPathReady: US_BUY_PATH_READY, sellPathReady: US_SELL_PATH_READY, historyReady: p.historyReady };
}

// ── US 청산정책 resolver — 운영 risk policy(원본 역매공파 SELL 아님). YEOKMAE_US_* env. 값만 US 독립, 로직은 KR 과 동일. ──
//   emergencyStop 은 항상 활성(하드 플로어, 기본 -15%). confirmed=YEOKMAE_US_EXIT_CONFIRMED.
const numEnv = (v: string | undefined): number | null => { if (v == null || v.trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
export function resolveUSExitPolicy(env: NodeJS.ProcessEnv): KRExitPolicy {
  const stopLossPct = numEnv(env.YEOKMAE_US_STOP_LOSS_PCT);
  const takeProfitPct = numEnv(env.YEOKMAE_US_TAKE_PROFIT_PCT);
  const maxHoldDays = numEnv(env.YEOKMAE_US_MAX_HOLD_DAYS);
  const emergencyStopPct = numEnv(env.YEOKMAE_US_EMERGENCY_STOP_PCT) ?? 15;
  const confirmed = env.YEOKMAE_US_EXIT_CONFIRMED === 'true';
  const pendingDecisions: string[] = [];
  if (stopLossPct == null) pendingDecisions.push('YEOKMAE_US_STOP_LOSS_PCT(전략 손절% 미결정)');
  if (takeProfitPct == null) pendingDecisions.push('YEOKMAE_US_TAKE_PROFIT_PCT(전략 익절% 미결정)');
  if (maxHoldDays == null) pendingDecisions.push('YEOKMAE_US_MAX_HOLD_DAYS(보유일 한도 미결정)');
  if (!confirmed) pendingDecisions.push('YEOKMAE_US_EXIT_CONFIRMED!=true(사용자 최종확인 필요)');
  return { stopLossPct, takeProfitPct, maxHoldDays, emergencyStopPct, confirmed, pendingDecisions };
}

// ── item2/8: UPGRADE-only 실 BUY 후보 선정 + exchcd 조인 + 랭킹(BOTH_UPGRADE>112>224). CONFIRMED 신호만. ──
//   112_UPGRADE 또는 224_UPGRADE 만. ORIGINAL/LONG_TERM 은 관찰(제외). 보유/pending/계좌보유 재진입 금지.
//   exchcd 미확인 종목은 주문 라우팅 불가 → 후보 제외(추측 금지).
export interface USBuyCandidate {
  symbol: string; exchcd: string; exchange: string;
  tier: 'BOTH_UPGRADE' | 'UPGRADE_112' | 'UPGRADE_224';
  signalTypes: string[]; signalDate: string | null;
  ema112: number; ema224: number; ema448: number;
}
export function selectUSBuyCandidates(
  discoveries: readonly SymbolDiscovery[],
  exchOf: Map<string, { exchcd: string; exchange: string }>,
  exclude: { heldSymbols?: Set<string>; pendingSymbols?: Set<string>; orderedTodaySymbols?: Set<string> } = {},
): USBuyCandidate[] {
  const held = exclude.heldSymbols ?? new Set<string>();
  const pending = exclude.pendingSymbols ?? new Set<string>();
  const orderedToday = exclude.orderedTodaySymbols ?? new Set<string>();
  const out: USBuyCandidate[] = [];
  for (const d of discoveries) {
    if (!d.ready || !d.reverse) continue;
    const u112 = d.arrows['112_UPGRADE'], u224 = d.arrows['224_UPGRADE'];
    if (!u112 && !u224) continue;                                   // UPGRADE 아니면 실 BUY 후보 아님(ORIGINAL 자동대체 금지)
    if (held.has(d.symbol) || pending.has(d.symbol) || orderedToday.has(d.symbol)) continue;   // 재진입 금지
    const ex = exchOf.get(d.symbol);
    if (!ex || !ex.exchcd) continue;                                // 주문 라우팅용 exchcd 미확인 → 제외(추측 금지)
    const signalTypes = (['112_UPGRADE', '224_UPGRADE', '112_ORIGINAL', '224_ORIGINAL', 'LONG_TERM'] as const).filter(t => d.arrows[t]);
    out.push({
      symbol: d.symbol, exchcd: ex.exchcd, exchange: ex.exchange,
      tier: (u112 && u224) ? 'BOTH_UPGRADE' : (u112 ? 'UPGRADE_112' : 'UPGRADE_224'),
      signalTypes, signalDate: d.lastConfirmed,
      ema112: d.ema112, ema224: d.ema224, ema448: d.ema448,
    });
  }
  const rank = (t: USBuyCandidate['tier']) => t === 'BOTH_UPGRADE' ? 0 : t === 'UPGRADE_112' ? 1 : 2;   // item8: BOTH>112>224
  return out.sort((a, b) => rank(a.tier) - rank(b.tier) || a.symbol.localeCompare(b.symbol));
}

// ── item4: US 자본가드(KRW-native 한도 + KRW→USD 종목당 예산 + cash-only). 고정환율 금지(실 baseXchRate). ──
//   perTradeKRW(10만) → USD 예산(perTradeKRW/rate) → perTradeQty. cashOnlyUsd → cashQty(신용/미수 배제).
//   총자본(LS_US_TOTAL_CAPITAL_KRW, KR 과 별개) 은 검증된 computeUSCapitalGuard 로 잔여여력(capacityQty) 산정.
//   finalQty = min(perTradeQty, cashQty, capacityQty). 하나라도 <1 이면 fail-closed 사유.
export interface USYeokmaeCapitalGuard {
  totalCapitalKRW: number; perTradeKRW: number; baseXchRate: number; bestAsk: number;
  perTradeUSD: number; investedUSD: number; pendingUSD: number; cashOnlyUsd: number;
  perTradeQty: number; cashQty: number; capacityQty: number;
  finalQty: number; candidateUSD: number; candidateKRW: number; canNewBuy: boolean; reason: string;
}
export function computeUSYeokmaeCapitalGuard(p: {
  totalCapitalKRW: number; perTradeKRW: number; investedUSD: number; pendingUSD: number;
  bestAsk: number; baseXchRate: number; cashOnlyUsd: number;
}): USYeokmaeCapitalGuard {
  const rate = p.baseXchRate > 0 ? p.baseXchRate : 0;
  const perTradeUSD = rate > 0 ? p.perTradeKRW / rate : 0;
  const base = {
    totalCapitalKRW: p.totalCapitalKRW, perTradeKRW: p.perTradeKRW, baseXchRate: rate, bestAsk: p.bestAsk,
    perTradeUSD, investedUSD: Math.max(0, p.investedUSD), pendingUSD: Math.max(0, p.pendingUSD), cashOnlyUsd: Math.max(0, p.cashOnlyUsd),
  };
  const zero = (reason: string, over: Partial<USYeokmaeCapitalGuard> = {}): USYeokmaeCapitalGuard =>
    ({ ...base, perTradeQty: 0, cashQty: 0, capacityQty: 0, finalQty: 0, candidateUSD: 0, candidateKRW: 0, canNewBuy: false, reason, ...over });
  if (!(rate > 0)) return zero('NO_XCHRATE(실 기준환율 미확보 — 고정환율 금지)');
  if (!(p.bestAsk > 0)) return zero('PRICE_UNAVAILABLE');
  if (!(p.perTradeKRW > 0)) return zero('PER_TRADE_UNSET');
  const perTradeQty = Math.floor(perTradeUSD / p.bestAsk);           // 종목당 10만원(USD 환산) 상한
  const cashQty = Math.floor(base.cashOnlyUsd / p.bestAsk);          // 실 현금 주문가능(신용/미수 배제)
  // 총자본 잔여여력 — 검증된 computeUSCapitalGuard 재사용(candidateQty=∞ 대용으로 큰 수 넣어 순수 여력만 산출).
  const cap = computeUSCapitalGuard({ limitKRW: p.totalCapitalKRW, investedUSD: base.investedUSD, pendingUSD: base.pendingUSD, candidateQty: Number.MAX_SAFE_INTEGER, bestAsk: p.bestAsk, baseXchRate: rate });
  const capacityQty = cap.finalQty;                                 // 남은 총자본으로 가능한 최대 주수
  const full = { ...base, perTradeQty, cashQty, capacityQty };
  if (perTradeQty < 1) return { ...full, finalQty: 0, candidateUSD: 0, candidateKRW: 0, canNewBuy: false, reason: 'PER_TRADE_TOO_SMALL(1주 초과 단가)' };
  if (cashQty < 1) return { ...full, finalQty: 0, candidateUSD: 0, candidateKRW: 0, canNewBuy: false, reason: 'CASH_INSUFFICIENT(주문가능현금 부족)' };
  if (capacityQty < 1) return { ...full, finalQty: 0, candidateUSD: 0, candidateKRW: 0, canNewBuy: false, reason: cap.reason === 'CAPITAL_EXHAUSTED' ? 'CAPITAL_EXHAUSTED' : 'CAPITAL_INSUFFICIENT_FOR_1SHARE' };
  const finalQty = Math.min(perTradeQty, cashQty, capacityQty);
  const candidateUSD = finalQty * p.bestAsk;
  return { ...full, finalQty, candidateUSD, candidateKRW: candidateUSD * rate, canNewBuy: finalQty >= 1, reason: finalQty < perTradeQty ? 'REDUCED_TO_FIT(자본/현금 한도)' : 'OK' };
}

// ── item6: 시작 시 실계좌(COSOQ00201 holdings) ↔ 프로그램 원장 reconcile(순수). 수동보유와 절대 혼합 금지. ──
//   broker balQty=0 인데 원장 보유 → 외부청산 의심. broker < 원장 → 원장 과다. 판정만(부수효과 없음, 자동삭제 금지).
export interface USLedgerReconcileEntry { symbol: string; ledgerQty: number; brokerQty: number; brokerSellable: number; status: 'MATCH' | 'BROKER_LESS' | 'BROKER_ZERO' | 'BROKER_MORE'; }
export function reconcileUSLedgerVsHoldings(
  ledger: readonly { symbol: string; qty: number }[],
  holdings: readonly { symbol: string; balQty: number; sellableQty: number }[],
): USLedgerReconcileEntry[] {
  const hBySym = new Map(holdings.map(h => [h.symbol, h]));
  return ledger.filter(l => l.qty > 0).map(l => {
    const h = hBySym.get(l.symbol);
    const brokerQty = h?.balQty ?? 0; const brokerSellable = h?.sellableQty ?? 0;
    const status: USLedgerReconcileEntry['status'] = brokerQty === 0 ? 'BROKER_ZERO'
      : brokerQty < l.qty ? 'BROKER_LESS' : brokerQty > l.qty ? 'BROKER_MORE' : 'MATCH';
    return { symbol: l.symbol, ledgerQty: l.qty, brokerQty, brokerSellable, status };
  });
}
