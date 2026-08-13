// 역매공파 소액 PILOT 실거래 게이트 (P0-35P) — ⚠️ 사용자 승인 제한적 실계정 시험. 검증완료 아님.
//   YEOKMAE_STRATEGY_VALIDATED=false / YEOKMAE_SEMANTICS_VERIFIED=false 유지. PILOT 은 별도 승인 경로.
//   PILOT BUY POST = LS_LIVE_TRADING ∧ YEOKMAE_LIVE_TRADING ∧ YEOKMAE_PILOT_LIVE ∧ confirmedSignal ∧ (기존 모든 안전게이트)
//     ∧ 동시 YEOKMAE 포지션 최대 1개(첫 round-trip 검증 전 2번째 종목 금지).
//   원본 BUY 수식 무변경. SELL 은 P0-34 정책(strategyTag=YEOKMAE 에만, BB SELL 금지).
import type { YeokmaeLiveCandidate } from './live';
import type { YeokmaeExitConfig } from './exit';
import { YEOKMAE_SOURCE_BASED_SELL } from './exit';

// PILOT 단계 동시 보유 상한(첫 BUY/SELL round-trip 검증 전 1개만).
export const YEOKMAE_PILOT_MAX_POSITIONS = 1;
// PILOT 은 검증완료를 의미하지 않는다(코드/로그 명시용).
export const YEOKMAE_PILOT_MEANING = 'USER_APPROVED_LIMITED_LIVE_TRIAL(NOT_VALIDATED)' as const;

export interface YeokmaePilotGateInput {
  candidate: YeokmaeLiveCandidate | null;   // confirmed 5신호 1개+ 만 후보(buildYeokmaeLiveCandidate). null → 차단.
  // 토글
  liveTrading: boolean;          // LS_LIVE_TRADING
  yeokmaeLive: boolean;          // YEOKMAE_LIVE_TRADING
  pilotLive: boolean;            // YEOKMAE_PILOT_LIVE (사용자 승인 시험)
  // 기존 안전장치(주입 — 새로 만들지 않음)
  legacyBbBlocked: boolean;      // LEGACY_BB_LIVE=false
  cashOnly: boolean;
  capitalGuardOk: boolean;       // 총자본 100만원 + $60 예산 범위
  perSymbolBudgetOk: boolean;    // $60 로 최소 1주
  noPending: boolean;
  reconciliationOk: boolean;
  notDuplicateOrder: boolean;    // 동일 symbol/confirmedDate 중복 금지
  // PILOT 전용
  currentYeokmaePositions: number;   // 현재 YEOKMAE 포지션 수
  maxPilotPositions?: number;        // 기본 1
}
export interface YeokmaePilotGateResult {
  mode: 'PILOT';
  allowed: boolean;
  reasons: string[];
  checklist: Record<string, boolean>;
  note: string;
}

const PILOT_KEYS = [
  'confirmedSignal', 'liveTrading', 'yeokmaeLive', 'pilotLive',
  'legacyBbBlocked', 'cashOnly', 'capitalGuardOk', 'perSymbolBudgetOk',
  'noPending', 'reconciliationOk', 'notDuplicateOrder', 'pilotPositionSlotOk',
] as const;

