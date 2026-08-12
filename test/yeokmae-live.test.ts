import { describe, it, expect } from 'vitest';
import {
  buildYeokmaeLiveCandidate, evaluateYeokmaeLiveGate, formatYeokmaeLiveChecklist,
  YEOKMAE_STRATEGY_VALIDATED, YEOKMAE_SELL_RULE_DEFINED,
  type YeokmaeSignalType, type YeokmaeLiveCandidate,
} from '../src/lib/yeokmae';

const arrows = (...a: YeokmaeSignalType[]) => a;

// 모든 안전게이트 통과 + 전략토글 ON 인 '이상적' 입력(단 strategyValidated 는 파라미터로 주입).
function fullPassGate(candidate: YeokmaeLiveCandidate | null, strategyValidated: boolean) {
  return evaluateYeokmaeLiveGate({
    candidate, liveTrading: true, yeokmaeLive: true, strategyValidated,
    legacyBbBlocked: true, cashOnly: true, capitalGuardOk: true, perSymbolBudgetOk: true,
    noPending: true, reconciliationOk: true, notDuplicateOrder: true, notSameDayReentry: true,
  });
}

describe('P0-33 LIVE 후보 생성 조건', () => {
  const base = { symbol: 'ABC', exchange: 'NASDAQ', confirmedDate: '2026-08-11', searcherFormula: false, verifiedFailed: ['E'], unverifiedExternal: ['A', 'B', 'C', 'T'] };
  it('reverse-only(화살표 0) → 후보 아님(null)', () => {
    expect(buildYeokmaeLiveCandidate({ ...base, matchedSignals: [], isProvisional: false })).toBeNull();
  });
  it('near-match(화살표 0) → 후보 아님', () => {
    expect(buildYeokmaeLiveCandidate({ ...base, matchedSignals: arrows(), isProvisional: false })).toBeNull();
  });
  it('provisional 화살표 → 후보 아님(관찰 전용)', () => {
    expect(buildYeokmaeLiveCandidate({ ...base, matchedSignals: arrows('112_ORIGINAL'), isProvisional: true })).toBeNull();
  });
  it('confirmedDate 없음 → 후보 아님', () => {
    expect(buildYeokmaeLiveCandidate({ ...base, confirmedDate: null, matchedSignals: arrows('LONG_TERM'), isProvisional: false })).toBeNull();
  });
  it('confirmed 화살표 1개+ → 후보 생성', () => {
    const c = buildYeokmaeLiveCandidate({ ...base, matchedSignals: arrows('112_ORIGINAL', 'LONG_TERM'), isProvisional: false });
    expect(c).not.toBeNull();
    expect(c!.matchedSignals).toEqual(['112_ORIGINAL', 'LONG_TERM']);
    expect(c!.confirmedDate).toBe('2026-08-11');
    expect(c!.unverifiedExternal).toEqual(['A', 'B', 'C', 'T']);
  });
});

