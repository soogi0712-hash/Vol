/**
 * 거래량 지표 — 현재 거래량, 거래량 SMA20, 비율, 급증 플래그
 * 입력 캔들은 오래된 것 → 최신 순서. 데이터 부족 시 null.
 */
import { sma } from './ema';
import { finiteOrNull, type IndicatorCandle, type VolumeResult } from './types';

export function computeVolume(
  candles: readonly IndicatorCandle[],
  period = 20,
  surgeThreshold = 2,
): VolumeResult | null {
  if (candles.length < period) return null;

  const volumes = candles.map(c => c.volume);
  const current = finiteOrNull(volumes[volumes.length - 1]);
  const avg = sma(volumes, period);
  if (current === null || avg === null) return null;

  // 평균 거래량이 0 이면 비율 계산 불가 → null 반환
  if (avg <= 0) return null;

  const ratio = finiteOrNull(current / avg);
  if (ratio === null) return null;

  return {
    currentVolume: current,
    volumeSMA20: avg,
    volumeRatio: ratio,
    volumeSurge: ratio >= surgeThreshold,
  };
}