export function evaluateYeokmaePilotGate(g: YeokmaePilotGateInput): YeokmaePilotGateResult {
  const maxPos = g.maxPilotPositions ?? YEOKMAE_PILOT_MAX_POSITIONS;
  const confirmedSignal = !!g.candidate && g.candidate.matchedSignals.length >= 1;
  const pilotPositionSlotOk = g.currentYeokmaePositions < maxPos;   // 이미 1개면 2번째 신규 금지
  const checklist: Record<string, boolean> = {
    confirmedSignal,
    liveTrading: !!g.liveTrading,
    yeokmaeLive: !!g.yeokmaeLive,
    pilotLive: !!g.pilotLive,
    legacyBbBlocked: !!g.legacyBbBlocked,
    cashOnly: !!g.cashOnly,
    capitalGuardOk: !!g.capitalGuardOk,
    perSymbolBudgetOk: !!g.perSymbolBudgetOk,
    noPending: !!g.noPending,
    reconciliationOk: !!g.reconciliationOk,
    notDuplicateOrder: !!g.notDuplicateOrder,
    pilotPositionSlotOk,
  };
  const reasons = PILOT_KEYS.filter(k => !checklist[k]).map(k => `BLOCK:${k}`);
  return {
    mode: 'PILOT', allowed: reasons.length === 0, reasons, checklist,
    note: `PILOT=${YEOKMAE_PILOT_MEANING} · YEOKMAE_STRATEGY_VALIDATED=false · YEOKMAE_SEMANTICS_VERIFIED=false (검증완료 아님)`,
  };
}

// ── 최종 실주문 하드 게이트 (P0-35P2) — env 3종 + PILOT 게이트 통과 + YEOKMAE 포지션 0개 일 때만 실주문. ──
//   ⚠️ YEOKMAE_STRATEGY_VALIDATED/SEMANTICS_VERIFIED 는 요구하지 않는다(별도 사용자 승인 경로). 하나라도 미충족이면 POST 금지.
export interface PilotRealOrderInput {
  liveTrading: boolean; yeokmaeLive: boolean; pilotLive: boolean;
  gateAllowed: boolean; currentYeokmaePositions: number;
}
export interface PilotRealOrderResult { enabled: boolean; reasons: string[] }
export function pilotRealOrderEnabled(p: PilotRealOrderInput): PilotRealOrderResult {
  const reasons: string[] = [];
  if (!p.liveTrading) reasons.push('LS_LIVE_TRADING_off');
  if (!p.yeokmaeLive) reasons.push('YEOKMAE_LIVE_TRADING_off');
  if (!p.pilotLive) reasons.push('YEOKMAE_PILOT_LIVE_off');
  if (!p.gateAllowed) reasons.push('PILOT_GATE_BLOCKED');
  if (p.currentYeokmaePositions !== 0) reasons.push(`YEOKMAE_POSITION_NOT_ZERO(${p.currentYeokmaePositions})`);
  return { enabled: reasons.length === 0, reasons };
}

