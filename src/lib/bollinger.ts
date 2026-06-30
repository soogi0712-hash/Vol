/**
 * 볼린저밴드 + RSI 계산 엔진 v4
 * ─────────────────────────────────────────────────────────────
 * - 15분봉 기준
 * - 볼린저밴드: 기간 20, 표준편차 2 (고정)
 * - RSI: 기간 14 (고정)
 * - 종가 기준
 *
 * ■ 매수 조건 (4개 AND):
 *   ① 직전봉 종가 < 직전 볼린저 하단선
 *   ② 현재봉 종가 > 현재 볼린저 하단선  (하단선 복귀)
 *   ③ 현재 RSI ≤ 35
 *   ④ 현재 RSI > 이전 RSI              (RSI 상승 전환)
 *
 * ■ 매도 조건:
 *   - 상단선 위에 있다가 → 상단선 아래로 내려오면 전량 매도
 *   - 상단선 위에 있는 동안은 계속 보유
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
  action:              SignalAction;
  reason:              string;
  current:             BBand;
  prev:                BBand;
  above_upper:         boolean;   // 현재봉이 상단선 위에 있는지
  // ─── RSI 관련 필드 ───────────────────────────────────────
  rsi_current:         number;    // 현재봉 RSI (NaN = 계산 불가)
  rsi_prev:            number;    // 직전봉 RSI (NaN = 계산 불가)
  rsi_rising:          boolean;   // 현재 RSI > 이전 RSI
  bb_lower_recovery:   boolean;   // 직전봉 < 하단선 AND 현재봉 > 하단선
  // ─── 매수 조건 충족 여부 (각 조건별) ────────────────────
  buy_conditions: {
    prev_below_lower:  boolean;   // ① 직전봉 < 하단선
    curr_above_lower:  boolean;   // ② 현재봉 > 하단선
    rsi_le_35:         boolean;   // ③ RSI ≤ 35
    rsi_rising:        boolean;   // ④ RSI 상승
    all_met:           boolean;   // 4개 모두 충족
  };
  fail_reasons: string[];         // 미충족 조건 설명 목록
}

// ─── RSI 계산 ─────────────────────────────────────────────────
/**
 * RSI(n) 계산
 * Wilder 평활 방식 (EMA 기반)
 *
 * @param closes  종가 배열 (오름차순, 최신이 마지막)
 * @param period  RSI 기간 (기본 14)
 * @returns       closes와 같은 길이의 RSI 배열 (초기 period개 = NaN)
 */
export function calcRSI(closes: number[], period = 14): number[] {
  const n = closes.length;
  const rsi = new Array<number>(n).fill(NaN);

  if (n < period + 1) return rsi; // 데이터 부족

  // 초기 평균 gain/loss (첫 period개 변화량)
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else          avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  // period번째 인덱스 RSI
  const rs0 = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs0);

  // period+1부터 Wilder 평활 (지수이동평균)
  for (let i = period + 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
  }

  return rsi;
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
 * 볼린저밴드 + RSI 신호 판단
 *
 * @param bands      최근 봉 배열 (오름차순, 최소 2개)
 * @param hasPosition  현재 보유 중인지
 * @param aboveUpper   직전까지 상단선 위에 있었는지 (DB 플래그)
 * @param rsiValues    calcRSI() 결과 배열 (bands와 같은 길이, 없으면 빈 배열)
 */
