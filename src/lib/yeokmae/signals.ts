// 역매공파 5종 신호 — 신호.txt 를 source of truth 로 1:1 포팅 (P0-32). 임의 통합/단순화 금지.
// 각 신호는 서로 독립. 출력에 sub-condition 결과 포함(탈락원인 추적). 데이터 부족 시 신호 생성 금지.
import {
  eavg, sumCum, shift, stddevmv, bollingerUp, bollingerDn, highest, crossdn, crossup, ichimokuSpans,
  countLastN, prev, type Candle,
} from './hts';
import {
  type YeokmaeSignalResult, type Yeokmae112OrigVars, type Yeokmae224OrigVars, type YeokmaeLongTermVars,
  DEFAULT_112_ORIGINAL, DEFAULT_224_ORIGINAL, DEFAULT_112_UPGRADE, DEFAULT_224_UPGRADE, DEFAULT_LONG_TERM,
  YEOKMAE_MIN_BARS,
} from './types';

// ── 공용 지표 계산 (파란점기간=26, 매집퍼센트=12 는 5종 공통) ──
export interface YeokmaeIndicators {
  o: number[]; c: number[]; h: number[]; l: number[];
  e1: number[]; e2: number[]; e3: number[]; e4: number[]; e5: number[]; e6: number[]; e7: number[];
  tp: number[]; blueX: number[]; bolUp40: number[]; bolDn40: number[]; span1: number[]; span2: number[];
  aCum: number[]; bCum: number[]; highest5: number[];
}
export function computeYeokmaeIndicators(candles: readonly Candle[], opts: { blueDotPeriod?: number; accumPct?: number } = {}): YeokmaeIndicators {
  const blueDotPeriod = opts.blueDotPeriod ?? 26;
  const accumPct = opts.accumPct ?? 12;
  const o = candles.map(k => k.open); const c = candles.map(k => k.close);
  const h = candles.map(k => k.high); const l = candles.map(k => k.low);
  const tp = candles.map(k => (k.close + k.high + k.low) / 3);   // (C+H+L)/3 typical price
  const e1 = eavg(c, 5), e2 = eavg(c, 20), e3 = eavg(c, 60), e4 = eavg(c, 112), e5 = eavg(c, 224), e6 = eavg(c, 448), e7 = eavg(c, 600);
  // 파란점선 x = shift(eavg(c,기간)+2.5*Stddevmv((C+H+L)/3,0,기간), 25)
  const blueMid = eavg(c, blueDotPeriod);
  const blueSd = stddevmv(tp, 0, blueDotPeriod);
  const blueX = shift(blueMid.map((m, i) => (Number.isNaN(m) || Number.isNaN(blueSd[i])) ? NaN : m + 2.5 * blueSd[i]), 25);
  const bolUp40 = bollingerUp(tp, 2, 40), bolDn40 = bollingerDn(tp, 2, 40);
  const { span1, span2 } = ichimokuSpans(h, l, 9, 26, 52, 26);
  const f = 1 + accumPct / 100;
  const aCum = sumCum(c.map((_, i) => i >= 1 && c[i - 1] * f <= h[i]));   // c(1)*(100+매집%)/100 <= h
  const bCum = sumCum(o.map((_, i) => o[i] * f <= h[i]));                  // o*(100+매집%)/100 <= h
  const highest5 = highest(c, 5);
  return { o, c, h, l, e1, e2, e3, e4, e5, e6, e7, tp, blueX, bolUp40, bolDn40, span1, span2, aCum, bCum, highest5 };
}

const finite = (...xs: number[]) => xs.every(Number.isFinite);
const matchedFrom = (type: YeokmaeSignalResult['type'], candles: readonly Candle[], totAt: (i: number) => { tot: boolean; conditions: Record<string, boolean> }, extraPrev = 1): YeokmaeSignalResult => {
  const n = candles.length;
  const insufficient = n < YEOKMAE_MIN_BARS;
  if (insufficient) return { type, matched: false, totNow: false, totPrev: false, conditions: {}, insufficientHistory: true };
  const now = totAt(n - 1);
  const prevTot = totAt(n - 2).tot;
  // 중장기는 !tot(1..3), 그 외는 !tot(1). 중복 화살표 차단.
  let noRepeat = !prevTot;
  for (let k = 2; k <= extraPrev; k++) if (n - 1 - k >= 0) noRepeat = noRepeat && !totAt(n - 1 - k).tot;
  return { type, matched: now.tot && noRepeat, totNow: now.tot, totPrev: prevTot, conditions: now.conditions, insufficientHistory: false };
};

