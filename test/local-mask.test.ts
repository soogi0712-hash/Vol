import { describe, it, expect } from 'vitest';
import { maskAccount, makeScrubber } from '../local-runner/mask';

describe('maskAccount', () => {
  it('끝 4자리만 노출 + suffix', () => {
    expect(maskAccount('5551234567', '01')).toBe('******4567-01');
  });
  it('suffix 없으면 계좌만', () => {
    expect(maskAccount('12345678')).toBe('****5678');
  });
  it('빈 값 → null', () => {
    expect(maskAccount(null, '01')).toBeNull();
    expect(maskAccount(undefined)).toBeNull();
    expect(maskAccount('')).toBeNull();
  });
});

describe('makeScrubber', () => {
  it('앱키/시크릿/토큰/계좌 전체를 *** 로 치환', () => {
    const scrub = makeScrubber(['APPKEY_123', 'SECRET_456', 'TOKEN_xyz', '5551234567']);
    const s = scrub('err key APPKEY_123 secret SECRET_456 tok TOKEN_xyz acct 5551234567');
    expect(s).not.toContain('APPKEY_123');
    expect(s).not.toContain('SECRET_456');
    expect(s).not.toContain('TOKEN_xyz');
    expect(s).not.toContain('5551234567');
    expect(s).toContain('***');
  });
  it('짧은/빈 비밀값(4자 미만)은 무시하여 과잉치환 방지', () => {
    const scrub = makeScrubber(['', 'ab', undefined, null as any]);
    expect(scrub('abcdef')).toBe('abcdef');
  });
});