// ── PILOT BUY 오케스트레이터 (주입식 executor — 단위테스트 가능) ──
//   realOrderEnabled=false 면 executor 를 절대 호출하지 않는다(POST 0). 체결 시 strategyTag=YEOKMAE + 신호정보 저장.
export interface YeokmaePilotBuyDeps {
  executeBuy: (o: { exchcd: string; symbol: string; qty: number; price: number; candleDatetime: string; etDate: string }) => Promise<{ status: string; ordNo: string | null; filledQty: number; fillPrice: number }>;
  recordPosition: (o: { symbol: string; exchcd: string; entryDate: string; fillQty: number; fillPrice: number; confirmedSignalDate: string; matchedSignals: string[] }) => void;
  log: (m: string) => void;
}
export interface YeokmaePilotBuyInput {
  realOrderEnabled: boolean;
  candidate: YeokmaeLiveCandidate | null;
  exchcd: string; qty: number; price: number; candleDatetime: string; etDate: string;
}
export interface YeokmaePilotBuyResult { posted: boolean; ordNo: string | null; reason: string }
export async function runYeokmaePilotBuy(deps: YeokmaePilotBuyDeps, input: YeokmaePilotBuyInput): Promise<YeokmaePilotBuyResult> {
  if (!input.realOrderEnabled) { deps.log('[YEOKMAE-PILOT-ORDER] PILOT_REAL_ORDER_ENABLED=false → 실주문 POST 생략(관찰).'); return { posted: false, ordNo: null, reason: 'PILOT_REAL_ORDER_DISABLED' }; }
  if (!input.candidate) return { posted: false, ordNo: null, reason: 'NO_CANDIDATE' };
  if (!(input.qty > 0)) { deps.log('[YEOKMAE-PILOT-ORDER] qty<=0 → POST 금지(fail-closed).'); return { posted: false, ordNo: null, reason: 'NO_QTY' }; }
  if (!(input.price > 0)) { deps.log('[YEOKMAE-PILOT-ORDER] price<=0(quote stale) → POST 금지(fail-closed).'); return { posted: false, ordNo: null, reason: 'NO_PRICE' }; }
  const out = await deps.executeBuy({ exchcd: input.exchcd, symbol: input.candidate.symbol, qty: input.qty, price: input.price, candleDatetime: input.candleDatetime, etDate: input.etDate });
  deps.log(`[YEOKMAE-PILOT-ORDER] symbol=${input.candidate.symbol} qty=${input.qty} price=${input.price} status=${out.status} ordNo=${out.ordNo ?? '-'}`);
  if (out.status === 'placed-filled' || out.status === 'placed-partial') {
    const fq = out.filledQty > 0 ? out.filledQty : input.qty;
    deps.recordPosition({ symbol: input.candidate.symbol, exchcd: input.exchcd, entryDate: input.etDate, fillQty: fq, fillPrice: out.fillPrice || input.price, confirmedSignalDate: input.candidate.confirmedDate, matchedSignals: input.candidate.matchedSignals });
    return { posted: true, ordNo: out.ordNo, reason: out.status };
  }
  if (out.status === 'placed-pending') return { posted: true, ordNo: out.ordNo, reason: 'placed-pending' };
  return { posted: false, ordNo: out.ordNo, reason: out.status };
}

// [YEOKMAE-PILOT-CHECKLIST] — 첫 실주문 전 전 항목 출력. 하나라도 불명확(false)이면 fail-closed(gate.allowed=false).
export interface PilotChecklistExtra {
  strategyTag: string;              // 'YEOKMAE'
  orderBudgetUSD: number;           // $60
  calcQty: number;                  // 계산 수량
  committedKRW: number; remainingKRW: number;
  sellPolicyArmed: boolean;         // P0-34 SELL 정책 연결됨
  exitConfig: YeokmaeExitConfig;
}
export function formatYeokmaePilotChecklist(g: YeokmaePilotGateInput, x: PilotChecklistExtra): string {
  const c = g.candidate;
  const lines = [
    '[YEOKMAE-PILOT-CHECKLIST]',
    `  signalType=${c ? c.matchedSignals.join('|') : 'NONE'}`,
    `  confirmedDate=${c?.confirmedDate ?? '-'}`,
    `  symbol=${c?.symbol ?? '-'}`,
    `  strategyTag=${x.strategyTag}`,
    `  orderBudgetUSD=${x.orderBudgetUSD}`,
    `  calculatedQty=${x.calcQty}`,
    `  capitalCommittedKRW=${Math.round(x.committedKRW)} remainingKRW=${Math.round(x.remainingKRW)}`,
    `  cashOnly=${g.cashOnly} pending=${!g.noPending} reconciliationOk=${g.reconciliationOk}`,
    `  duplicateSymbolDate=${!g.notDuplicateOrder}`,
    `  currentYeokmaePositions=${g.currentYeokmaePositions}/${g.maxPilotPositions ?? YEOKMAE_PILOT_MAX_POSITIONS}`,
    `  sellPolicyArmed=${x.sellPolicyArmed} (SOURCE_BASED_SELL=${YEOKMAE_SOURCE_BASED_SELL}; stopLoss=-${x.exitConfig.stopLossPct}% takeProfit=+${x.exitConfig.takeProfitPct}% maxHoldDays=${x.exitConfig.maxHoldDays})`,
    `  PILOT=${YEOKMAE_PILOT_MEANING} (검증완료 아님 · STRATEGY_VALIDATED=false)`,
  ];
  return lines.join('\n');
}
