/**
 * 볼린저 밴드폭 (Bollinger Bandwidth)
 * ─────────────────────────────────────────────────────────────
 * bandwidth = (상단 - 하단) / 중심선 = (2 * mult * stddev) / SMA
 * 입력 closes 는 오래된 것 → 최신 순서. period 개 미만이면 null.
 *
 * ※ 이 계산은 매매 전략의 calcBB 와 독립이다. 매매 판단에 관여하지 않으며,
 *   관찰용 밴드폭(변동성 척도)만 산출한다. 모집단 표준편차를 사용한다.
 *   중심선(SMA)이 0 이하이면 비율 계산 불가 → null.
 */
import { finiteOrNull, allFinite } from './types';

export function computeBollingerBandwidth(
  closes: readonly number[],
  period = 20,
  mult = 2,
): number | null {
  if (period <= 0 || closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  if (!allFinite(slice)) return null;

  let sum = 0;
  for (const v of slice) sum += v;
  const mean = sum / period;
  if (mean <= 0) return null;

  let variance = 0;
  for (const v of slice) variance += (v - mean) * (v - mean);
  variance /= period; // 모집단 분산
  const std = Math.sqrt(variance);

  return finiteOrNull((2 * mult * std) / mean);
}
