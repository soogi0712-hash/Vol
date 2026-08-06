import { describe, it, expect } from 'vitest';
import { maskAccount, makeScrubber, sanitizeBlocks } from '../local-runner/mask';

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

describe('sanitizeBlocks', () => {
  it('계좌/비밀번호 키는 ***, 금액 필드는 보존', () => {
    const out = sanitizeBlocks({
      AcntNo: '55512345678', Pwd: '0000',
      MnyOrdAbleAmt: '1000000', DpsastTotamt: '1234567', Dps: '1000000',
    }) as any;
    expect(out.AcntNo).toBe('***');
    expect(out.Pwd).toBe('***');
    expect(out.MnyOrdAbleAmt).toBe('1000000');   // 금액은 확인용으로 유지
    expect(out.DpsastTotamt).toBe('1234567');
    expect(out.Dps).toBe('1000000');
  });
  it('중첩 객체/배열도 재귀 처리', () => {
    const out = sanitizeBlocks({ list: [{ acnt_no: 'x', val: '5' }] }) as any;
    expect(out.list[0].acnt_no).toBe('***');
    expect(out.list[0].val).toBe('5');
  });
});

describe('keyFingerprint', () => {
  it('앞 4자리 + **** (req5)', async () => {
    const { keyFingerprint } = await import('../local-runner/mask');
    expect(keyFingerprint('abcd1234efgh')).toBe('abcd****');
    expect(keyFingerprint('9f21xxxx')).toBe('9f21****');
    expect(keyFingerprint('')).toBe('(none)');
    expect(keyFingerprint(undefined)).toBe('(none)');
  });
});
