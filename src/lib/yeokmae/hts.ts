// 역매공파(YEOKMAE) — LS/이베스트 HTS 수식 함수의 1:1 재현 (P0-32).
// ⚠️ 원본 신호.txt 의 HTS 함수를 그대로 포팅한다. 결과에 영향을 주는 해석(시드/모집단/변위)은 아래 상수/주석에
//    명시하고 회귀테스트로 고정한다. 추측으로 의미를 바꾸지 않는다. 불확실한 항목은 [YEOKMAE-SPEC-CONFLICT]로 보고.
//
// 대소문자: HTS 는 대소문자 무시. c/C=종가, o/O=시가, h/H=고가, l/L=저가, v/V=거래량.
// 이전봉 참조: x(n) = n봉 전 값. 시리즈로 계산 후 인덱스 i-n 참조로 재현.

export interface Candle { date: string; open: number; high: number; low: number; close: number; volume: number }

// ── eavg(x, n): 지수이동평균(EMA). LS HTS eavg 재현. ──
// ⚠️ [SEED] 시드 선택(P0-32A A/B): 'first'=첫값 EMA[0]=x[0](기본,표준) / 'sma'=첫 n개 SMA 후 시작. k=2/(n+1).
export function eavg(x: readonly number[], n: number, seed: 'first' | 'sma' = 'first'): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  if (x.length === 0 || n <= 0) return out;
  const k = 2 / (n + 1);
  if (seed === 'sma') {
    if (x.length < n) return out;   // SMA 시드조차 불가 → 전부 NaN
    let s = 0; for (let i = 0; i < n; i++) s += x[i];
    let ema = s / n; out[n - 1] = ema;
    for (let i = n; i < x.length; i++) { ema = ema + k * (x[i] - ema); out[i] = ema; }
    return out;
  }
  let ema = x[0]; out[0] = ema;
  for (let i = 1; i < x.length; i++) { ema = ema + k * (x[i] - ema); out[i] = ema; }
  return out;
}

// ── sum(cond): 인자 1개 → 데이터 시작부터의 '누적합'(running cumulative). ──
// 관용구 sum(cond) - sum(cond)(N) = 최근 N봉 내 참(true) 발생 횟수. (예: a - a(50) >= 1)
export function sumCum(cond: readonly boolean[]): number[] {
  const out = new Array<number>(cond.length).fill(0);
  let s = 0;
  for (let i = 0; i < cond.length; i++) { s += cond[i] ? 1 : 0; out[i] = s; }
  return out;
}
// 시리즈 v 의 i봉에서 'N봉 전 값'. i-N<0 이면 defaultVal(누적합은 0). 일반 시리즈는 NaN.
export function prev(v: readonly number[], i: number, n: number, defaultVal = NaN): number {
  const j = i - n;
  return j >= 0 ? v[j] : defaultVal;
}
// 누적합 기준 최근 N봉 발생횟수: cum[i] - cum[i-N](없으면 0).
export function countLastN(cum: readonly number[], i: number, n: number): number {
  return cum[i] - (i - n >= 0 ? cum[i - n] : 0);
}

// ── shift(series, n): 데이터를 n봉 뒤로 이동 → shifted[i] = series[i-n]. ──
// ⚠️ [SHIFT-DIR] 방향: LS shift(data,n) 는 데이터를 오른쪽(미래방향)으로 n봉 이동 = 현재봉 값이 n봉 전 데이터.
//    파란점선 x=shift(...,25) → x[i]=raw[i-25](25봉 전 밴드값). look-ahead 아님(과거참조). 보고서 명시/테스트.
export function shift(series: readonly number[], n: number, dir: 'past' | 'future' = 'past'): number[] {
  const out = new Array<number>(series.length).fill(NaN);
  // past: shifted[i]=series[i-n] (표준·과거참조). future: shifted[i]=series[i+n] (⚠️ look-ahead/repaint).
  for (let i = 0; i < series.length; i++) { const j = dir === 'past' ? i - n : i + n; if (j >= 0 && j < series.length) out[i] = series[j]; }
  return out;
}

// ── Stddevmv(price, flag, period): 이동표준편차. ──
// ⚠️ [STDDEV-POP] flag=0 → 모집단(population, ÷N). (볼린저 관례와 동일. 표본 ÷(N-1) 아님 — 테스트로 고정)
export function stddevmv(x: readonly number[], flag: number, period: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  const pop = flag === 0;   // 0=모집단
  if (period <= 0) return out;
  for (let i = 0; i < x.length; i++) {
    if (i + 1 < period) continue;
    let sum = 0; for (let j = i - period + 1; j <= i; j++) sum += x[j];
    const mean = sum / period;
    let v = 0; for (let j = i - period + 1; j <= i; j++) { const d = x[j] - mean; v += d * d; }
    out[i] = Math.sqrt(v / (pop ? period : period - 1));
  }
  return out;
}

