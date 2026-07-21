/**
 * ATR (Average True Range) — Wilder 방식, 기본 기간 14
 * 입력 캔들은 오래된 것 → 최신 순서. period+1 개 미만이면 null.
 *
 * True Range(i) = max( high-low, |high-prevClose|, |low-prevClose| )
 * 첫 ATR = 처음 period 개 TR 의 단순평균, 이후 Wilder 평활:
 *   ATR = (이전ATR * (period-1) + TR) / period
 */
import { finiteOrNull, type IndicatorCandle } from './types';

function trueRange(cur: IndicatorCandle, prevClose: number): number {
  const hl = cur.high - cur.low;
  const hc = Math.abs(cur.high - prevClose);
  const lc = Math.abs(cur.low - prevClose);
  return Math.max(hl, hc, lc);
}

export function computeATR(candles: readonly IndicatorCandle[], period = 14): number | null {
  if (period <= 0 || candles.length < period + 1) return null;
  for (const c of candles) {
    if (!Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close)) return null;
  }

  // TR 시계열 (인덱스 1 부터 — 직전 종가 필요)
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(trueRange(candles[i], candles[i - 1].close));
  }
  if (trs.length < period) return null;

  // 첫 ATR = 처음 period 개 TR 평균
  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i];
  atr /= period;

  // Wilder 평활
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }

  return finiteOrNull(atr);
}