export function getBBSignal(
  bands:        BBand[],
  hasPosition:  boolean,
  aboveUpper:   boolean,   // holdings.above_upper
  rsiValues:    number[] = []
): BBSignal {
  const RSI_THRESHOLD = 35; // RSI 매수 임계값

  const dummy: BBand = { datetime: '', close: 0, upper: 0, middle: 0, lower: 0 };
  const dummySignal = (reason: string): BBSignal => ({
    action: 'NONE', reason, current: dummy, prev: dummy, above_upper: false,
    rsi_current: NaN, rsi_prev: NaN, rsi_rising: false, bb_lower_recovery: false,
    buy_conditions: { prev_below_lower: false, curr_above_lower: false, rsi_le_35: false, rsi_rising: false, all_met: false },
    fail_reasons: [reason],
  });

  if (bands.length < 2) return dummySignal('데이터 부족');

  const prev    = bands[bands.length - 2];
  const current = bands[bands.length - 1];

  if (isNaN(current.upper) || isNaN(prev.upper))
    return dummySignal('BB 계산 불가 (데이터 부족)');

  // RSI 값 추출
  const rsiCurrent = rsiValues.length >= bands.length
    ? rsiValues[rsiValues.length - 1]
    : NaN;
  const rsiPrev = rsiValues.length >= bands.length
    ? rsiValues[rsiValues.length - 2]
    : NaN;
  const rsiRising = !isNaN(rsiCurrent) && !isNaN(rsiPrev) && rsiCurrent > rsiPrev;

  const nowAbove = current.close > current.upper;

  // ── 보유 중 ──────────────────────────────────────────────
  if (hasPosition) {
    // 상단선 돌파 → 계속 보유, 플래그 갱신
    if (nowAbove) {
      return {
        action: 'HOLD',
        reason: `상단선 위 보유 중 (종가 ${fmt(current.close)} > 상단선 ${fmt(current.upper)})`,
        current, prev, above_upper: true,
        rsi_current: rsiCurrent, rsi_prev: rsiPrev, rsi_rising: rsiRising,
        bb_lower_recovery: prev.close < prev.lower && current.close > current.lower,
        buy_conditions: { prev_below_lower: false, curr_above_lower: false, rsi_le_35: false, rsi_rising: false, all_met: false },
        fail_reasons: [],
      };
    }
    // 상단선 위에 있다가 → 아래로 내려오면 전량 매도
    if (aboveUpper && !nowAbove) {
      return {
        action: 'SELL',
        reason: `상단선(${fmt(current.upper)}) 돌파 후 하락 → 전량 매도 (종가 ${fmt(current.close)})`,
        current, prev, above_upper: false,
        rsi_current: rsiCurrent, rsi_prev: rsiPrev, rsi_rising: rsiRising,
        bb_lower_recovery: false,
        buy_conditions: { prev_below_lower: false, curr_above_lower: false, rsi_le_35: false, rsi_rising: false, all_met: false },
        fail_reasons: [],
      };
    }
    // 아직 상단선 위에 도달한 적 없음 → 대기
    return {
      action: 'HOLD',
      reason: `보유 대기 (종가 ${fmt(current.close)}, 상단선 ${fmt(current.upper)}, 상단돌파 여부: ${aboveUpper})`,
      current, prev, above_upper: aboveUpper,
      rsi_current: rsiCurrent, rsi_prev: rsiPrev, rsi_rising: rsiRising,
      bb_lower_recovery: false,
      buy_conditions: { prev_below_lower: false, curr_above_lower: false, rsi_le_35: false, rsi_rising: false, all_met: false },
      fail_reasons: [],
    };
  }

  // ── 미보유 → 매수 조건 4개 판정 ────────────────────────
  const c1 = prev.close < prev.lower;                              // ① 직전봉 < 하단선
  const c2 = current.close > current.lower;                       // ② 현재봉 > 하단선 (하단선 복귀)
  const c3 = !isNaN(rsiCurrent) && rsiCurrent <= RSI_THRESHOLD;   // ③ RSI ≤ 35
  const c4 = rsiRising;                                            // ④ RSI 상승

  const allMet  = c1 && c2 && c3 && c4;
  const bbLowerRecovery = c1 && c2;

  const failReasons: string[] = [];
  if (!c1) failReasons.push(`하단선 이탈 미충족 (직전봉 ${fmt(prev.close)} ≥ 하단선 ${fmt(prev.lower)})`);
  if (!c2) failReasons.push(`하단선 복귀 미충족 (현재봉 ${fmt(current.close)} ≤ 하단선 ${fmt(current.lower)})`);
  if (!c3) {
    if (isNaN(rsiCurrent)) failReasons.push(`RSI 계산 불가 (데이터 부족)`);
    else failReasons.push(`RSI 조건 미충족 (현재 RSI ${fmtRSI(rsiCurrent)} > ${RSI_THRESHOLD})`);
  }
  if (!c4) {
    if (isNaN(rsiCurrent) || isNaN(rsiPrev)) failReasons.push(`RSI 상승 확인 불가`);
    else failReasons.push(`RSI 하락 중 (현재 ${fmtRSI(rsiCurrent)} ≤ 이전 ${fmtRSI(rsiPrev)})`);
  }

  if (allMet) {
    return {
      action: 'BUY',
      reason: `BB하단복귀(${fmt(prev.close)}<${fmt(prev.lower)}→${fmt(current.close)}>${fmt(current.lower)}) RSI(${fmtRSI(rsiPrev)}→${fmtRSI(rsiCurrent)}≤${RSI_THRESHOLD}) → 매수`,
      current, prev, above_upper: false,
      rsi_current: rsiCurrent, rsi_prev: rsiPrev, rsi_rising: rsiRising,
      bb_lower_recovery: bbLowerRecovery,
      buy_conditions: { prev_below_lower: c1, curr_above_lower: c2, rsi_le_35: c3, rsi_rising: c4, all_met: true },
      fail_reasons: [],
    };
  }

  // 신호 없음 — 어떤 조건이 미충족인지 포함
  const metCount = [c1, c2, c3, c4].filter(Boolean).length;
  return {
    action: 'NONE',
    reason: `신호없음 (${metCount}/4 조건 충족) — ${failReasons.join('; ')}`,
    current, prev, above_upper: false,
    rsi_current: rsiCurrent, rsi_prev: rsiPrev, rsi_rising: rsiRising,
    bb_lower_recovery: bbLowerRecovery,
    buy_conditions: { prev_below_lower: c1, curr_above_lower: c2, rsi_le_35: c3, rsi_rising: c4, all_met: false },
    fail_reasons: failReasons,
  };
}

