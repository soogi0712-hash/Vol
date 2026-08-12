// 역매공파 US 일봉 pool 순수로직 (P0-32F) — capacity 계산 / 캐시상태 분류 / 역배열 판정.
//   ⚠️ 전략/수식 무변경. 계산 최적화(계층화)일 뿐 원본 논리 불변. 주문 없음.
import { computeYeokmaeIndicators, YEOKMAE_MIN_BARS, YEOKMAE_RECOMMENDED_BARS, type Candle } from '../../src/lib/yeokmae';

// ── capacity/ETA ──
export interface HistoryCapacity {
  universe: number; cached: number; missing: number;
  callsNeeded: number; reqPerSec: number; etaSeconds: number; etaHuman: string;
}
export function computeHistoryCapacity(p: {
  universeCount: number; readyCount: number; workCount: number;   // work = missing+insufficient+stale (실제 fetch 대상)
  callsPerSymbol: number; minIntervalMs: number;
}): HistoryCapacity {
  const reqPerSec = p.minIntervalMs > 0 ? 1000 / p.minIntervalMs : 0;
  const callsNeeded = Math.max(0, p.workCount) * Math.max(1, p.callsPerSymbol);
  const etaSeconds = reqPerSec > 0 ? callsNeeded / reqPerSec : Infinity;
  return {
    universe: p.universeCount, cached: p.readyCount, missing: p.workCount,
    callsNeeded, reqPerSec: +reqPerSec.toFixed(3), etaSeconds: Math.round(etaSeconds), etaHuman: humanizeSec(etaSeconds),
  };
}
function humanizeSec(s: number): string {
  if (!Number.isFinite(s)) return '∞';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${sec}s` : `${sec}s`;
}

// ── 캐시 상태 분류 (resume/증분 판단) ──
export type CacheState = 'MISSING' | 'INSUFFICIENT' | 'STALE' | 'READY';
export function classifyUSCacheState(p: {
  confirmedCount: number; confirmedThrough: string | null; marketTodayYmd: string;   // 'YYYY-MM-DD'
  minConfirmed?: number; staleDays?: number;
}): CacheState {
  const min = p.minConfirmed ?? YEOKMAE_RECOMMENDED_BARS;   // 700 권장(최소 600 은 has600)
  const staleDays = p.staleDays ?? 3;
  if (p.confirmedCount <= 0) return 'MISSING';
  if (p.confirmedCount < min) return 'INSUFFICIENT';
  if (!p.confirmedThrough) return 'INSUFFICIENT';
  if (calDayDiff(p.confirmedThrough, p.marketTodayYmd) > staleDays) return 'STALE';
  return 'READY';
}
// 두 YYYY-MM-DD 사이 캘린더 일수차(a<b 가정, 음수면 0).
export function calDayDiff(aYmd: string, bYmd: string): number {
  const a = Date.UTC(+aYmd.slice(0, 4), +aYmd.slice(5, 7) - 1, +aYmd.slice(8, 10));
  const b = Date.UTC(+bYmd.slice(0, 4), +bYmd.slice(5, 7) - 1, +bYmd.slice(8, 10));
  return Math.max(0, Math.round((b - a) / 86400_000));
}
// fetch 대상인가(READY 아님).
export function needsFetch(state: CacheState): boolean { return state !== 'READY'; }

// ── 역배열 판정(1차 필터) — 확정봉 EMA112<=224<=448. 원본 조건 그대로(튜닝 아님). ──
export interface ReverseAlign { ready: boolean; reverse: boolean; bars: number; ema112: number; ema224: number; ema448: number; lastDate: string | null }
export function reverseAlignmentAt(confirmedCandles: readonly Candle[]): ReverseAlign {
  const bars = confirmedCandles.length;
  if (bars < YEOKMAE_MIN_BARS) return { ready: false, reverse: false, bars, ema112: NaN, ema224: NaN, ema448: NaN, lastDate: bars ? confirmedCandles[bars - 1].date : null };
  const I = computeYeokmaeIndicators(confirmedCandles);
  const i = bars - 1;
  const e112 = I.e4[i], e224 = I.e5[i], e448 = I.e6[i];
  const reverse = Number.isFinite(e112) && Number.isFinite(e224) && Number.isFinite(e448) && e112 <= e224 && e224 <= e448;
  return { ready: true, reverse, bars, ema112: e112, ema224: e224, ema448: e448, lastDate: confirmedCandles[i].date };
}

export { YEOKMAE_MIN_BARS, YEOKMAE_RECOMMENDED_BARS };
