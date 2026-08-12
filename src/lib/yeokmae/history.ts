// 역매공파 일봉 데이터 파이프라인 순수로직 (P0-32B) — field-map/pagination/readiness/integrity/adjustment.
// ⚠️ LS 실제 TR 필드/enum/continuation 은 probe 전까지 미확정 → 모두 fail-closed. 추측 하드코딩 금지.
import type { Candle } from './hts';
import { YEOKMAE_MIN_BARS } from './types';

// ── 수정주가 상태 ──
export type AdjustmentStatus = 'UNKNOWN' | 'RAW' | 'ADJUSTED';

// ── 일봉 필드 매핑(probe 후 채움) — null 이면 미확정 → fetcher fail-closed ──
export interface DailyFieldMap {
  date: string | null;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  volume: string | null;
  turnover: string | null;   // 거래대금(공식 제공 시). 없으면 null(선택)
}
export const EMPTY_DAILY_FIELD_MAP: DailyFieldMap = { date: null, open: null, high: null, low: null, close: null, volume: null, turnover: null };
// 필수 필드(turnover 제외)가 모두 지정돼야 확정.
export function isFieldMapConfirmed(m: DailyFieldMap): boolean {
  return !!(m.date && m.open && m.high && m.low && m.close && m.volume);
}

// ── continuation(pagination) 전략 — probe 후 하나만 활성. 기본 미확정(추측 고정 금지). ──
export type PaginationStrategy = 'HEADER_CONT' | 'BODY_CURSOR' | 'DATE_WINDOW' | 'FIXED_PAGE' | 'NONE' | 'UNCONFIRMED';

