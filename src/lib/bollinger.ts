/**
 * 볼린저밴드 계산 엔진 v3
 * - 15분봉 기준
 * - 기간 20, 표준편차 2 (고정)
 * - 종가 기준
 *
 * ■ 매수: 직전봉 종가 < 하단선 AND 현재봉 종가 > 하단선
 * ■ 매도: 상단선 위에 있다가 → 상단선 아래로 내려오면 전량 매도
 *         (상단선 위에 있는 동안은 계속 보유)
 *
 * ■ 방어 로직 (validateCandleData)
 *   - 봉 수 30개 미만 → NO_DATA
 *   - 최근 20개 봉 종가 전부 동일 → NO_DATA (장마감 후 반복 봉)
 *   - 표준편차 0 → NO_DATA
 *   - BB폭 < 현재가 × 0.001 → NO_DATA (BB폭 너무 좁음)
 */

export interface BBand {
  datetime: string;
  close:    number;
  upper:    number;
  middle:   number;
  lower:    number;
}

// ─── 캔들 데이터 품질 검증 ─────────────────────────────────────
export interface CandleValidation {
  valid:   boolean;
  reason:  string;
  detail?: string;
}

/**
 * 15분봉 배열의 품질을 검증한다.
 * 모든 조건 통과 시 valid=true, 하나라도 실패하면 valid=false + reason 반환.
 *
 * @param closes   종가 배열 (오름차순, 최신이 마지막)
 * @param minCount 최소 봉 수 (기본 30)
 * @param checkLen 동일종가 검사 구간 (기본 20)
 * @param bbWidthThreshold BB폭 / 현재가 최소 비율 (기본 0.001 = 0.1%)
 */
export function validateCandleData(
  closes:             number[],
  minCount           = 30,
  checkLen           = 20,
  bbWidthThreshold   = 0.001
): CandleValidation {
  const n = closes.length;

  // 1. 봉 수 부족
  if (n < minCount) {
    return {
      valid:  false,
      reason: `봉 수 부족 (${n}개 < ${minCount}개)`,
      detail: `MIN_CANDLE`,
    };
  }

  // 2. 최근 checkLen개 봉 종가 전부 동일 (장마감 후 반복 봉)
  const recent = closes.slice(-checkLen);
  const allSame = recent.every(v => v === recent[0]);
  if (allSame) {
    return {
      valid:  false,
      reason: `최근 ${checkLen}봉 종가 동일 (${recent[0]}) — 장마감 후 반복 데이터`,
      detail: `FLAT_CANDLE`,
    };
  }

  // 3. 표준편차 0 (최근 20봉 기준)
  const mean = recent.reduce((s, v) => s + v, 0) / recent.length;
  const std  = Math.sqrt(recent.reduce((s, v) => s + (v - mean) ** 2, 0) / recent.length);
  if (std === 0) {
    return {
      valid:  false,
      reason: `표준편차 = 0 — 유효한 가격 변동 없음`,
      detail: `ZERO_STD`,
    };
  }

  // 4. BB폭 너무 좁음 (현재가 기준 0.1% 미만)
  // BB폭 = 4σ (upper - lower = 2×mult×std, mult=2 → 4σ)
  const currentClose = closes[n - 1];
  const bbWidth      = 4 * std;  // upper - lower ≈ 4σ (mult=2)
  if (currentClose > 0 && bbWidth < currentClose * bbWidthThreshold) {
    return {
      valid:  false,
      reason: `BB폭 너무 좁음 (폭 ${bbWidth.toFixed(4)} < 현재가 ${currentClose} × ${bbWidthThreshold})`,
      detail: `NARROW_BB`,
    };
  }

  return { valid: true, reason: 'OK' };
}

// 매수/매도 신호
export type SignalAction = 'BUY' | 'SELL' | 'HOLD' | 'NONE';

export interface BBSignal {
  action:       SignalAction;
  reason:       string;
  current:      BBand;
  prev:         BBand;
  above_upper:  boolean; // 현재봉이 상단선 위에 있는지
}

// ─── 볼린저밴드 계산 ─────────────────────────────────────────
export function calcBB(
  closes: number[],
  datetimes: string[],
  period = 20,
  mult   = 2
): BBand[] {
  const n = closes.length;
  const result: BBand[] = [];

  for (let i = 0; i < n; i++) {
    if (i < period - 1) {
      result.push({ datetime: datetimes[i], close: closes[i], upper: NaN, middle: NaN, lower: NaN });
      continue;
    }
    const slice = closes.slice(i - period + 1, i + 1);
    const mid   = slice.reduce((s, v) => s + v, 0) / period;
    const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mid) ** 2, 0) / period);
    result.push({
      datetime: datetimes[i],
      close:  closes[i],
      upper:  mid + mult * std,
      middle: mid,
      lower:  mid - mult * std,
    });
  }
  return result;
}

