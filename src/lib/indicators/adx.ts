/**
 * ADX (Average Directional Index) — Wilder 방식, 기본 기간 14
 * 입력 캔들은 오래된 것 → 최신 순서. 최소 2*period 개 미만이면 null.
 *
 * 모든 나눗셈은 분모 0 을 방어한다 (TR 합=0 또는 +DI/-DI 합=0 → 0 처리).
 * 결과는 0~100 범위의 유한값. NaN/Infinity 를 산출하지 않는다.
 */
import { finiteOrNull, type IndicatorCandle } from './types';

export function computeADX(candles: readonly IndicatorCandle[], period = 14): number | null {
  if (period <= 0 || candles.length < 2 * period) return null;
  for (const c of candles) {
    if (!Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close)) return null;
  }

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    tr.push(Math.max(hl, hc, lc));
  }

  const m = tr.length; // = candles.length - 1
  if (m < period) return null;

  // Wilder 평활 초기값 = 처음 period 개 합
  let smTR = 0, smPlus = 0, smMinus = 0;
  for (let i = 0; i < period; i++) { smTR += tr[i]; smPlus += plusDM[i]; smMinus += minusDM[i]; }

  const dx: number[] = [];
  const pushDX = () => {
    const plusDI = smTR > 0 ? 100 * (smPlus / smTR) : 0;
    const minusDI = smTR > 0 ? 100 * (smMinus / smTR) : 0;
    const diSum = plusDI + minusDI;
    const dxv = diSum > 0 ? 100 * (Math.abs(plusDI - minusDI) / diSum) : 0;
    dx.push(dxv);
  };
  pushDX(); // 첫 DX (인덱스 period-1 에 대응)

  for (let i = period; i < m; i++) {
    smTR = smTR - smTR / period + tr[i];
    smPlus = smPlus - smPlus / period + plusDM[i];
    smMinus = smMinus - smMinus / period + minusDM[i];
    pushDX();
  }

  if (dx.length < period) return null;

  // ADX = DX 의 Wilder 평균
  let adx = 0;
  for (let i = 0; i < period; i++) adx += dx[i];
  adx /= period;
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }

  return finiteOrNull(adx);
}
