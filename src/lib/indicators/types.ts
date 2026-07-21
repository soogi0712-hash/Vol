/**
 * 기술적 지표 모듈 — 공통 타입
 * ─────────────────────────────────────────────────────────────
 * ■ 캔들 정렬: 모든 지표 함수의 입력 배열(캔들/종가/거래량)은
 *   반드시 "오래된 것 → 최신"(oldest-to-newest) 순서다.
 *   즉 배열의 마지막 원소가 가장 최근(현재) 캔들이다.
 *
 * ■ 완결봉만 사용: 형성 중인 최신 봉은 호출 전에 제거되어야 한다
 *   (trade-engine 의 confirmedCandles 와 동일 규칙).
 *
 * ■ 관찰/저장 전용: 이 모듈의 어떤 값도 매매 판단·주문·수량·손익
 *   로직에 사용되지 않는다. getBBSignal 입력/출력과 완전히 분리된다.
 *
 * ■ 데이터 부족 시 null 을 반환하며, NaN/Infinity 는 절대 산출하지 않는다.
 */

// 지표 계산용 최소 캔들 (kis-api 의 Candle 과 구조 호환)
export interface IndicatorCandle {
  datetime: string;   // YYYYMMDDHHMMSS
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// 유한한 숫자만 통과시킨다. NaN/±Infinity → null.
export function finiteOrNull(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

// 배열 전체가 유한한 숫자인지 확인
export function allFinite(values: readonly number[]): boolean {
  for (const v of values) if (!Number.isFinite(v)) return false;
  return true;
}

// 캔들 감지 패턴 플래그
export interface CandlePatternFlags {
  doji: boolean;
  longLeggedDoji: boolean;
  dragonflyDoji: boolean;
  gravestoneDoji: boolean;
  hammer: boolean;
  invertedHammer: boolean;
  shootingStar: boolean;
  bullishEngulfing: boolean;
  bearishEngulfing: boolean;
  bullishHarami: boolean;
  bearishHarami: boolean;
}

// MACD 결과
export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
  goldenCross: boolean;      // MACD 가 시그널을 상향 돌파
  deadCross: boolean;        // MACD 가 시그널을 하향 돌파
  histogramPositive: boolean;
}

// 거래량 결과
export interface VolumeResult {
  currentVolume: number;
  volumeSMA20: number;
  volumeRatio: number;       // current / sma20
  volumeSurge: boolean;      // ratio >= surge threshold
}

/**
 * 지표 스냅샷 — 한 종목의 한 완결봉 시점에 대한 관찰 데이터.
 * 값이 없으면(데이터 부족) null 로 저장된다.
 */
export interface IndicatorSnapshot {
  candleTimestamp: string;
  close: number;

  // 이력 상태 — 계산에 사용한 완결봉 수. EMA120 은 >=120 일 때만 채워진다.
  historyCount: number;

  // 이동평균 (지수)
  ema20: number | null;
  ema30: number | null;
  ema60: number | null;
  ema120: number | null;

  // MACD
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  macdGoldenCross: boolean;
  macdDeadCross: boolean;
  macdHistogramPositive: boolean;

  // 캔들 패턴
  patterns: CandlePatternFlags;

  // 거래량
  currentVolume: number | null;
  volumeSMA20: number | null;
  volumeRatio: number | null;
  volumeSurge: boolean;

  // 변동성/추세
  atr14: number | null;
  adx14: number | null;
  bollingerBandwidth: number | null;

  // EMA 정렬/위치
  emaBullishAlignment: boolean;   // ema20>ema30>ema60>ema120
  emaBearishAlignment: boolean;   // ema20<ema30<ema60<ema120
  priceAboveEma20: boolean | null;
  priceAboveEma30: boolean | null;
  priceAboveEma60: boolean | null;
  priceAboveEma120: boolean | null;
  ema30PullbackCandidate: boolean;
}