describe('P0-33 최종 LIVE 게이트', () => {
  const cand = buildYeokmaeLiveCandidate({ symbol: 'ABC', exchange: 'NASDAQ', confirmedDate: '2026-08-11', matchedSignals: arrows('112_ORIGINAL'), isProvisional: false })!;

  it('YEOKMAE_STRATEGY_VALIDATED=false → 나머지 전부 통과해도 최종 POST 차단', () => {
    const r = fullPassGate(cand, false);
    expect(r.allowed).toBe(false);
    expect(r.reasons).toContain('BLOCK:strategyValidated');
  });
  it('코드상수 YEOKMAE_STRATEGY_VALIDATED 는 현재 false', () => {
    expect(YEOKMAE_STRATEGY_VALIDATED).toBe(false);
    // 실제 상수를 주입해도 차단(연결 준비만).
    expect(fullPassGate(cand, YEOKMAE_STRATEGY_VALIDATED).allowed).toBe(false);
  });
  it('후보 없음(candidate=null) → confirmedSignal 차단', () => {
    const r = fullPassGate(null, true);
    expect(r.allowed).toBe(false);
    expect(r.reasons).toContain('BLOCK:confirmedSignal');
  });
  it('동일 symbol/date 중복(idempotency) → 차단', () => {
    const r = evaluateYeokmaeLiveGate({ candidate: cand, liveTrading: true, yeokmaeLive: true, strategyValidated: true, legacyBbBlocked: true, cashOnly: true, capitalGuardOk: true, perSymbolBudgetOk: true, noPending: true, reconciliationOk: true, notDuplicateOrder: false, notSameDayReentry: true });
    expect(r.allowed).toBe(false);
    expect(r.reasons).toContain('BLOCK:notDuplicateOrder');
  });
  it('capital guard 실패 → 차단', () => {
    const r = evaluateYeokmaeLiveGate({ candidate: cand, liveTrading: true, yeokmaeLive: true, strategyValidated: true, legacyBbBlocked: true, cashOnly: true, capitalGuardOk: false, perSymbolBudgetOk: true, noPending: true, reconciliationOk: true, notDuplicateOrder: true, notSameDayReentry: true });
    expect(r.reasons).toContain('BLOCK:capitalGuardOk');
    expect(r.allowed).toBe(false);
  });
  it('pending 존재 → 차단', () => {
    const r = evaluateYeokmaeLiveGate({ candidate: cand, liveTrading: true, yeokmaeLive: true, strategyValidated: true, legacyBbBlocked: true, cashOnly: true, capitalGuardOk: true, perSymbolBudgetOk: true, noPending: false, reconciliationOk: true, notDuplicateOrder: true, notSameDayReentry: true });
    expect(r.reasons).toContain('BLOCK:noPending');
  });
  it('reconciliation 실패 → 차단', () => {
    const r = evaluateYeokmaeLiveGate({ candidate: cand, liveTrading: true, yeokmaeLive: true, strategyValidated: true, legacyBbBlocked: true, cashOnly: true, capitalGuardOk: true, perSymbolBudgetOk: true, noPending: true, reconciliationOk: false, notDuplicateOrder: true, notSameDayReentry: true });
    expect(r.reasons).toContain('BLOCK:reconciliationOk');
  });
  it('동일종목 당일 재진입 → 차단', () => {
    const r = evaluateYeokmaeLiveGate({ candidate: cand, liveTrading: true, yeokmaeLive: true, strategyValidated: true, legacyBbBlocked: true, cashOnly: true, capitalGuardOk: true, perSymbolBudgetOk: true, noPending: true, reconciliationOk: true, notDuplicateOrder: true, notSameDayReentry: false });
    expect(r.reasons).toContain('BLOCK:notSameDayReentry');
  });
  it('legacy BB live 활성(legacyBbBlocked=false) → 차단', () => {
    const r = evaluateYeokmaeLiveGate({ candidate: cand, liveTrading: true, yeokmaeLive: true, strategyValidated: true, legacyBbBlocked: false, cashOnly: true, capitalGuardOk: true, perSymbolBudgetOk: true, noPending: true, reconciliationOk: true, notDuplicateOrder: true, notSameDayReentry: true });
    expect(r.reasons).toContain('BLOCK:legacyBbBlocked');
  });
  it('cash-only/예산 실패 → 차단', () => {
    const r1 = evaluateYeokmaeLiveGate({ candidate: cand, liveTrading: true, yeokmaeLive: true, strategyValidated: true, legacyBbBlocked: true, cashOnly: false, capitalGuardOk: true, perSymbolBudgetOk: true, noPending: true, reconciliationOk: true, notDuplicateOrder: true, notSameDayReentry: true });
    expect(r1.reasons).toContain('BLOCK:cashOnly');
    const r2 = evaluateYeokmaeLiveGate({ candidate: cand, liveTrading: true, yeokmaeLive: true, strategyValidated: true, legacyBbBlocked: true, cashOnly: true, capitalGuardOk: true, perSymbolBudgetOk: false, noPending: true, reconciliationOk: true, notDuplicateOrder: true, notSameDayReentry: true });
    expect(r2.reasons).toContain('BLOCK:perSymbolBudgetOk');
  });
  it('가상 전량통과(strategyValidated=true 주입) → allowed=true (게이트 로직 정합성 확인, 실코드상수는 false)', () => {
    const r = fullPassGate(cand, true);
    expect(r.allowed).toBe(true);
    expect(r.reasons).toEqual([]);
  });
  it('checklist 포맷 + SELL 규칙 미정의', () => {
    const r = fullPassGate(cand, false);
    expect(formatYeokmaeLiveChecklist(r)).toContain('[YEOKMAE-LIVE-CHECKLIST]');
    expect(formatYeokmaeLiveChecklist(r)).toContain('strategyValidated=✗');
    expect(YEOKMAE_SELL_RULE_DEFINED).toBe(false);
  });
});
