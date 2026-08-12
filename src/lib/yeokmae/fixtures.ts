// 역매공파 결정적 시나리오 픽스처 (P0-32B) — 특정 sub-condition 을 재현하는 합성 일봉.
// ⚠️ 테스트/구조검증 전용. 실 HTS 신호 대조는 실 일봉으로만(합성 결과를 실측이라 주장하지 않는다).
import type { Candle } from './hts';

const mk = (i: number, o: number, h: number, l: number, c: number, v = 1_000_000): Candle =>
  ({ date: isoDate(i), open: +o.toFixed(2), high: +h.toFixed(2), low: +l.toFixed(2), close: +c.toFixed(2), volume: v });

// 결정적 날짜(2018-01-01 기준 i일). new Date 회피 위해 순수 계산.
function isoDate(i: number): string {
  const base = Date.UTC(2018, 0, 1);
  const d = new Date(base + i * 86400000);
  return d.toISOString().slice(0, 10);
}

// 600봉 미만 — INSUFFICIENT_HISTORY
export function insufficientSeries(n = 300): Candle[] {
  return Array.from({ length: n }, (_, i) => mk(i, 100, 101, 99, 100));
}

// 역배열(장기 하락) — EMA112<=224<=448<=600 성립 유도(단조 하락 640봉)
export function reverseAlignmentSeries(n = 640): Candle[] {
  return Array.from({ length: n }, (_, i) => { const p = 3000 - i * 1.5; return mk(i, p, p + 3, p - 3, p - 0.5); });
}

// 매집흔적 — 최근 50봉 내 고가가 전일종가/시가 대비 +12% 이상 튀는 봉 포함
export function accumulationSeries(n = 640): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const p = 2000 - i * 1.2;
    const spike = (i > n - 40 && i % 13 === 0);   // 최근 구간에 가끔 급등고가
    const h = spike ? p * 1.15 : p + 2;
    return mk(i, p, h, p - 2, p - 0.5);
  });
}

// 데이터 무결성 위반(high<close) — validator 가 잡아야 함
export function brokenSeries(): Candle[] {
  const s = reverseAlignmentSeries(605);
  s[600] = { ...s[600], high: s[600].low - 5 };   // high < low → 위반
  return s;
}

// 정상 640봉(범용) — 지표 warmup 충족
export function healthySeries(n = 720): Candle[] {
  return Array.from({ length: n }, (_, i) => { const p = 1500 + Math.sin(i / 11) * 40 + i * 0.05; return mk(i, p, p + 4, p - 4, p + Math.cos(i / 5) * 2); });
}
