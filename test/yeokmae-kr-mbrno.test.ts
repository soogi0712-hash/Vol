import { describe, it, expect } from 'vitest';
import { resolveKRMbrNo, KR_MBRNO_DEFAULT_REQEXAMPLE } from '../src/lib/ls-api';

describe('P0-35P8 resolveKRMbrNo — env 미설정=문서 예제값 NXT / 명시값 그대로', () => {
  it('미설정(undefined) → NXT, source=DEFAULT_REQEXAMPLE, envValue=null', () => {
    const r = resolveKRMbrNo(undefined);
    expect(r.value).toBe('NXT');
    expect(r.value).toBe(KR_MBRNO_DEFAULT_REQEXAMPLE);
    expect(r.source).toBe('DEFAULT_REQEXAMPLE');
    expect(r.envValue).toBeNull();
  });
  it('null → NXT(미설정 취급)', () => {
    expect(resolveKRMbrNo(null).value).toBe('NXT');
  });
  it('명시 값 → trim+대문자, source=ENV', () => {
    const r = resolveKRMbrNo('  krx ');
    expect(r.value).toBe('KRX');
    expect(r.source).toBe('ENV');
    expect(r.envValue).toBe('  krx ');
  });
  it('★ 빈 문자열 명시 → 빈 값 그대로(사용자가 KRX/empty 라우팅 테스트 가능, |'+"'"+'NXT'+"'"+' 강제 버그 제거)', () => {
    const r = resolveKRMbrNo('');
    expect(r.value).toBe('');
    expect(r.source).toBe('ENV');
  });
});