function fmt(n: number): string {
  return isNaN(n) ? '-' : n.toFixed(2);
}

function fmtRSI(n: number): string {
  return isNaN(n) ? '-' : n.toFixed(1);
}

/**
 * 백테스트용 신호 계산 (전체 배열 순회)
 * above_upper 플래그를 순회하며 직접 관리
 * RSI 조건 (≤35 AND 상승) 포함
 */
export interface BacktestTrade {
  buy_datetime:  string;
  sell_datetime: string;
  buy_price:     number;
  sell_price:    number;
  qty:           number;
  profit_loss:   number;
  return_rate:   number;
  buy_rsi:       number;   // 매수 시점 RSI
}

export function runBacktest(
  bands:       BBand[],
  buyAmount:   number,  // 1회 매수 금액
  feeRate = 0.00015,    // 수수료율 (0.015%)
  rsiValues: number[] = []  // calcRSI() 결과 (bands와 같은 길이)
): { trades: BacktestTrade[]; final_above_upper: boolean } {
  const RSI_THRESHOLD = 35;
  const trades: BacktestTrade[] = [];
  let inPosition   = false;
  let buyPrice     = 0;
  let buyQty       = 0;
  let buyDatetime  = '';
  let buyRsi       = NaN;
  let aboveUpper   = false;

  for (let i = 1; i < bands.length; i++) {
    const prev    = bands[i - 1];
    const current = bands[i];
    if (isNaN(current.upper)) continue;

    const nowAbove   = current.close > current.upper;
    const rsiCurr    = rsiValues.length > i ? rsiValues[i]     : NaN;
    const rsiPrev    = rsiValues.length > i ? rsiValues[i - 1] : NaN;
    const rsiRising  = !isNaN(rsiCurr) && !isNaN(rsiPrev) && rsiCurr > rsiPrev;

    if (!inPosition) {
      // 매수 조건 4개 AND
      const c1 = prev.close < prev.lower;
      const c2 = current.close > current.lower;
      const c3 = !isNaN(rsiCurr) && rsiCurr <= RSI_THRESHOLD;
      const c4 = rsiRising;

      if (c1 && c2 && c3 && c4) {
        buyQty      = Math.floor(buyAmount / current.close);
        if (buyQty < 1) continue;
        buyPrice    = current.close * (1 + feeRate);
        buyDatetime = current.datetime;
        buyRsi      = rsiCurr;
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
          buy_rsi:       parseFloat(buyRsi.toFixed(2)),
        });
        inPosition = false; aboveUpper = false;
      }
    }
  }
  return { trades, final_above_upper: aboveUpper };
}
