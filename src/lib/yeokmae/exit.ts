// 역매공파 자동매매용 SELL/리스크 정책 (P0-34) — ⚠️ 원본 주식단테 역매공파 공식 SELL 이 아니다.
//   SOURCE_BASED_SELL = NONE / AUTOMATION_RISK_POLICY = P0-34. 원본 BUY 수식은 절대 수정하지 않는다.
//   이 모듈은 '우리 자동매매의 청산/리스크 정책'만 정의(순수). 실제 주문 전송은 러너가 안전장치로 통제(기본 OFF).
import type { YeokmaeSignalType } from './types';

// 자료 기반 SELL 없음 명시(코드/로그 분리용).
export const YEOKMAE_SOURCE_BASED_SELL = 'NONE' as const;
export const YEOKMAE_AUTOMATION_RISK_POLICY = 'P0-34' as const;

// ── 전략 태그 & 분리(rule 2·14) — YEOKMAE 포지션에 BB SELL 금지, LEGACY_BB 포지션에 YEOKMAE SELL 금지 ──
export type StrategyTag = 'YEOKMAE' | 'LEGACY_BB' | 'UNKNOWN';
export function bbSellAppliesTo(tag: StrategyTag): boolean { return tag !== 'YEOKMAE'; }        // BB SELL 은 LEGACY_BB/UNKNOWN 에만
export function yeokmaeSellAppliesTo(tag: StrategyTag): boolean { return tag === 'YEOKMAE'; }   // 역매공파 SELL 은 YEOKMAE 에만

// ── 정책 config (env 는 러너가 읽어 주입 — worker 순수성 유지) ──
export type ProfitMode = 'FIXED' | 'TRAILING';
export interface YeokmaeExitConfig {
  stopLossPct: number;         // YEOKMAE_STOP_LOSS_PCT (기본 5.0) — 진입평균가 대비 -x% 이하 → 전량청산
  profitMode: ProfitMode;      // YEOKMAE_PROFIT_MODE (기본 FIXED)
  takeProfitPct: number;       // YEOKMAE_TAKE_PROFIT_PCT (기본 8.0) — FIXED 모드
  trailingActivatePct: number; // YEOKMAE_TRAILING_ACTIVATE_PCT (기본 5.0) — TRAILING 모드
  trailingDrawdownPct: number; // YEOKMAE_TRAILING_DRAWDOWN_PCT (기본 3.0)
  maxHoldDays: number;         // YEOKMAE_MAX_HOLD_DAYS (기본 20) — 20 거래일+ 이고 pnl<=0 → 청산
}
export const DEFAULT_YEOKMAE_EXIT_CONFIG: YeokmaeExitConfig = {
  stopLossPct: 5.0, profitMode: 'FIXED', takeProfitPct: 8.0,
  trailingActivatePct: 5.0, trailingDrawdownPct: 3.0, maxHoldDays: 20,
};

// ── 청산 사유(rule 12) ──
export type YeokmaeExitReason =
  | 'STOP_LOSS' | 'SAFETY_FORCED_EXIT' | 'TAKE_PROFIT' | 'TRAILING_STOP'
  | 'MAX_HOLD_DAYS' | 'STRUCTURE_INVALIDATION' | 'MANUAL_EXTERNAL';

export interface YeokmaeExitState {
  entryAvgPrice: number;       // 진입 평균가(>0). 미상이면 판정 불가.
  qty: number;
  highestPrice: number;        // 진입 후 최고가(trailing 기준). 재시작 복원값.
  holdDays: number;            // 보유 거래일수
  structureInvalidated?: boolean;   // 추세 무효화 관찰 입력(예: close<EMA112). OBSERVE_ONLY.
}
export interface YeokmaeQuote {
  reliableRealtime: boolean;   // 신뢰 가능한 실시간 last/bid/ask 인가. false 면 SELL 판정 보류(rule 9).
  price: number;               // 판정 기준가(실시간). stale 이면 이 값으로 손절/익절 오발동 금지.
  bestBid?: number;            // 지정가 SELL 기준(rule 10)
  spread?: number;
}
export interface YeokmaeExitInput {
  state: YeokmaeExitState;
  config: YeokmaeExitConfig;
  quote: YeokmaeQuote;
  safetyForcedExit?: boolean;  // 브로커/세이프티 강제청산(주입)
}
export interface YeokmaeExitDecision {
  action: 'HOLD' | 'SELL' | 'NO_QUOTE';
  reason: YeokmaeExitReason | null;
  pnlPct: number | null;
  highestPnlPct: number | null;
  priceUsed: number | null;
  quoteReliable: boolean;
  triggers: {
    stopLoss: boolean; safetyForced: boolean; takeProfit: boolean; trailing: boolean;
    maxHold: boolean; structureInvalidation: boolean;
  };
  structureObserveOnly: boolean;   // 추세무효화는 이번 단계 OBSERVE_ONLY(실 SELL 아님)
  note: string;
}

