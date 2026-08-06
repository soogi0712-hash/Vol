import { describe, it, expect, afterEach } from 'vitest';
import { resolveUSQuote } from '../local-runner/ls-client';

const save = { ...process.env };
afterEach(() => { process.env = { ...save }; });

describe('resolveUSQuote (해외 시세 구분)', () => {
  it('기본값은 DELAYED (미국 실시간 Non-Display 불가)', () => {
    delete process.env.LS_US_QUOTE_MODE; delete process.env.LS_US_DELAYGB;
    const r = resolveUSQuote();
    expect(r.mode).toBe('DELAYED');
    expect(r.delaygb).toBeNull();          // 공식 지연코드 미설정 → 추측 안 함
    expect(r.error).toMatch(/LS_US_DELAYGB/);
  });
  it('REALTIME 은 확인된 R 사용', () => {
    process.env.LS_US_QUOTE_MODE = 'REALTIME';
    expect(resolveUSQuote()).toMatchObject({ mode: 'REALTIME', delaygb: 'R' });
  });
  it('DELAYED + LS_US_DELAYGB 설정 시 그 값을 사용(추측 아님)', () => {
    process.env.LS_US_QUOTE_MODE = 'DELAYED';
    process.env.LS_US_DELAYGB = 'Y';
    expect(resolveUSQuote()).toMatchObject({ mode: 'DELAYED', delaygb: 'Y' });
  });
});
