import { describe, it, expect } from 'vitest';
import {
  evaluateYeokmae112Original, evaluateYeokmae224Original, evaluateYeokmae112Upgrade,
  evaluateYeokmae224Upgrade, evaluateYeokmaeLongTerm, evaluateAllYeokmae, computeYeokmaeIndicators,
} from '../src/lib/yeokmae/signals';
import { DEFAULT_112_ORIGINAL, DEFAULT_224_ORIGINAL, DEFAULT_112_UPGRADE, DEFAULT_224_UPGRADE, DEFAULT_LONG_TERM } from '../src/lib/yeokmae/types';
import type { Candle } from '../src/lib/yeokmae/hts';

const series = (n: number, fn: (i: number) => Partial<Candle>): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ date: `d${i}`, open: 100, high: 101, low: 99, close: 100, volume: 1000, ...fn(i) }));

describe('P0-32 역매공파 5신호 — 구조/기본값/데이터부족', () => {
  it('원본 기본 변수값 = 신호.txt 원문', () => {
    expect(DEFAULT_112_ORIGINAL).toEqual({ accumPct: 12, blueDotPeriod: 26, accumBarPos: 50, blueDotDev: 15, dev112: 15, bullSize: 5 });
    expect(DEFAULT_224_ORIGINAL).toEqual({ accumPct: 12, blueDotPeriod: 26, accumBarPos: 50, blueDotDev: 15, dev224: 15, bullSize: 5 });
    expect(DEFAULT_112_UPGRADE).toEqual({ accumPct: 12, blueDotPeriod: 26, accumBarPos: 50, blueDotDev: 5, dev112: 8, bullSize: 7 });
    expect(DEFAULT_224_UPGRADE).toEqual({ accumPct: 12, blueDotPeriod: 26, accumBarPos: 50, blueDotDev: 5, dev224: 8, bullSize: 7 });
    expect(DEFAULT_LONG_TERM).toMatchObject({ accumPct: 12, blueDotDev: 15, dev112: 15, dev224: 15, bbLowDev: 5, dropEma5Dev: 15, reverseAlignPeriod: 200, gap112to224: 10, gap224to600: 20, priceBasis: 'open' });
  });

  it('600봉 미만 → 모든 신호 INSUFFICIENT_HISTORY(matched=false), 합성/복제 없음', () => {
    const c = series(300, () => ({}));
    const all = evaluateAllYeokmae(c);
    for (const t of Object.keys(all)) {
      expect(all[t].insufficientHistory).toBe(true);
      expect(all[t].matched).toBe(false);
    }
  });

  it('EMA600 부족(600봉 이상이나 e7 warmup 부족구간) → 중장기 tot=false', () => {
    // 정확히 600봉: e7(EMA600)[599] 는 유효하나 e7 시드영향 구간. 단조하락 역배열이라도 다른 조건 미충족 → matched false.
    const c = series(600, (i) => { const p = 2000 - i; return { open: p, high: p + 1, low: p - 1, close: p }; });
    expect(evaluateYeokmaeLongTerm(c).matched).toBe(false);
    expect(evaluateYeokmaeLongTerm(c).insufficientHistory).toBe(false);
  });

  it('112 원본 vs 224 원본 — sub-condition 키가 다르다(near112 vs near224, e6>=c)', () => {
    const c = series(600, (i) => { const p = 2000 - i * 0.5; return { open: p, high: p + 2, low: p - 2, close: p }; });
    const s112 = evaluateYeokmae112Original(c);
    const s224 = evaluateYeokmae224Original(c);
    if (!s112.insufficientHistory) { expect('near112' in s112.conditions || 'insufficient' in s112.conditions).toBe(true); }
    if (!s224.insufficientHistory) { expect('near224' in s224.conditions || 'insufficient' in s224.conditions).toBe(true); }
    expect(s112.type).toBe('112_ORIGINAL');
    expect(s224.type).toBe('224_ORIGINAL');
  });

  it('업글 — 파 조건(powerCross7/powerNow) 키 존재, 원본의 belowBBUpper 없음', () => {
    const c = series(600, (i) => { const p = 2000 - i * 0.5; return { open: p, high: p + 2, low: p - 2, close: p }; });
    const up = evaluateYeokmae112Upgrade(c);
    const orig = evaluateYeokmae112Original(c);
    if (!up.insufficientHistory && !('insufficient' in up.conditions)) {
      expect('powerCross7' in up.conditions).toBe(true);
      expect('powerNow' in up.conditions).toBe(true);
      expect('belowBBUpper' in up.conditions).toBe(false);
    }
    if (!orig.insufficientHistory && !('insufficient' in orig.conditions)) {
      expect('belowBBUpper' in orig.conditions).toBe(true);
      expect('powerCross7' in orig.conditions).toBe(false);
    }
  });

  it('중장기 — e7/gapAlign/recentUpCross/ichimokuBoth 키 존재(112/224 와 구분)', () => {
    const c = series(650, (i) => { const p = 2000 - i * 0.3; return { open: p, high: p + 2, low: p - 2, close: p }; });
    const lt = evaluateYeokmaeLongTerm(c);
    if (!lt.insufficientHistory && !('insufficient' in lt.conditions)) {
      for (const k of ['reverseAlignment', 'gapAlign', 'recentUpCross', 'ichimokuBoth', 'noReverseInPeriod']) {
        expect(k in lt.conditions).toBe(true);
      }
    }
  });

  it('중복 화살표 차단 — matched 는 tot(now) && !tot(prev) 구조(totNow/totPrev 노출)', () => {
    const c = series(600, () => ({}));
    const s = evaluateYeokmae112Original(c);
    expect(typeof s.totNow).toBe('boolean');
    expect(typeof s.totPrev).toBe('boolean');
    // 데이터부족 아니면: matched 는 totNow 이고 totPrev 아닐 때만
    if (!s.insufficientHistory) expect(s.matched).toBe(s.totNow && !s.totPrev);
  });

  it('computeYeokmaeIndicators — 5종 EMA + 파란점 + BB40 + Ichimoku 산출', () => {
    const c = series(600, (i) => ({ close: 100 + i * 0.1, high: 101 + i * 0.1, low: 99 + i * 0.1, open: 100 + i * 0.1 }));
    const I = computeYeokmaeIndicators(c);
    const last = 599;
    expect(Number.isFinite(I.e1[last])).toBe(true);
    expect(Number.isFinite(I.e4[last])).toBe(true);   // EMA112
    expect(Number.isFinite(I.e5[last])).toBe(true);   // EMA224
    expect(Number.isFinite(I.e6[last])).toBe(true);   // EMA448
    expect(Number.isFinite(I.bolUp40[last])).toBe(true);
    expect(Number.isFinite(I.blueX[last])).toBe(true);
  });
});
