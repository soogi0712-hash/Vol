// 역매공파(YEOKMAE) 전략 엔진 — 공개 API + 조합현황 + 안전게이트 (P0-32).
// ⚠️ 이 단계는 원본 재현 + diagnostic 만. 실주문 없음. 검색기와 화살표를 임의 조합해 BUY 룰을 만들지 않는다.
export * from './hts';
export * from './types';
export * from './signals';
export * from './searcher';
export * from './history';
export * from './calendar';
export * from './historical';
export * from './live';
export * from './snapshot';
export * from './exit';

import { evaluateAllYeokmae } from './signals';
import { evaluateYeokmaeSearcher, type YeokmaeMarketFlags, type YeokmaeSearcherOpts } from './searcher';
import type { Candle } from './hts';
import type { YeokmaeSignalType } from './types';

// ── 안전 게이트 (rule 15) — 실주문 하드 차단 ──
// YEOKMAE_STRATEGY_VALIDATED 는 코드상수(원본재현 검증 완료 전 절대 true 금지). P0-33 에서 검증 후 전환.
// (env 읽기는 worker 컨텍스트(src/lib)에서 불가 → 러너가 LEGACY_BB_LIVE_ENABLED/YEOKMAE_LIVE_TRADING 를 읽어 넘긴다.)
export const YEOKMAE_STRATEGY_VALIDATED = false;
// 최종 실주문 허용 = LS_LIVE_TRADING AND YEOKMAE_LIVE_TRADING AND YEOKMAE_STRATEGY_VALIDATED(코드상수 false → 항상 false).
export function realOrderFromYeokmaeEnabled(p: { liveTrading: boolean; yeokmaeLive: boolean }): boolean {
  return !!(p.liveTrading && p.yeokmaeLive && YEOKMAE_STRATEGY_VALIDATED);
}

// ── 조합 현황 (rule 12) — 6개 결과를 각각 독립 출력. 임의 조합 BUY 룰 없음. ──
export interface YeokmaeMatch {
  symbol: string;
  searcherPass: boolean;
  signals: YeokmaeSignalType[];         // matched=true 인 화살표 신호들
  signalDetail: ReturnType<typeof evaluateAllYeokmae>;
  searcherFailed: string[];
  insufficientHistory: boolean;
}
export function evaluateYeokmaeMatch(symbol: string, candles: readonly Candle[], flags: YeokmaeMarketFlags, opts: YeokmaeSearcherOpts = {}): YeokmaeMatch {
  const searcher = evaluateYeokmaeSearcher(candles, flags, opts);
  const signalDetail = evaluateAllYeokmae(candles);
  const signals = (Object.keys(signalDetail) as YeokmaeSignalType[]).filter(t => signalDetail[t].matched);
  const insufficientHistory = searcher.insufficientHistory || Object.values(signalDetail).some(s => s.insufficientHistory);
  return { symbol, searcherPass: searcher.matched, signals, signalDetail, searcherFailed: searcher.failed, insufficientHistory };
}

// [YEOKMAE-MATCH] 한 줄 로그.
export function formatYeokmaeMatch(m: YeokmaeMatch): string {
  return `[YEOKMAE-MATCH] symbol=${m.symbol} searcher=${m.searcherPass} signals=[${m.signals.join(',')}]${m.insufficientHistory ? ' INSUFFICIENT_HISTORY' : ''}`;
}