// ── 1) 역매공파 112 (원본) ──
export function evaluateYeokmae112Original(candles: readonly Candle[], vars: Yeokmae112OrigVars = DEFAULT_112_ORIGINAL, ind?: YeokmaeIndicators): YeokmaeSignalResult {
  const I = ind ?? computeYeokmaeIndicators(candles, { blueDotPeriod: vars.blueDotPeriod, accumPct: vars.accumPct });
  const y = sumCum(crossdn(I.e1, I.e2)); const z = sumCum(crossdn(I.e5, I.e6));
  const totAt = (i: number) => {
    const { o, c, h: _h, l: _l, e1, e2, e3, e4, e5, e6, blueX, bolUp40, span1, span2, highest5 } = I;
    const cond: Record<string, boolean> = {};
    if (!finite(e4[i], e5[i], e6[i], e1[i], e2[i], e3[i], blueX[i], bolUp40[i], o[i], c[i])) {
      return { tot: false, conditions: { insufficient: true } };
    }
    const bd = vars.blueDotDev / 100, d1 = vars.dev112 / 100, bs = vars.bullSize / 100;
    cond.reverseAlignment = e4[i] <= e5[i] && e5[i] <= e6[i];
    cond.accumulation = countLastN(I.aCum, i, vars.accumBarPos) >= 1 || countLastN(I.bCum, i, vars.accumBarPos) >= 1;
    cond.shortTrend = e1[i] >= e2[i] || e1[i] >= e3[i];
    cond.blueDotBand = blueX[i] * (1 - bd) <= o[i] && blueX[i] * (1 + bd) >= o[i];
    cond.near112 = e4[i] * (1 - d1) <= o[i] && e4[i] * (1 + d1) >= o[i];
    cond.consolidation = !(highest5[i] === c[i]) && o[i] < c[i] && e5[i] >= c[i] && e3[i] <= c[i];
    cond.bullCandle = o[i] * (1 + bs) >= c[i];
    cond.belowBBUpper = bolUp40[i] > c[i];
    cond.ichimoku = span1[i] <= c[i] || span2[i] <= c[i];   // NaN → false (구름 데이터 부족)
    cond.noRecentDeadCross = !(countLastN(y, i, 10) >= 1) && !(countLastN(z, i, 50) >= 1);
    const tot = Object.values(cond).every(Boolean);
    return { tot, conditions: cond };
  };
  return matchedFrom('112_ORIGINAL', candles, totAt);
}

// ── 2) 역매공파 224 (원본) — 112 와 e5 밴드/e6>=c 차이 ──
export function evaluateYeokmae224Original(candles: readonly Candle[], vars: Yeokmae224OrigVars = DEFAULT_224_ORIGINAL, ind?: YeokmaeIndicators): YeokmaeSignalResult {
  const I = ind ?? computeYeokmaeIndicators(candles, { blueDotPeriod: vars.blueDotPeriod, accumPct: vars.accumPct });
  const y = sumCum(crossdn(I.e1, I.e2)); const z = sumCum(crossdn(I.e5, I.e6));
  const totAt = (i: number) => {
    const { o, c, e1, e2, e3, e4, e5, e6, blueX, bolUp40, span1, span2, highest5 } = I;
    const cond: Record<string, boolean> = {};
    if (!finite(e4[i], e5[i], e6[i], e1[i], e2[i], e3[i], blueX[i], bolUp40[i], o[i], c[i])) return { tot: false, conditions: { insufficient: true } };
    const bd = vars.blueDotDev / 100, d2 = vars.dev224 / 100, bs = vars.bullSize / 100;
    cond.reverseAlignment = e4[i] <= e5[i] && e5[i] <= e6[i];
    cond.accumulation = countLastN(I.aCum, i, vars.accumBarPos) >= 1 || countLastN(I.bCum, i, vars.accumBarPos) >= 1;
    cond.shortTrend = e1[i] >= e2[i] || e1[i] >= e3[i];
    cond.blueDotBand = blueX[i] * (1 - bd) <= o[i] && blueX[i] * (1 + bd) >= o[i];
    cond.near224 = e5[i] * (1 - d2) <= o[i] && e5[i] * (1 + d2) >= o[i];   // 224 는 e5 밴드
    cond.consolidation = !(highest5[i] === c[i]) && o[i] < c[i] && e6[i] >= c[i] && e3[i] <= c[i];   // 224 는 e6>=c
    cond.bullCandle = o[i] * (1 + bs) >= c[i];
    cond.belowBBUpper = bolUp40[i] > c[i];
    cond.ichimoku = span1[i] <= c[i] || span2[i] <= c[i];
    cond.noRecentDeadCross = !(countLastN(y, i, 10) >= 1) && !(countLastN(z, i, 50) >= 1);
    return { tot: Object.values(cond).every(Boolean), conditions: cond };
  };
  return matchedFrom('224_ORIGINAL', candles, totAt);
}

