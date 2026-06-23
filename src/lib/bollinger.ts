// 볼린저밴드 계산 라이브러리

export interface BollingerBand {
  upper: number;
  middle: number;
  lower: number;
  date: string;
  close: number;
}

export interface BollingerSignal {
  action: 'BUY' | 'SELL_MID' | 'SELL_UPPER' | 'NONE';
  reason: string;
  current: BollingerBand;
  prev: BollingerBand;
}

// 단순 이동평균
function sma(values: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
      continue;
    }
    const slice = values.slice(i - period + 1, i + 1);
    const avg = slice.reduce((s, v) => s + v, 0) / period;
    result.push(avg);
  }
  return result;
}

// 표준편차
function stddev(values: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
      continue;
    }
    const slice = values.slice(i - period + 1, i + 1);
    const avg = slice.reduce((s, v) => s + v, 0) / period;
    const variance = slice.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / period;
    result.push(Math.sqrt(variance));
  }
  return result;
}

/**
 * 볼린저밴드 계산
 * @param closes 종가 배열 (시간순 오름차순)
 * @param dates 날짜 배열
 * @param period 기간 (기본 20)
 * @param multiplier 표준편차 배수 (기본 2)
 */
export function calcBollingerBands(
  closes: number[],
  dates: string[],
  period: number = 20,
  multiplier: number = 2
): BollingerBand[] {
  const middles = sma(closes, period);
  const stds = stddev(closes, period);

  return closes.map((close, i) => ({
    date: dates[i],
    close,
    middle: middles[i],
    upper: middles[i] + multiplier * stds[i],
    lower: middles[i] - multiplier * stds[i],
  }));
}

/**
 * 볼린저밴드 매매 신호 판단
 *
 * 매수: 직전봉 종가 < 하단선 AND 현재봉 종가 >= 하단선
 * 1차 매도: 현재봉 종가 >= 중심선
 * 전량 매도: 현재봉 종가 >= 상단선
 *
 * @param bands 계산된 밴드 배열 (최소 2개 필요)
 * @param hasPosition 현재 보유 여부
 */
export function getBollingerSignal(
  bands: BollingerBand[],
  hasPosition: boolean
): BollingerSignal {
  if (bands.length < 2) {
    const dummy: BollingerBand = { upper: 0, middle: 0, lower: 0, date: '', close: 0 };
    return { action: 'NONE', reason: '데이터 부족', current: dummy, prev: dummy };
  }

  const prev = bands[bands.length - 2];
  const current = bands[bands.length - 1];

  // 유효성 확인
  if (isNaN(current.middle) || isNaN(prev.middle)) {
    return { action: 'NONE', reason: '볼린저밴드 계산 불가 (데이터 부족)', current, prev };
  }

  // 보유 중 → 매도 조건 먼저 확인
  if (hasPosition) {
    if (current.close >= current.upper) {
      return {
        action: 'SELL_UPPER',
        reason: `종가(${current.close.toFixed(0)}) >= 상단선(${current.upper.toFixed(0)}) → 전량 매도`,
        current,
        prev,
      };
    }
    if (current.close >= current.middle) {
      return {
        action: 'SELL_MID',
        reason: `종가(${current.close.toFixed(0)}) >= 중심선(${current.middle.toFixed(0)}) → 1차 매도`,
        current,
        prev,
      };
    }
    return {
      action: 'NONE',
      reason: `보유 중 대기 (종가: ${current.close.toFixed(0)}, 중심선: ${current.middle.toFixed(0)})`,
      current,
      prev,
    };
  }

  // 미보유 → 매수 조건 확인
  if (prev.close < prev.lower && current.close >= current.lower) {
    return {
      action: 'BUY',
      reason: `직전봉(${prev.close.toFixed(0)}) < 하단선(${prev.lower.toFixed(0)}) 이탈 후 현재봉(${current.close.toFixed(0)}) >= 하단선(${current.lower.toFixed(0)}) 복귀 → 매수`,
      current,
      prev,
    };
  }

  return {
    action: 'NONE',
    reason: `신호 없음 (종가: ${current.close.toFixed(0)}, 하단: ${current.lower.toFixed(0)}, 중심: ${current.middle.toFixed(0)}, 상단: ${current.upper.toFixed(0)})`,
    current,
    prev,
  };
}
