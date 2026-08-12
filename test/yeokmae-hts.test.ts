import { describe, it, expect } from 'vitest';
import {
  eavg, sumCum, shift, stddevmv, smaSeries, bollingerUp, bollingerDn, highest, lowest,
  crossup, crossdn, ichimokuSpans, countLastN,
} from '../src/lib/yeokmae/hts';

describe('P0-32 HTS 원시함수 — 1:1 재현', () => {
  it('eavg — 시드=첫값(EMA[0]=x[0]), k=2/(n+1)', () => {
    const e = eavg([10, 20, 30], 2);   // k=2/3
    expect(e[0]).toBe(10);
    expect(e[1]).toBeCloseTo(10 + (2 / 3) * (20 - 10), 10);   // 16.666..
    expect(e[2]).toBeCloseTo(e[1] + (2 / 3) * (30 - e[1]), 10);
  });
  it('sumCum — 인자1개 누적합, countLastN = 최근N봉 발생횟수', () => {
    const cum = sumCum([true, false, true, true]);   // [1,1,2,3]
    expect(cum).toEqual([1, 1, 2, 3]);
    expect(countLastN(cum, 3, 2)).toBe(3 - 1);   // 최근2봉(idx2,3): 2건
  });
  it('shift(series,n)[i]=series[i-n] (미래방향 이동, i<n → NaN)', () => {
    const s = shift([1, 2, 3, 4, 5], 2);
    expect(s[0]).toBeNaN(); expect(s[1]).toBeNaN();
    expect(s[2]).toBe(1); expect(s[4]).toBe(3);
  });
  it('shift25 — 25봉 전 값 참조(파란점선 변위)', () => {
    const arr = Array.from({ length: 30 }, (_, i) => i);
    const s = shift(arr, 25);
    expect(s[24]).toBeNaN();
    expect(s[25]).toBe(0); expect(s[29]).toBe(4);
  });
  it('stddevmv flag=0 → 모집단(÷N)', () => {
    // [2,4,4,4,5,5,7,9] population stddev = 2 (표본이면 2.138)
    const x = [2, 4, 4, 4, 5, 5, 7, 9];
    const sd = stddevmv(x, 0, 8);
    expect(sd[7]).toBeCloseTo(2, 10);
    const sdSample = stddevmv(x, 1, 8);
    expect(sdSample[7]).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });
  it('bollinger_up/dn — SMA ± 2·모집단stddev, typical price', () => {
    const p = [1, 2, 3, 4, 5];
    const up = bollingerUp(p, 2, 5); const dn = bollingerDn(p, 2, 5);
    const mid = smaSeries(p, 5)[4]; const sd = stddevmv(p, 0, 5)[4];
    expect(up[4]).toBeCloseTo(mid + 2 * sd, 10);
    expect(dn[4]).toBeCloseTo(mid - 2 * sd, 10);
  });
  it('highest/lowest(x,n) — 최근 n봉(현재 포함)', () => {
    expect(highest([1, 5, 3, 2, 8], 3)[4]).toBe(8);
    expect(highest([1, 5, 3, 2, 8], 3)[2]).toBe(5);
    expect(lowest([4, 5, 3, 2, 8], 3)[3]).toBe(2);
  });
  it('crossup/crossdn — 직전봉 관계 + 현재봉 교차', () => {
    const a = [1, 1, 3];   // b=2 고정
    const b = [2, 2, 2];
    expect(crossup(a, b)).toEqual([false, false, true]);   // 1<=2 → 3>2
    const a2 = [3, 3, 1];
    expect(crossdn(a2, b)).toEqual([false, false, true]);
  });
  it('ichimoku — span1=(전환+기준)/2, span2=(52고저중간), 26봉 미래변위 → span[i]=raw[i-26]', () => {
    const n = 60;
    const high = Array.from({ length: n }, (_, i) => 100 + i);   // 단조증가
    const low = Array.from({ length: n }, (_, i) => 90 + i);
    const { span1, span2 } = ichimokuSpans(high, low, 9, 26, 52, 26);
    // 변위 26 → 인덱스 52(=26원시 + 26변위)부터 유효. span[52] = raw[26]
    // raw span2[26] = (highest(H,52)[26?] ...) — 52봉 필요하므로 raw 유효는 idx>=51. 변위 후 span2 유효 idx>=77 (>n)
    // span1 raw 유효 idx>=25(기준26), 변위 후 유효 idx>=51.
    expect(span1[50]).toBeNaN();          // 51 미만 → NaN
    expect(Number.isFinite(span1[51])).toBe(true);
    // 단조증가에서 span1[i] < 현재 고가(과거값이므로) — look-ahead 아님 확인
    expect(span1[59]).toBeLessThan(high[59]);
  });
});
