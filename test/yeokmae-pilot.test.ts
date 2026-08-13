import { describe, it, expect } from 'vitest';
import {
  buildYeokmaeLiveCandidate, evaluateYeokmaePilotGate, formatYeokmaePilotChecklist,
  YEOKMAE_PILOT_MAX_POSITIONS, YEOKMAE_STRATEGY_VALIDATED, YEOKMAE_SEMANTICS_VERIFIED,
  DEFAULT_YEOKMAE_EXIT_CONFIG,
  type YeokmaeSignalType, type YeokmaeLiveCandidate, type YeokmaePilotGateInput,
} from '../src/lib/yeokmae';

const arr = (...a: YeokmaeSignalType[]) => a;
const cand = (matched: YeokmaeSignalType[], isProvisional = false): YeokmaeLiveCandidate | null =>
  buildYeokmaeLiveCandidate({ symbol: 'ABC', exchange: 'NASDAQ', confirmedDate: '2026-08-11', matchedSignals: matched, isProvisional });

// 안전·토글 전량 통과 베이스(포지션 0, PILOT ON).
function gate(over: Partial<YeokmaePilotGateInput>): YeokmaePilotGateInput {
  return {
    candidate: cand(arr('112_ORIGINAL')), liveTrading: true, yeokmaeLive: true, pilotLive: true,
    legacyBbBlocked: true, cashOnly: true, capitalGuardOk: true, perSymbolBudgetOk: true,
    noPending: true, reconciliationOk: true, notDuplicateOrder: true,
    currentYeokmaePositions: 0, maxPilotPositions: YEOKMAE_PILOT_MAX_POSITIONS, ...over,
  };
}

describe('P0-35P PILOT 후보 조건', () => {
  it('arrow 0 → 후보 아님 → confirmedSignal 차단', () => {
    const g = gate({ candidate: cand(arr()) });
    const r = evaluateYeokmaePilotGate(g);
    expect(r.allowed).toBe(false);
    expect(r.reasons).toContain('BLOCK:confirmedSignal');
  });
  it('reverse-only(화살표 0) → 후보 null', () => expect(cand(arr())).toBeNull());
  it('provisional → 후보 null', () => expect(cand(arr('112_ORIGINAL'), true)).toBeNull());
  it('confirmed arrow → pilot candidate 통과(전량 안전 시 allowed)', () => {
    const r = evaluateYeokmaePilotGate(gate({}));
    expect(r.allowed).toBe(true);
    expect(r.mode).toBe('PILOT');
  });
});

describe('P0-35P PILOT 포지션 상한(동시 1개)', () => {
  it('이미 1개 보유 → 추가 BUY 금지(pilotPositionSlotOk)', () => {
    const r = evaluateYeokmaePilotGate(gate({ currentYeokmaePositions: 1 }));
    expect(r.allowed).toBe(false);
    expect(r.reasons).toContain('BLOCK:pilotPositionSlotOk');
  });
  it('MAX_POSITIONS=1', () => expect(YEOKMAE_PILOT_MAX_POSITIONS).toBe(1));
});

describe('P0-35P 안전게이트 실패 → 주문 금지', () => {
  it('pilotLive=false → 차단', () => expect(evaluateYeokmaePilotGate(gate({ pilotLive: false })).reasons).toContain('BLOCK:pilotLive'));
  it('legacy BB 활성 → 차단', () => expect(evaluateYeokmaePilotGate(gate({ legacyBbBlocked: false })).reasons).toContain('BLOCK:legacyBbBlocked'));
  it('pending → 차단', () => expect(evaluateYeokmaePilotGate(gate({ noPending: false })).reasons).toContain('BLOCK:noPending'));
  it('reconciliation 실패 → 차단', () => expect(evaluateYeokmaePilotGate(gate({ reconciliationOk: false })).reasons).toContain('BLOCK:reconciliationOk'));
  it('capital guard 실패 → 차단', () => expect(evaluateYeokmaePilotGate(gate({ capitalGuardOk: false })).reasons).toContain('BLOCK:capitalGuardOk'));
  it('cash-only 실패 → 차단', () => expect(evaluateYeokmaePilotGate(gate({ cashOnly: false })).reasons).toContain('BLOCK:cashOnly'));
  it('동일 symbol/date 중복 → 차단', () => expect(evaluateYeokmaePilotGate(gate({ notDuplicateOrder: false })).reasons).toContain('BLOCK:notDuplicateOrder'));
});

describe('P0-35P PILOT ≠ 검증완료(상태 분리)', () => {
  it('PILOT 게이트는 STRATEGY_VALIDATED 를 요구하지 않는다(별도 경로)', () => {
    // strategyValidated/semanticsVerified 는 false 인데도 PILOT 은 통과 가능(사용자 승인 시험).
    expect(YEOKMAE_STRATEGY_VALIDATED).toBe(false);
    expect(YEOKMAE_SEMANTICS_VERIFIED).toBe(false);
    const r = evaluateYeokmaePilotGate(gate({}));
    expect(r.allowed).toBe(true);
    expect(r.note).toContain('검증완료 아님');
  });
});

describe('P0-35P PILOT-CHECKLIST 포맷', () => {
  it('필수 필드 포함', () => {
    const g = gate({});
    const s = formatYeokmaePilotChecklist(g, { strategyTag: 'YEOKMAE', orderBudgetUSD: 60, calcQty: 0, committedKRW: 0, remainingKRW: 0, sellPolicyArmed: true, exitConfig: DEFAULT_YEOKMAE_EXIT_CONFIG });
    expect(s).toContain('[YEOKMAE-PILOT-CHECKLIST]');
    expect(s).toContain('signalType=112_ORIGINAL');
    expect(s).toContain('strategyTag=YEOKMAE');
    expect(s).toContain('orderBudgetUSD=60');
    expect(s).toContain('sellPolicyArmed=true');
    expect(s).toContain('currentYeokmaePositions=0/1');
    expect(s).toContain('stopLoss=-5%');
  });
});
