// 역매공파 과거시점 스캐너 + 원자료(46/57) 비교 하네스 (P0-32B). 실데이터 있을 때만 실측. 튜닝으로 숫자 맞추기 금지.
import type { Candle } from './hts';
import { evaluateYeokmaeMatch, type YeokmaeMatch } from './index';
import type { YeokmaeMarketFlags, YeokmaeSearcherOpts } from './searcher';
import { evaluateYeokmaeHistoryReadiness } from './history';
import { YEOKMAE_MIN_BARS } from './types';

// 특정 date(YYYY-MM-DD) 기준 한 종목 평가 — 그 날짜까지의 일봉만 사용(look-ahead 금지).
export interface ScanUniverseEntry { symbol: string; candles: Candle[]; flags: YeokmaeMarketFlags; searcherOpts?: YeokmaeSearcherOpts }
export interface ScanAtDateResult {
  date: string;
  evaluated: number; insufficient: number;
  searcherPass: string[];               // 검색기 통과 종목
  signalMatch: Record<string, string[]>; // 신호별 매치 종목
  perSymbol: Array<{ symbol: string; ready: boolean; match: YeokmaeMatch | null; reason: string }>;
}
export function scanYeokmaeAtDate(universe: readonly ScanUniverseEntry[], date: string): ScanAtDateResult {
  const searcherPass: string[] = [];
  const signalMatch: Record<string, string[]> = { '112_ORIGINAL': [], '224_ORIGINAL': [], '112_UPGRADE': [], '224_UPGRADE': [], 'LONG_TERM': [] };
  const perSymbol: ScanAtDateResult['perSymbol'] = [];
  let insufficient = 0; let evaluated = 0;
  for (const u of universe) {
    const upto = u.candles.filter(c => c.date <= date);   // date 까지만(미래 금지)
    const ready = evaluateYeokmaeHistoryReadiness(upto);
    if (!ready.sufficient) { insufficient++; perSymbol.push({ symbol: u.symbol, ready: false, match: null, reason: 'INSUFFICIENT_HISTORY' }); continue; }
    evaluated++;
    const m = evaluateYeokmaeMatch(u.symbol, upto, u.flags, u.searcherOpts);
    if (m.searcherPass) searcherPass.push(u.symbol);
    for (const t of m.signals) signalMatch[t]?.push(u.symbol);
    perSymbol.push({ symbol: u.symbol, ready: true, match: m, reason: m.searcherPass ? 'SEARCHER_PASS' : 'SEARCHER_FAIL' });
  }
  return { date, evaluated, insufficient, searcherPass, signalMatch, perSymbol };
}

// 원자료 대비 결과 종목수 비교 — 차이의 '원인 카테고리'만 구조화(튜닝 금지).
export interface HistoricalCompare {
  expected: number; actual: number; difference: number;
  missingHistory: number;      // 데이터 부족으로 평가 못한 종목수
  excludedUniverse: number;    // universe 에 아예 없던(상폐/신규 등) — 호출측이 계산해 전달
  insufficientBars: number;    // 600봉 미만
  adjustmentUnknown: boolean;  // 수정주가 상태 불명(정확일치 주장 금지)
  note: string;
}
export function compareHistoricalCount(p: {
  expected: number; actual: number; insufficientBars: number; excludedUniverse: number; adjustmentUnknown: boolean;
}): HistoricalCompare {
  return {
    expected: p.expected, actual: p.actual, difference: p.actual - p.expected,
    missingHistory: p.insufficientBars, excludedUniverse: p.excludedUniverse,
    insufficientBars: p.insufficientBars, adjustmentUnknown: p.adjustmentUnknown,
    note: p.adjustmentUnknown
      ? `수정주가 상태 불명 + universe/상장폐지 차이로 정확일치 주장 불가(원자료 ${p.expected} vs 실측 ${p.actual})`
      : `원자료 ${p.expected} vs 실측 ${p.actual} (차이 ${p.actual - p.expected})`,
  };
}

export { YEOKMAE_MIN_BARS };