// 단순이동평균(SMA) — bollinger 중심선.
export function smaSeries(x: readonly number[], period: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  if (period <= 0) return out;
  for (let i = 0; i < x.length; i++) {
    if (i + 1 < period) continue;
    let sum = 0; for (let j = i - period + 1; j <= i; j++) sum += x[j];
    out[i] = sum / period;
  }
  return out;
}

// ── bollinger_up/dn(price, mult, period, 단순이평): 볼린저 상/하단. SMA ± mult×표준편차. population 선택([STDDEV-POP]). ──
export function bollingerUp(price: readonly number[], mult: number, period: number, population = true): number[] {
  const mid = smaSeries(price, period); const sd = stddevmv(price, population ? 0 : 1, period);
  return mid.map((m, i) => (Number.isNaN(m) || Number.isNaN(sd[i])) ? NaN : m + mult * sd[i]);
}
export function bollingerDn(price: readonly number[], mult: number, period: number, population = true): number[] {
  const mid = smaSeries(price, period); const sd = stddevmv(price, population ? 0 : 1, period);
  return mid.map((m, i) => (Number.isNaN(m) || Number.isNaN(sd[i])) ? NaN : m - mult * sd[i]);
}

// ── highest/lowest(x, n): 최근 n봉(현재 포함) 최고/최저. ──
export function highest(x: readonly number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) { if (i + 1 < n) continue; let m = -Infinity; for (let j = i - n + 1; j <= i; j++) m = Math.max(m, x[j]); out[i] = m; }
  return out;
}
export function lowest(x: readonly number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) { if (i + 1 < n) continue; let m = Infinity; for (let j = i - n + 1; j <= i; j++) m = Math.min(m, x[j]); out[i] = m; }
  return out;
}

// ── crossup/crossdn(a, b): 골든/데드 크로스(봉단위). ──
// crossup: 직전봉 a<=b 이고 현재봉 a>b. crossdn: 직전봉 a>=b 이고 현재봉 a<b.
export function crossup(a: readonly number[], b: readonly number[]): boolean[] {
  const out = new Array<boolean>(a.length).fill(false);
  for (let i = 1; i < a.length; i++) {
    if ([a[i], b[i], a[i - 1], b[i - 1]].some(Number.isNaN)) continue;
    out[i] = a[i - 1] <= b[i - 1] && a[i] > b[i];
  }
  return out;
}
export function crossdn(a: readonly number[], b: readonly number[]): boolean[] {
  const out = new Array<boolean>(a.length).fill(false);
  for (let i = 1; i < a.length; i++) {
    if ([a[i], b[i], a[i - 1], b[i - 1]].some(Number.isNaN)) continue;
    out[i] = a[i - 1] >= b[i - 1] && a[i] < b[i];
  }
  return out;
}

// ── 일목균형표 선행스팬 (Ichimoku) — IchimokuSenkouSpan1/2(9,26,26,52,26) ──
// tenkan(전환선,9)=(highest(H,9)+lowest(L,9))/2, kijun(기준선,26)=(highest(H,26)+lowest(L,26))/2.
// SenkouSpan1(선행1)=(tenkan+kijun)/2, SenkouSpan2(선행2)=(highest(H,52)+lowest(L,52))/2.
// ⚠️ [ICHI-DISP] 선행스팬은 26봉 앞(미래)으로 변위(displacement=26)되어 그려진다 → 현재봉 값 = 26봉 전 원시값.
//    span[i] = raw[i-26]. (현재 구름은 26봉 전 데이터로 계산됨. look-ahead 아님. 테스트로 고정/보고)
export function ichimokuSpans(
  high: readonly number[], low: readonly number[],
  tenkanP = 9, kijunP = 26, senkouBP = 52, disp = 26,
): { span1: number[]; span2: number[] } {
  const hh9 = highest(high, tenkanP); const ll9 = lowest(low, tenkanP);
  const hh26 = highest(high, kijunP); const ll26 = lowest(low, kijunP);
  const hh52 = highest(high, senkouBP); const ll52 = lowest(low, senkouBP);
  const rawA = hh9.map((_, i) => (Number.isNaN(hh9[i]) || Number.isNaN(hh26[i])) ? NaN : ((hh9[i] + ll9[i]) / 2 + (hh26[i] + ll26[i]) / 2) / 2);
  const rawB = hh52.map((_, i) => Number.isNaN(hh52[i]) ? NaN : (hh52[i] + ll52[i]) / 2);
  return { span1: shift(rawA, disp), span2: shift(rawB, disp) };
}

// 편의: 배열에서 유효(비-NaN) 최소 인덱스 이후만 신뢰. NaN 은 조건 평가 시 false 취급 헬퍼.
export const num = (v: number): number => (Number.isFinite(v) ? v : NaN);