// ── 3) 역매공파 112 (업글) — '파' 조건: 최근7봉 crossup(c,x)|crossup(c,bol) + (c>=x|c>=bol|x밴드). bollinger_up>c 없음. ──
export function evaluateYeokmae112Upgrade(candles: readonly Candle[], vars: Yeokmae112OrigVars = DEFAULT_112_UPGRADE, ind?: YeokmaeIndicators): YeokmaeSignalResult {
  const I = ind ?? computeYeokmaeIndicators(candles, { blueDotPeriod: vars.blueDotPeriod, accumPct: vars.accumPct });
  const y = sumCum(crossdn(I.e1, I.e2)); const z = sumCum(crossdn(I.e5, I.e6));
  const fCum = sumCum(I.c.map((_, i) => crossup(I.c, I.blueX)[i] || crossup(I.c, I.bolUp40)[i]));   // f=sum(crossup(c,x) or crossup(c,bol))
  const totAt = (i: number) => {
    const { o, c, e1, e2, e3, e4, e5, blueX, bolUp40, span1, span2, highest5 } = I;
    const cond: Record<string, boolean> = {};
    if (!finite(e4[i], e5[i], I.e6[i], e1[i], e2[i], e3[i], o[i], c[i])) return { tot: false, conditions: { insufficient: true } };
    const d1 = vars.dev112 / 100, bs = vars.bullSize / 100, bd = vars.blueDotDev / 100;
    cond.reverseAlignment = e4[i] <= e5[i] && e5[i] <= I.e6[i];
    cond.accumulation = countLastN(I.aCum, i, vars.accumBarPos) >= 1 || countLastN(I.bCum, i, vars.accumBarPos) >= 1;
    cond.shortTrend = e1[i] >= e2[i] || e1[i] >= e3[i];
    cond.near112 = e4[i] * (1 - d1) <= o[i] && e4[i] * (1 + d1) >= o[i];
    cond.consolidation = !(highest5[i] === c[i]) && o[i] < c[i] && e5[i] >= c[i] && e3[i] <= c[i];
    cond.bullCandle = o[i] * (1 + bs) >= c[i];
    cond.ichimoku = span1[i] <= c[i] || span2[i] <= c[i];
    cond.noRecentDeadCross = !(countLastN(y, i, 10) >= 1) && !(countLastN(z, i, 50) >= 1);
    cond.powerCross7 = countLastN(fCum, i, 7) >= 1;   // 최근7봉 내 crossup 발생 (f-f(7)>=1)
    cond.powerNow = c[i] >= blueX[i] || c[i] >= bolUp40[i] || (blueX[i] * (1 - bd) <= o[i] && blueX[i] * (1 + bd) >= o[i]);
    return { tot: Object.values(cond).every(Boolean), conditions: cond };
  };
  return matchedFrom('112_UPGRADE', candles, totAt);
}

// ── 4) 역매공파 224 (업글) — 업글 로직 + e5 밴드/e6>=c ──
export function evaluateYeokmae224Upgrade(candles: readonly Candle[], vars: Yeokmae224OrigVars = DEFAULT_224_UPGRADE, ind?: YeokmaeIndicators): YeokmaeSignalResult {
  const I = ind ?? computeYeokmaeIndicators(candles, { blueDotPeriod: vars.blueDotPeriod, accumPct: vars.accumPct });
  const y = sumCum(crossdn(I.e1, I.e2)); const z = sumCum(crossdn(I.e5, I.e6));
  const fCum = sumCum(I.c.map((_, i) => crossup(I.c, I.blueX)[i] || crossup(I.c, I.bolUp40)[i]));
  const totAt = (i: number) => {
    const { o, c, e1, e2, e3, e4, e5, e6, blueX, bolUp40, span1, span2, highest5 } = I;
    const cond: Record<string, boolean> = {};
    if (!finite(e4[i], e5[i], e6[i], e1[i], e2[i], e3[i], o[i], c[i])) return { tot: false, conditions: { insufficient: true } };
    const d2 = vars.dev224 / 100, bs = vars.bullSize / 100, bd = vars.blueDotDev / 100;
    cond.reverseAlignment = e4[i] <= e5[i] && e5[i] <= e6[i];
    cond.accumulation = countLastN(I.aCum, i, vars.accumBarPos) >= 1 || countLastN(I.bCum, i, vars.accumBarPos) >= 1;
    cond.shortTrend = e1[i] >= e2[i] || e1[i] >= e3[i];
    cond.near224 = e5[i] * (1 - d2) <= o[i] && e5[i] * (1 + d2) >= o[i];
    cond.consolidation = !(highest5[i] === c[i]) && o[i] < c[i] && e6[i] >= c[i] && e3[i] <= c[i];
    cond.bullCandle = o[i] * (1 + bs) >= c[i];
    cond.ichimoku = span1[i] <= c[i] || span2[i] <= c[i];
    cond.noRecentDeadCross = !(countLastN(y, i, 10) >= 1) && !(countLastN(z, i, 50) >= 1);
    cond.powerCross7 = countLastN(fCum, i, 7) >= 1;
    cond.powerNow = c[i] >= blueX[i] || c[i] >= bolUp40[i] || (blueX[i] * (1 - bd) <= o[i] && blueX[i] * (1 + bd) >= o[i]);
    return { tot: Object.values(cond).every(Boolean), conditions: cond };
  };
  return matchedFrom('224_UPGRADE', candles, totAt);
}

