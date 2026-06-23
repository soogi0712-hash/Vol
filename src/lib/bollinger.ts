/**
 * 볼린저밴드 계산 엔진 v2
 * - 15분봉 기준
 * - 기간 20, 표준편차 2 (고정)
 * - 종가 기준
 *
 * ■ 매수: 직전봉 종가 < 하단선 AND 현재봉 종가 > 하단선
 * ■ 매도: 상단선 위에 있다가 → 상단선 아래로 내려오면 전량 매도
 *         (상단선 위에 있는 동안은 계속 보유)
 */

export interface BBand {
  datetime: string;
  close:    number;
  upper:    number;
  middle:   number;
  lower:    number;
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
