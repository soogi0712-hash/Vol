/**
 * 캔들스틱 패턴 감지
 * ─────────────────────────────────────────────────────────────
 * 단일봉 패턴은 현재 완결봉만, 2봉 패턴(장악형/잉태형)은 현재+직전 완결봉만
 * 사용한다 (look-ahead 없음). range(고가-저가)=0 이면 판정 불가 → 모두 false.
 *
 * 임계값(문서화):
 *   doji           : 몸통 ≤ range * 10%
 *   long-legged    : doji + 위/아래 그림자 각각 ≥ range * 30%
 *   dragonfly      : doji + 아래그림자 ≥ range * 60% + 위그림자 ≤ range * 10%
 *   gravestone     : doji + 위그림자 ≥ range * 60% + 아래그림자 ≤ range * 10%
 *   hammer         : 아래그림자 ≥ 몸통 * 2, 위그림자 ≤ 몸통 (비-doji)
 *   inverted hammer: 위그림자 ≥ 몸통 * 2, 아래그림자 ≤ 몸통, 양봉(close≥open)
 *   shooting star  : 위그림자 ≥ 몸통 * 2, 아래그림자 ≤ 몸통, 음봉(close<open)
 *   engulfing      : 직전 몸통을 현재 몸통이 완전히 감쌈 + 색 반전
 *   harami         : 직전 몸통 안에 현재 몸통이 포함 + 색 반전
 */
import type { IndicatorCandle, CandlePatternFlags } from './types';

const NONE: CandlePatternFlags = {
  doji: false, longLeggedDoji: false, dragonflyDoji: false, gravestoneDoji: false,
  hammer: false, invertedHammer: false, shootingStar: false,
  bullishEngulfing: false, bearishEngulfing: false,
  bullishHarami: false, bearishHarami: false,
};

function valid(c: IndicatorCandle): boolean {
  return Number.isFinite(c.open) && Number.isFinite(c.high)
    && Number.isFinite(c.low) && Number.isFinite(c.close)
    && c.high >= c.low;
}

/**
 * 현재 캔들(curr)과 선택적 직전 캔들(prev)로 패턴 플래그를 계산한다.
 * prev 가 없으면 2봉 패턴은 false.
 */
export function detectPatterns(
  curr: IndicatorCandle,
  prev?: IndicatorCandle | null,
): CandlePatternFlags {
  if (!valid(curr)) return { ...NONE };

  const range = curr.high - curr.low;
  if (range <= 0) return { ...NONE }; // 변동 없음 → 판정 불가

  const body = Math.abs(curr.close - curr.open);
  const upper = curr.high - Math.max(curr.open, curr.close);
  const lower = Math.min(curr.open, curr.close) - curr.low;
  const bullish = curr.close >= curr.open;

  const isDoji = body <= range * 0.1;
  const longLegged = isDoji && upper >= range * 0.3 && lower >= range * 0.3;
  const dragonfly = isDoji && lower >= range * 0.6 && upper <= range * 0.1;
  const gravestone = isDoji && upper >= range * 0.6 && lower <= range * 0.1;

  // 해머/역해머/유성 — 몸통이 있어야 함(비-doji)
  const hasBody = !isDoji && body > 0;
  const hammer = hasBody && lower >= body * 2 && upper <= body;
  const invertedShape = hasBody && upper >= body * 2 && lower <= body;
  const invertedHammer = invertedShape && bullish;
  const shootingStar = invertedShape && !bullish;

  const flags: CandlePatternFlags = {
    doji: isDoji,
    longLeggedDoji: longLegged,
    dragonflyDoji: dragonfly,
    gravestoneDoji: gravestone,
    hammer,
    invertedHammer,
    shootingStar,
    bullishEngulfing: false,
    bearishEngulfing: false,
    bullishHarami: false,
    bearishHarami: false,
  };

  if (prev && valid(prev)) {
    const pBull = prev.close > prev.open;
    const pBear = prev.close < prev.open;
    const cBull = curr.close > curr.open;
    const cBear = curr.close < curr.open;
    const pTop = Math.max(prev.open, prev.close);
    const pBot = Math.min(prev.open, prev.close);
    const cTop = Math.max(curr.open, curr.close);
    const cBot = Math.min(curr.open, curr.close);

    // 장악형: 직전 몸통을 현재 몸통이 완전히 감쌈 + 색 반전
    flags.bullishEngulfing = pBear && cBull && cBot <= pBot && cTop >= pTop && body > 0;
    flags.bearishEngulfing = pBull && cBear && cBot <= pBot && cTop >= pTop && body > 0;

    // 잉태형: 직전 몸통 안에 현재 몸통이 포함 + 색 반전 (직전 몸통이 더 큼)
    const insidePrev = cTop <= pTop && cBot >= pBot;
    const prevBodySize = Math.abs(prev.close - prev.open);
    flags.bullishHarami = pBear && cBull && insidePrev && prevBodySize > body;
    flags.bearishHarami = pBull && cBear && insidePrev && prevBodySize > body;
  }

  return flags;
}