/**
 * 볼린저밴드 신호 판단
 *
 * @param bands      최근 봉 배열 (오름차순, 최소 2개)
 * @param hasPosition  현재 보유 중인지
 * @param aboveUpper   직전까지 상단선 위에 있었는지 (DB 플래그)
 */
export function getBBSignal(
  bands:        BBand[],
  hasPosition:  boolean,
  aboveUpper:   boolean   // holdings.above_upper
): BBSignal {
  const dummy: BBand = { datetime: '', close: 0, upper: 0, middle: 0, lower: 0 };
  if (bands.length < 2) return { action: 'NONE', reason: '데이터 부족', current: dummy, prev: dummy, above_upper: false };

  const prev    = bands[bands.length - 2];
  const current = bands[bands.length - 1];

  if (isNaN(current.upper) || isNaN(prev.upper))
    return { action: 'NONE', reason: 'BB 계산 불가 (데이터 부족)', current, prev, above_upper: false };

  const nowAbove = current.close > current.upper;

  // ── 보유 중 ──────────────────────────────────────────────
  if (hasPosition) {
    // 상단선 돌파 → 계속 보유, 플래그 갱신
    if (nowAbove) {
      return {
        action: 'HOLD',
        reason: `상단선 위 보유 중 (종가 ${fmt(current.close)} > 상단선 ${fmt(current.upper)})`,
        current, prev, above_upper: true,
      };
    }
    // 상단선 위에 있다가 → 아래로 내려오면 전량 매도
    if (aboveUpper && !nowAbove) {
      return {
        action: 'SELL',
        reason: `상단선(${fmt(current.upper)}) 돌파 후 하락 → 전량 매도 (종가 ${fmt(current.close)})`,
        current, prev, above_upper: false,
      };
    }
    // 아직 상단선 위에 도달한 적 없음 → 대기
    return {
      action: 'HOLD',
      reason: `보유 대기 (종가 ${fmt(current.close)}, 상단선 ${fmt(current.upper)}, 상단돌파 여부: ${aboveUpper})`,
      current, prev, above_upper: aboveUpper,
    };
  }

  // ── 미보유 → 매수 조건 ──────────────────────────────────
  // 직전봉 < 하단선 AND 현재봉 > 하단선
  if (prev.close < prev.lower && current.close > current.lower) {
    return {
      action: 'BUY',
      reason: `하단선 이탈(${fmt(prev.close)}<${fmt(prev.lower)}) 후 복귀(${fmt(current.close)}>${fmt(current.lower)}) → 매수`,
      current, prev, above_upper: false,
    };
  }

  return {
    action: 'NONE',
    reason: `신호없음 (종가 ${fmt(current.close)} | 하단 ${fmt(current.lower)} | 상단 ${fmt(current.upper)})`,
    current, prev, above_upper: false,
  };
}

function fmt(n: number): string {
  return isNaN(n) ? '-' : n.toFixed(2);
}

/**
 * 백테스트용 신호 계산 (전체 배열 순회)
 * above_upper 플래그를 순회하며 직접 관리
 */
export interface BacktestTrade {
  buy_datetime:  string;
  sell_datetime: string;
  buy_price:     number;
  sell_price:    number;
  qty:           number;
  profit_loss:   number;
  return_rate:   number;
}

export function runBacktest(
  bands:       BBand[],
  buyAmount:   number,  // 1회 매수 금액
  feeRate = 0.00015     // 수수료율 (0.015%)
): { trades: BacktestTrade[]; final_above_upper: boolean } {
  const trades: BacktestTrade[] = [];
  let inPosition   = false;
  let buyPrice     = 0;
  let buyQty       = 0;
  let buyDatetime  = '';
  let aboveUpper   = false;

  for (let i = 1; i < bands.length; i++) {
    const prev    = bands[i - 1];
    const current = bands[i];
    if (isNaN(current.upper)) continue;

    const nowAbove = current.close > current.upper;

    if (!inPosition) {
      if (prev.close < prev.lower && current.close > current.lower) {
        buyQty      = Math.floor(buyAmount / current.close);
        if (buyQty < 1) continue;
        buyPrice    = current.close * (1 + feeRate);
        buyDatetime = current.datetime;
        inPosition  = true;
        aboveUpper  = false;
      }
    } else {
      if (nowAbove) {
        aboveUpper = true;
      } else if (aboveUpper && !nowAbove) {
        const sellPrice = current.close * (1 - feeRate);
        const pl  = (sellPrice - buyPrice) * buyQty;
        const ret = (sellPrice - buyPrice) / buyPrice * 100;
        trades.push({
          buy_datetime:  buyDatetime,
          sell_datetime: current.datetime,
          buy_price:     parseFloat(buyPrice.toFixed(4)),
          sell_price:    parseFloat(sellPrice.toFixed(4)),
          qty:           buyQty,
          profit_loss:   parseFloat(pl.toFixed(2)),
          return_rate:   parseFloat(ret.toFixed(4)),
        });
        inPosition = false; aboveUpper = false;
      }
    }
  }
  return { trades, final_above_upper: aboveUpper };
}