export function updateHighestPrice(prevHighest: number, price: number): number {
  return Math.max(Number.isFinite(prevHighest) ? prevHighest : 0, Number.isFinite(price) ? price : 0);
}

// 전량청산 수량(rule 8) = min(프로그램 관리수량, 신선 매도가능수량). 부분매도 없음.
export function computeYeokmaeSellQty(p: { programManagedQty: number; freshSellableQty: number }): number {
  return Math.max(0, Math.min(Math.floor(p.programManagedQty), Math.floor(p.freshSellableQty)));
}

// ── 핵심 청산 판정 — 우선순위(rule 6): STOP_LOSS > SAFETY_FORCED > TAKE_PROFIT/TRAILING > MAX_HOLD > STRUCTURE(observe) ──
//   동일 tick 다중 true 여도 SELL 사유는 1개만 반환(POST 1회). 추세무효화는 관찰만.
export function evaluateYeokmaeExit(inp: YeokmaeExitInput): YeokmaeExitDecision {
  const { state, config, quote } = inp;
  const structureObserve = !!state.structureInvalidated;
  const baseTriggers = { stopLoss: false, safetyForced: false, takeProfit: false, trailing: false, maxHold: false, structureInvalidation: structureObserve };

  // rule 9: stale/미신뢰 quote → SELL 판정 보류(관찰만). 손절/익절 오발동 금지.
  if (!quote.reliableRealtime || !(quote.price > 0)) {
    return { action: 'NO_QUOTE', reason: null, pnlPct: null, highestPnlPct: null, priceUsed: null, quoteReliable: false, triggers: baseTriggers, structureObserveOnly: structureObserve, note: 'NO_RELIABLE_QUOTE — 실시간가 미신뢰 → SELL 판정 보류(관찰). stale close 로 손절/익절 금지.' };
  }
  if (!(state.entryAvgPrice > 0)) {
    return { action: 'HOLD', reason: null, pnlPct: null, highestPnlPct: null, priceUsed: quote.price, quoteReliable: true, triggers: baseTriggers, structureObserveOnly: structureObserve, note: 'ENTRY_AVG_UNKNOWN — 평균가 미상 → 청산판정 불가(관찰).' };
  }

  const price = quote.price;
  const pnlPct = (price - state.entryAvgPrice) / state.entryAvgPrice * 100;
  const highest = updateHighestPrice(state.highestPrice, price);
  const highestPnlPct = (highest - state.entryAvgPrice) / state.entryAvgPrice * 100;

  const stopLoss = pnlPct <= -config.stopLossPct;
  const safetyForced = !!inp.safetyForcedExit;
  const takeProfit = config.profitMode === 'FIXED' && pnlPct >= config.takeProfitPct;
  const trailingActivated = config.profitMode === 'TRAILING' && highestPnlPct >= config.trailingActivatePct;
  const trailingDrawdown = highest > 0 ? (highest - price) / highest * 100 : 0;
  const trailing = trailingActivated && trailingDrawdown >= config.trailingDrawdownPct;
  const maxHold = state.holdDays >= config.maxHoldDays && pnlPct <= 0;

  const triggers = { stopLoss, safetyForced, takeProfit, trailing, maxHold, structureInvalidation: structureObserve };
  const mk = (action: 'HOLD' | 'SELL', reason: YeokmaeExitReason | null, note: string): YeokmaeExitDecision =>
    ({ action, reason, pnlPct, highestPnlPct, priceUsed: price, quoteReliable: true, triggers, structureObserveOnly: structureObserve, note });

  // 우선순위대로 첫 SELL 사유 1개만.
  if (stopLoss) return mk('SELL', 'STOP_LOSS', `pnl=${pnlPct.toFixed(2)}% <= -${config.stopLossPct}% (최우선)`);
  if (safetyForced) return mk('SELL', 'SAFETY_FORCED_EXIT', '브로커/세이프티 강제청산');
  if (takeProfit) return mk('SELL', 'TAKE_PROFIT', `FIXED pnl=${pnlPct.toFixed(2)}% >= ${config.takeProfitPct}%`);
  if (trailing) return mk('SELL', 'TRAILING_STOP', `TRAILING 최고 +${highestPnlPct.toFixed(2)}% 후 되돌림 -${trailingDrawdown.toFixed(2)}% >= ${config.trailingDrawdownPct}%`);
  if (maxHold) return mk('SELL', 'MAX_HOLD_DAYS', `holdDays=${state.holdDays} >= ${config.maxHoldDays} 이고 pnl=${pnlPct.toFixed(2)}% <= 0`);
  return mk('HOLD', null, structureObserve ? 'HOLD (STRUCTURE_INVALIDATION 관찰됨 — OBSERVE_ONLY, 실 SELL 아님)' : 'HOLD');
}
