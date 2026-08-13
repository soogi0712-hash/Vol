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
