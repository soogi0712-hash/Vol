/**
 * 지표 스냅샷 조립 — 여러 지표를 한 종목의 한 완결봉 시점 관찰 데이터로 묶는다.
 * ─────────────────────────────────────────────────────────────
 * 입력 캔들은 오래된 것 → 최신(oldest-to-newest) 순서, 완결봉만.
 * 현재봉 = 배열의 마지막 원소.
 *
 * look-ahead 없음:
 *   - buildIndicatorSnapshot 는 전달된 캔들 전체(과거~현재)만 사용한다.
 *   - computeSnapshotSeries(candles) 는 각 인덱스 N 에 대해 candles[0..N] 만
 *     넘겨 스냅샷을 계산한다 → 미래 캔들 정보가 절대 새지 않는다.
 *   - 크로스/패턴은 각 지표 내부에서 N, N-1 만 참조한다.
 *
 * 모든 수치는 유한하거나 null. 데이터 부족 지표는 null.
 */
import { emaValue } from './ema';
import { computeMACD } from './macd';
import { detectPatterns } from './candlestick';
import { computeVolume } from './volume';
import { computeATR } from './atr';
import { computeADX } from './adx';
import { computeBollingerBandwidth } from './bollinger-bandwidth';
import { finiteOrNull, type IndicatorCandle, type IndicatorSnapshot } from './types';

export interface SnapshotOptions {
  volumeSurgeThreshold?: number;   // 기본 2
  bbPeriod?: number;               // 기본 20
  bbStdDev?: number;               // 기본 2
}

function above(close: number, ema: number | null): boolean | null {
  return ema === null ? null : close > ema;
}

export function buildIndicatorSnapshot(
  candles: readonly IndicatorCandle[],
  opts: SnapshotOptions = {},
): IndicatorSnapshot | null {
  if (!candles || candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const close = finiteOrNull(last.close);
  if (close === null) return null;

  const closes = candles.map(c => c.close);

  const ema20 = emaValue(closes, 20);
  const ema30 = emaValue(closes, 30);
  const ema60 = emaValue(closes, 60);
  const ema120 = emaValue(closes, 120);

  const macd = computeMACD(closes);
  const vol = computeVolume(candles, 20, opts.volumeSurgeThreshold ?? 2);
  const atr14 = computeATR(candles, 14);
  const adx14 = computeADX(candles, 14);
  const bandwidth = computeBollingerBandwidth(
    closes, opts.bbPeriod ?? 20, opts.bbStdDev ?? 2,
  );

  const prev = candles.length >= 2 ? candles[candles.length - 2] : null;
  const patterns = detectPatterns(last, prev);

  // EMA 정렬 (모두 정의될 때만)
  const emaBullishAlignment =
    ema20 !== null && ema30 !== null && ema60 !== null && ema120 !== null &&
    ema20 > ema30 && ema30 > ema60 && ema60 > ema120;
  const emaBearishAlignment =
    ema20 !== null && ema30 !== null && ema60 !== null && ema120 !== null &&
    ema20 < ema30 && ema30 < ema60 && ema60 < ema120;

  // EMA30 눌림목 후보 (관찰용 휴리스틱):
  //   단기 상승세(ema20 > ema30) 중에 저가가 ema30 을 건드리되 종가는 그 위에서 마감,
  //   직전봉 종가도 ema30 위 → 지지 확인 후보. 매매에는 사용하지 않는다.
  let ema30PullbackCandidate = false;
  if (ema20 !== null && ema30 !== null && ema20 > ema30 && prev) {
    const touched = last.low <= ema30 * 1.005;
    const closedAbove = last.close >= ema30;
    const prevAbove = prev.close >= ema30;
    ema30PullbackCandidate = touched && closedAbove && prevAbove;
  }

  return {
    candleTimestamp: last.datetime,
    close,

    ema20, ema30, ema60, ema120,

    macd: macd?.macd ?? null,
    macdSignal: macd?.signal ?? null,
    macdHistogram: macd?.histogram ?? null,
    macdGoldenCross: macd?.goldenCross ?? false,
    macdDeadCross: macd?.deadCross ?? false,
    macdHistogramPositive: macd?.histogramPositive ?? false,

    patterns,

    currentVolume: vol?.currentVolume ?? null,
    volumeSMA20: vol?.volumeSMA20 ?? null,
    volumeRatio: vol?.volumeRatio ?? null,
    volumeSurge: vol?.volumeSurge ?? false,

    atr14,
    adx14,
    bollingerBandwidth: bandwidth,

    emaBullishAlignment,
    emaBearishAlignment,
    priceAboveEma20: above(close, ema20),
    priceAboveEma30: above(close, ema30),
    priceAboveEma60: above(close, ema60),
    priceAboveEma120: above(close, ema120),
    ema30PullbackCandidate,
  };
}

/**
 * 캔들 시계열 전체에 대해 look-ahead 없이 스냅샷을 계산한다.
 * 인덱스 N 의 스냅샷은 candles[0..N] 만 사용한다.
 * 반환 배열은 입력과 같은 길이이며, 계산 불가 시 해당 원소는 null.
 */
export function computeSnapshotSeries(
  candles: readonly IndicatorCandle[],
  opts: SnapshotOptions = {},
): (IndicatorSnapshot | null)[] {
  const out: (IndicatorSnapshot | null)[] = [];
  for (let n = 0; n < candles.length; n++) {
    out.push(buildIndicatorSnapshot(candles.slice(0, n + 1), opts));
  }
  return out;
}
