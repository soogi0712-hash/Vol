import { describe, it, expect, vi } from 'vitest';
import { isKisRateLimitError, makeKisRateLimiter } from '../src/lib/kis-rate-limit';

describe('isKisRateLimitError', () => {
  it('제한 오류만 true', () => {
    expect(isKisRateLimitError(new Error('EGW00215 초당 거래건수를 초과'))).toBe(true);
    expect(isKisRateLimitError(new Error('EGW00201 유량 제한'))).toBe(true);
    expect(isKisRateLimitError(new Error('HTTP 429'))).toBe(true);
    expect(isKisRateLimitError(new Error('종목코드 오류'))).toBe(false);
    expect(isKisRateLimitError('그냥 문자열')).toBe(false);
  });
});

describe('KisRateLimiter', () => {
  it('성공 시 값 반환', async () => {
    const rl = makeKisRateLimiter({ minIntervalMs: 0, sleepFn: async () => {}, nowFn: () => 0 });
    expect(await rl.run(async () => 42)).toBe(42);
  });

  it('제한 오류 → 백오프 재시도 후 최대치 초과 시 throw', async () => {
    const sleeps: number[] = []; let t = 0;
    const rl = makeKisRateLimiter({
      minIntervalMs: 0, maxRetries: 2, baseBackoffMs: 100,
      sleepFn: async (ms) => { sleeps.push(ms); t += ms; }, nowFn: () => t,
    });
    const fn = vi.fn(async () => { throw new Error('EGW00215 초당 초과'); });
    await expect(rl.run(fn)).rejects.toThrow('EGW00215');
    expect(fn).toHaveBeenCalledTimes(3);        // 1 + 2 재시도
    expect(sleeps).toEqual([100, 200]);         // 지수 백오프
  });

  it('비-제한 오류는 즉시 throw (재시도 없음)', async () => {
    const rl = makeKisRateLimiter({ minIntervalMs: 0, sleepFn: async () => {}, nowFn: () => 0 });
    const fn = vi.fn(async () => { throw new Error('잘못된 종목코드'); });
    await expect(rl.run(fn)).rejects.toThrow('종목코드');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('최소 호출 간격을 적용한다', async () => {
    const sleeps: number[] = []; let t = 0;
    const rl = makeKisRateLimiter({
      minIntervalMs: 150, sleepFn: async (ms) => { sleeps.push(ms); t += ms; }, nowFn: () => t,
    });
    await rl.run(async () => 1);
    await rl.run(async () => 2);
    expect(sleeps).toEqual([150, 150]);
  });
});