// raw 행 배열 + 필드맵 → 정규화 일봉. 필드맵 미확정이면 실패(fail-closed). YYYYMMDD/YYYY-MM-DD 모두 허용.
export interface NormalizeResult { ok: boolean; error?: string; candles: DailyBarNorm[]; }
export interface DailyBarNorm { date: string; open: number; high: number; low: number; close: number; volume: number; turnover: number | null }
const toNum = (v: unknown): number => { const n = parseFloat(String(v ?? '').trim()); return Number.isFinite(n) ? n : NaN; };
export function normalizeDailyRows(rawRows: readonly any[], map: DailyFieldMap): NormalizeResult {
  if (!isFieldMapConfirmed(map)) return { ok: false, error: 'DAILY_FIELD_MAP_UNCONFIRMED', candles: [] };
  const candles: DailyBarNorm[] = [];
  for (const r of rawRows) {
    const rawDate = String(r[map.date!] ?? '').trim();
    const date = /^\d{8}$/.test(rawDate) ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}` : rawDate;
    candles.push({
      date,
      open: toNum(r[map.open!]), high: toNum(r[map.high!]), low: toNum(r[map.low!]),
      close: toNum(r[map.close!]), volume: toNum(r[map.volume!]),
      turnover: map.turnover ? (Number.isFinite(toNum(r[map.turnover])) ? toNum(r[map.turnover]) : null) : null,
    });
  }
  return { ok: true, candles };
}

// ── 거래대금 raw value 단위 실측 추정 (P0-32C) ──
//   LS KR value 필드 단위 미공표 → close×volume(원) 대비 raw 비율의 중앙값으로 배수를 실측 추정(단정 금지).
//   예: close 61,400 × volume 20,213,724 = 1.241e12원, value=1,243,103 → 비율≈998,406 ≈ 1e6 → '백만원' 추정.
export interface TurnoverUnitEstimate { samples: number; medianMultiplier: number | null; guessLabel: string }
export function estimateTurnoverUnit(bars: readonly { close: number; volume: number; rawTurnover?: number | null }[]): TurnoverUnitEstimate {
  const ratios: number[] = [];
  for (const b of bars) {
    const raw = b.rawTurnover;
    if (raw == null || !Number.isFinite(raw) || raw <= 0) continue;
    const notional = b.close * b.volume;   // 원 단위(KR)
    if (!Number.isFinite(notional) || notional <= 0) continue;
    ratios.push(notional / raw);
  }
  if (ratios.length === 0) return { samples: 0, medianMultiplier: null, guessLabel: 'UNKNOWN' };
  ratios.sort((a, b) => a - b);
  const mid = ratios[Math.floor(ratios.length / 2)];
  // 가장 가까운 10의 거듭제곱으로 라벨링(실측 근사) — 정확 단위는 공식 미확인이라 라벨은 추정.
  const label = mid >= 5e5 && mid < 5e6 ? 'MILLION_KRW(백만원)_추정'
    : mid >= 5e2 && mid < 5e3 ? 'THOUSAND_KRW(천원)_추정'
    : mid >= 0.5 && mid < 5 ? 'KRW(원)_추정'
    : `x${mid.toPrecision(3)}_미상`;
  return { samples: ratios.length, medianMultiplier: mid, guessLabel: label };
}

// ── 일봉 무결성 검사 — 실데이터 즉시 검증. 잘못된 데이터는 signal 계산 금지. ──
export interface IntegrityResult { valid: boolean; errors: string[]; warnings: string[] }
export function validateDailyIntegrity(bars: readonly { date: string; open: number; high: number; low: number; close: number; volume: number }[]): IntegrityResult {
  const errors: string[] = []; const warnings: string[] = [];
  const seen = new Set<string>();
  let prevDate = '';
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const vals = [b.open, b.high, b.low, b.close, b.volume];
    if (vals.some(v => !Number.isFinite(v))) { errors.push(`NaN@${b.date}`); continue; }
    if (b.volume < 0) errors.push(`volume<0@${b.date}`);
    if (!(b.high >= Math.max(b.open, b.close, b.low))) errors.push(`high<max(o,c,l)@${b.date}`);
    if (!(b.low <= Math.min(b.open, b.close, b.high))) errors.push(`low>min(o,c,h)@${b.date}`);
    if (b.open <= 0 || b.high <= 0 || b.low <= 0 || b.close <= 0) errors.push(`zero/negative OHLC@${b.date}`);
    if (seen.has(b.date)) errors.push(`dup date@${b.date}`); seen.add(b.date);
    if (prevDate && b.date < prevDate) errors.push(`out-of-order@${b.date}(<${prevDate})`);
    // 비정상 갭(전일 대비 ±60% 초과)은 경고만 — 수정주가/이벤트 가능.
    if (i > 0) { const p = bars[i - 1].close; if (p > 0) { const chg = Math.abs(b.close - p) / p; if (chg > 0.6) warnings.push(`gap>60%@${b.date}(${(chg * 100).toFixed(0)}%)`); } }
    prevDate = b.date;
  }
  return { valid: errors.length === 0, errors, warnings };
}

// ── history readiness — 600봉 미만 무조건 false, 700+ 권장 quality flag ──
export const YEOKMAE_RECOMMENDED_BARS = 700;
export interface HistoryReadiness {
  totalBars: number; confirmedBars: number; has600: boolean; hasWarmup: boolean;
  firstDate: string | null; lastDate: string | null; sufficient: boolean; reason: string;
}
export function evaluateYeokmaeHistoryReadiness(candles: readonly Candle[], confirmedThrough?: string | null): HistoryReadiness {
  const total = candles.length;
  const confirmedBars = confirmedThrough ? candles.filter(c => c.date <= confirmedThrough).length : total;
  const has600 = confirmedBars >= YEOKMAE_MIN_BARS;
  const hasWarmup = confirmedBars >= YEOKMAE_RECOMMENDED_BARS;
  const first = total ? candles[0].date : null;
  const last = total ? candles[total - 1].date : null;
  const sufficient = has600;   // 600 미만 무조건 false
  const reason = has600 ? (hasWarmup ? 'OK' : 'OK_LOW_WARMUP') : 'INSUFFICIENT_HISTORY';
  return { totalBars: total, confirmedBars, has600, hasWarmup, firstDate: first, lastDate: last, sufficient, reason };
}
