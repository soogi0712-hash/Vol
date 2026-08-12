import { describe, it, expect } from 'vitest';
import { eavg, shift, stddevmv, bollingerUp, ichimokuSpans } from '../src/lib/yeokmae/hts';
import { computeYeokmaeIndicators } from '../src/lib/yeokmae/signals';
import { DEFAULT_SEMANTICS, type YeokmaeSemantics, type Candle } from '../src/lib/yeokmae/types';

describe('P0-32A HTS semantics A/B — 미확정 4종 검증', () => {
  it('기본 semantics = 표준(first/past/population/displaced)', () => {
    expect(DEFAULT_SEMANTICS).toEqual({ emaSeed: 'first', shiftDir: 'past', stddevPopulation: true, ichimokuDisplaced: true });
  });

  it('[SEED] EMA seed first vs sma → 다른 시리즈(초기값/warmup 구간 차이)', () => {
    const x = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i));
    const first = eavg(x, 5, 'first');
    const sma = eavg(x, 5, 'sma');
    expect(first[0]).toBe(x[0]);         // first: 0번부터 값
    expect(sma[0]).toBeNaN();            // sma: n-1 전까지 NaN
    expect(Number.isNaN(sma[3])).toBe(true);
    expect(sma[4]).toBeCloseTo((x[0] + x[1] + x[2] + x[3] + x[4]) / 5, 10);   // SMA 시드
    expect(first[10]).not.toBeCloseTo(sma[10], 6);   // warmup 영향으로 값 다름
  });

  it('[SHIFT-DIR] past vs future → past 는 과거참조(i-n), future 는 미래참조(i+n, look-ahead)', () => {
    const arr = [10, 20, 30, 40, 50];
    expect(shift(arr, 2, 'past')).toEqual([NaN, NaN, 10, 20, 30]);
    expect(shift(arr, 2, 'future')).toEqual([30, 40, 50, NaN, NaN]);   // ⚠️ i+n = look-ahead
  });

  it('[STDDEV-POP] population(÷N) vs sample(÷N-1)', () => {
    const x = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(stddevmv(x, 0, 8)[7]).toBeCloseTo(2, 10);                    // population
    expect(stddevmv(x, 1, 8)[7]).toBeCloseTo(Math.sqrt(32 / 7), 10);    // sample
    // bollinger population 옵션 반영
    const up0 = bollingerUp(x, 2, 8, true)[7];
    const up1 = bollingerUp(x, 2, 8, false)[7];
    expect(up0).not.toBeCloseTo(up1, 6);
  });

  it('[ICHI-DISP] displaced(disp=26) vs nondisplaced(disp=0)', () => {
    const n = 60;
    const high = Array.from({ length: n }, (_, i) => 100 + i);
    const low = Array.from({ length: n }, (_, i) => 90 + i);
    const disp = ichimokuSpans(high, low, 9, 26, 52, 26);
    const nod = ichimokuSpans(high, low, 9, 26, 52, 0);
    // nondisplaced span1[i] = raw[i]; displaced span1[i] = raw[i-26]
    expect(nod.span1[59]).toBeGreaterThan(disp.span1[59]);   // 단조증가 → 현재 raw > 26봉전 raw
  });

  it('computeYeokmaeIndicators — semantics 변경 시 blueLine/bb40/spans 달라짐', () => {
    const c: Candle[] = Array.from({ length: 640 }, (_, i) => { const p = 1000 + Math.sin(i / 7) * 50 + i * 0.1; return { date: `d${i}`, open: p, high: p + 5, low: p - 5, close: p + 1, volume: 1000 }; });
    const std = computeYeokmaeIndicators(c, { semantics: DEFAULT_SEMANTICS });
    const alt: YeokmaeSemantics = { emaSeed: 'sma', shiftDir: 'past', stddevPopulation: false, ichimokuDisplaced: false };
    const altI = computeYeokmaeIndicators(c, { semantics: alt });
    const i = 639;
    expect(std.bolUp40[i]).not.toBeCloseTo(altI.bolUp40[i], 6);   // stddev pop/sample 차이
    expect(std.span1[i]).not.toBeCloseTo(altI.span1[i], 6);       // ichimoku 변위 차이
  });
});