// ── 5) 역매공파 중장기 — e7(EMA600) 사용, y/z 별도, 주가기준=시가, !tot(1..3) ──
export function evaluateYeokmaeLongTerm(candles: readonly Candle[], vars: YeokmaeLongTermVars = DEFAULT_LONG_TERM, ind?: YeokmaeIndicators): YeokmaeSignalResult {
  const I = ind ?? computeYeokmaeIndicators(candles, { blueDotPeriod: 26, accumPct: vars.accumPct });
  // 중장기 y = sum(crossdn(e5,e6) or crossdn(e6,e7) or crossdn(e4,e7)); z = sum(crossup(h,e6))
  const cdn56 = crossdn(I.e5, I.e6), cdn67 = crossdn(I.e6, I.e7), cdn47 = crossdn(I.e4, I.e7);
  const y = sumCum(I.c.map((_, i) => cdn56[i] || cdn67[i] || cdn47[i]));
  const z = sumCum(crossup(I.h, I.e6));
  const totAt = (i: number) => {
    const { o, c, e1, e2, e3, e4, e5, e6, e7, blueX, bolUp40, bolDn40, span1, span2 } = I;
    const cond: Record<string, boolean> = {};
    if (!finite(e4[i], e5[i], e6[i], e7[i], e1[i], e2[i], e3[i], o[i], c[i], bolUp40[i], bolDn40[i])) return { tot: false, conditions: { insufficient: true } };
    const P = vars.priceBasis === 'open' ? o[i] : c[i];   // 주가의기준 = 시가(기본)
    const bd = vars.blueDotDev / 100, d1 = vars.dev112 / 100, d2 = vars.dev224 / 100, bb = vars.bbLowDev / 100, dp = vars.dropEma5Dev / 100;
    cond.reverseAlignment = e5[i] <= e6[i] && e6[i] <= e7[i] && e4[i] <= e6[i] && (e1[i] >= e3[i] || e2[i] >= e3[i]);
    cond.accumulation = countLastN(I.aCum, i, 50) >= 1 || countLastN(I.bCum, i, 50) >= 1;
    cond.powerTrace = c[i] >= bolUp40[i] || (blueX[i] * (1 + bd) >= P && blueX[i] * (1 - bd) <= P);
    cond.nearBand =
      (e4[i] * (1 - d1) <= P && e4[i] * (1 + d1) >= P)
      || (e5[i] * (1 - d2) <= P && e4[i] * (1 + d2) >= P)   // ⚠️ 원문 그대로: e5 하한 & e4 상한(혼합)
      || (bolDn40[i] * (1 - bb) <= c[i] && bolDn40[i] * (1 + bb) >= c[i])
      || (e1[i] * (1 - dp) >= c[i]);
    cond.bullAbove112 = o[i] < c[i] && e4[i] <= c[i];
    cond.ichimokuBoth = span1[i] <= P && span2[i] <= P;   // 중장기는 두 선행스팬 모두 <= 주가기준 (AND)
    cond.noReverseInPeriod = !(countLastN(y, i, vars.reverseAlignPeriod) >= 1);
    cond.recentUpCross = countLastN(z, i, 50) >= 1;        // z-z(50)>=1
    cond.gapAlign = e4[i] * (1 + vars.gap112to224 / 100) >= e5[i] && e5[i] * (1 + vars.gap224to600 / 100) >= e7[i];
    return { tot: Object.values(cond).every(Boolean), conditions: cond };
  };
  return matchedFrom('LONG_TERM', candles, totAt, 3);   // !tot(1) && !tot(2) && !tot(3)
}

// ── 5종 일괄 평가 ──
export function evaluateAllYeokmae(candles: readonly Candle[]): Record<string, YeokmaeSignalResult> {
  return {
    '112_ORIGINAL': evaluateYeokmae112Original(candles),
    '224_ORIGINAL': evaluateYeokmae224Original(candles),
    '112_UPGRADE': evaluateYeokmae112Upgrade(candles),
    '224_UPGRADE': evaluateYeokmae224Upgrade(candles),
    'LONG_TERM': evaluateYeokmaeLongTerm(candles),
  };
}
