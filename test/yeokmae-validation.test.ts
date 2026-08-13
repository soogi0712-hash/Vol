import { describe, it, expect } from 'vitest';
import {
  YEOKMAE_STRATEGY_VALIDATED, YEOKMAE_SEMANTICS_VERIFIED, YEOKMAE_SEMANTICS_STATUS,
  YEOKMAE_CONFIRMED_SEMANTICS, DEFAULT_SEMANTICS, YEOKMAE_MIN_VERIFIED_SYMBOLS,
  yeokmaeActivationReadiness, allConfirmed, formatYeokmaeExitPolicy, DEFAULT_YEOKMAE_EXIT_CONFIG,
} from '../src/lib/yeokmae';

describe('P0-35 활성화 불변식 — HTS 검증 전 활성화 금지', () => {
  it('★ YEOKMAE_STRATEGY_VALIDATED 는 semantics 미검증 상태에서 절대 true 일 수 없다', () => {
    // 불변식: STRATEGY_VALIDATED ⇒ SEMANTICS_VERIFIED. semantics 검증 전 true 면 실패.
    expect(!(YEOKMAE_STRATEGY_VALIDATED && !YEOKMAE_SEMANTICS_VERIFIED)).toBe(true);
  });
  it('현재 상태: 둘 다 false (실전 미활성)', () => {
    expect(YEOKMAE_STRATEGY_VALIDATED).toBe(false);
    expect(YEOKMAE_SEMANTICS_VERIFIED).toBe(false);
  });
  it('semantics 4종 전부 UNVERIFIED', () => {
    expect(allConfirmed(YEOKMAE_SEMANTICS_STATUS)).toBe(false);
    for (const v of Object.values(YEOKMAE_SEMANTICS_STATUS)) expect(v).toBe('UNVERIFIED');
  });
  it('확정 semantics 는 HTS 검증 전까지 DEFAULT 와 동일(한 종목 튜닝 금지)', () => {
    expect(YEOKMAE_CONFIRMED_SEMANTICS).toEqual(DEFAULT_SEMANTICS);
  });
});

describe('P0-35 활성화 준비도', () => {
  it('semantics 미검증 → canActivate=false(SEMANTICS_UNVERIFIED)', () => {
    const r = yeokmaeActivationReadiness({ semanticsVerified: false, verifiedSignalSymbols: 5 });
    expect(r.canActivate).toBe(false);
    expect(r.reasons).toContain('SEMANTICS_UNVERIFIED');
  });
  it('종목 부족(<2) → canActivate=false', () => {
    const r = yeokmaeActivationReadiness({ semanticsVerified: true, verifiedSignalSymbols: 1 });
    expect(r.canActivate).toBe(false);
    expect(r.reasons.some(x => x.startsWith('NEED_'))).toBe(true);
  });
  it('semantics 확정 안 됐으면(STATUS 미CONFIRMED) 종목수 충분해도 차단', () => {
    // 현 코드 STATUS 는 UNVERIFIED 이므로 semanticsVerified=true 를 넣어도 STATUS 게이트가 막는다.
    const r = yeokmaeActivationReadiness({ semanticsVerified: true, verifiedSignalSymbols: 3 });
    expect(r.canActivate).toBe(false);
    expect(r.reasons).toContain('SEMANTICS_STATUS_NOT_ALL_CONFIRMED');
  });
  it('MIN_VERIFIED_SYMBOLS=2 (rule 4)', () => {
    expect(YEOKMAE_MIN_VERIFIED_SYMBOLS).toBe(2);
  });
});

describe('P0-35 EXIT-POLICY 포맷(rule 9)', () => {
  it('SOURCE_BASED_SELL=NONE + 정책 요약', () => {
    const s = formatYeokmaeExitPolicy(DEFAULT_YEOKMAE_EXIT_CONFIG);
    expect(s).toContain('[YEOKMAE-EXIT-POLICY]');
    expect(s).toContain('SOURCE_BASED_SELL=NONE');
    expect(s).toContain('stopLoss=-5%');
    expect(s).toContain('takeProfit=+8%');
    expect(s).toContain('maxHoldDays=20');
    expect(s).toContain('structureInvalidation=OBSERVE_ONLY');
  });
});
