/**
 * MACD (기본 12, 26, 9)
 * 입력 closes 는 오래된 것 → 최신 순서. 데이터 부족 시 null.
 * 골든/데드 크로스는 최신 봉 N 과 직전 봉 N-1 만 사용한다.
 */
import { emaSeries } from './ema';
import { finiteOrNull, allFinite, type MACDResult } from './types';

export function computeMACD(
  closes: readonly number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MACDResult | null {
  // 시그널까지 완전히 정의되려면 최소 (slow + signalPeriod - 1) 개 필요
  if (closes.length < slow + signalPeriod - 1) return null;
  if (!allFinite(closes)) return null;

  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  if (!emaFast || !emaSlow) return null;

  // MACD 라인: fast/slow 둘 다 정의되는 slow-1 인덱스부터
  const macdCompact: number[] = [];
  for (let i = slow - 1; i < closes.length; i++) {
    macdCompact.push((emaFast[i] as number) - (emaSlow[i] as number));
  }

  const signalCompact = emaSeries(macdCompact, signalPeriod);
  if (!signalCompact) return null;

  const n = macdCompact.length;
  const macd = macdCompact[n - 1];
  const signal = signalCompact[n - 1] as number;
  const histogram = macd - signal;

  // 크로스: N 과 N-1 만 사용
  let goldenCross = false;
  let deadCross = false;
  if (n >= 2 && signalCompact[n - 2] != null) {
    const prevHist = macdCompact[n - 2] - (signalCompact[n - 2] as number);
    goldenCross = prevHist <= 0 && histogram > 0;
    deadCross = prevHist >= 0 && histogram < 0;
  }

  const mV = finiteOrNull(macd);
  const sV = finiteOrNull(signal);
  const hV = finiteOrNull(histogram);
  if (mV === null || sV === null || hV === null) return null;

  return {
    macd: mV,
    signal: sV,
    histogram: hV,
    goldenCross,
    deadCross,
    histogramPositive: hV > 0,
  };
}
