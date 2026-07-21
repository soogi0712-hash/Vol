/**
 * 이동평균 (SMA / EMA)
 * 입력 values 는 오래된 것 → 최신 순서. 데이터 부족 시 null.
 * NaN/Infinity 는 산출하지 않는다 (입력이 유한하다고 가정하되 결과를 검증).
 */
import { finiteOrNull, allFinite } from './types';

/** 마지막 `period` 개의 단순이동평균(SMA). 데이터 부족/비유한 → null. */
export function sma(values: readonly number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const slice = values.slice(values.length - period);
  if (!allFinite(slice)) return null;
  let sum = 0;
  for (const v of slice) sum += v;
  return finiteOrNull(sum / period);
}

/**
 * EMA 시계열. 길이는 입력과 동일하며, 인덱스 < period-1 은 null.
 * 시드는 처음 `period` 개의 SMA (TA-Lib 방식) — 결정적이라 테스트에 적합.
 * 데이터 부족(length < period) → null 반환.
 */
export function emaSeries(values: readonly number[], period: number): (number | null)[] | null {
  if (period <= 0 || values.length < period) return null;
  if (!allFinite(values)) return null;

  const k = 2 / (period + 1);
  const out: (number | null)[] = new Array(values.length).fill(null);

  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;

  for (let i = period; i < values.length; i++) {
    const prev = out[i - 1] as number;
    out[i] = (values[i] - prev) * k + prev;
  }
  return out;
}

/** 최신 EMA 값 한 개. 데이터 부족 → null. */
export function emaValue(values: readonly number[], period: number): number | null {
  const series = emaSeries(values, period);
  if (!series) return null;
  return finiteOrNull(series[series.length - 1]);
}
