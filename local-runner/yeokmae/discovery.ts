// 역매공파 신호 발견/근접후보 순수로직 (P0-32G) — 원본 수식/조건 무변경. 관찰 전용(주문 0).
//   계층: 1차 역배열 → 통과 시에만 검색기 A~U + 5신호 계산. 조건 완화·튜닝 없음.
//   verified core 실패와 external 미검증(A/B/C 매핑·T 환율 미연결)을 섞지 않는다.
import {
  evaluateYeokmaeSearcher, evaluateAllYeokmae, YEOKMAE_DEFAULT_MIN_TURNOVER_KRW,
  type Candle, type YeokmaeMarketFlags,
} from '../../src/lib/yeokmae';
import { reverseAlignmentAt } from './us-history-pool';

export const SIGNAL_TYPES = ['112_ORIGINAL', '224_ORIGINAL', '112_UPGRADE', '224_UPGRADE', 'LONG_TERM'] as const;
export type SignalType = typeof SIGNAL_TYPES[number];

// external 미검증 조건 — A(제외종목)/B(보통주)/C(ETF판정) 실데이터 매핑 미완 + T(거래대금) 환율/단위 미연결.
//   ⚠️ 이들은 '검증됨'으로 취급하지 않는다. verified core 실패수와 섞지 않는다.
export const UNVERIFIED_EXTERNAL = ['A', 'B', 'C', 'T'] as const;
const UNV = new Set<string>(UNVERIFIED_EXTERNAL);

export interface SymbolDiscovery {
  symbol: string;
  ready: boolean;            // 600+ 확정봉
  reverse: boolean;          // EMA112<=224<=448 (1차)
  bars: number; lastConfirmed: string | null;
  ema112: number; ema224: number; ema448: number;
  // 아래는 reverse=true 일 때만 계산(계층화). 그 외 기본값.
  conditions: Record<string, boolean>;         // A~U
  searcherFormulaPass: boolean;
  arrows: Record<SignalType, boolean>;
  anyArrow: boolean; arrowCount: number;
  verifiedFailed: string[];                     // 실패 조건 중 external(A/B/C/T) 제외 = 검증된 core 실패
  unverifiedExternal: string[];                 // 항상 [A,B,C,T] (미검증 표시)
  verifiedFailedCount: number;                  // 근접후보 랭킹용(오름차순). ⚠️ BUY score 아님.
}

const EMPTY_ARROWS: Record<SignalType, boolean> = { '112_ORIGINAL': false, '224_ORIGINAL': false, '112_UPGRADE': false, '224_UPGRADE': false, 'LONG_TERM': false };

export function analyzeSymbol(symbol: string, confirmed: readonly Candle[], flags?: YeokmaeMarketFlags): SymbolDiscovery {
  const ff: YeokmaeMarketFlags = flags ?? { excluded: false, isCommonStock: true, isEtfEtnSpac: false };
  const ra = reverseAlignmentAt(confirmed);
  const base: SymbolDiscovery = {
    symbol, ready: ra.ready, reverse: ra.reverse, bars: ra.bars, lastConfirmed: ra.lastDate,
    ema112: ra.ema112, ema224: ra.ema224, ema448: ra.ema448,
    conditions: {}, searcherFormulaPass: false, arrows: { ...EMPTY_ARROWS }, anyArrow: false, arrowCount: 0,
    verifiedFailed: [], unverifiedExternal: [...UNVERIFIED_EXTERNAL], verifiedFailedCount: 0,
  };
  if (!ra.ready || !ra.reverse) return base;   // 1차 미통과 → 2차 계산 안 함(원본 논리대로)

  const searcher = evaluateYeokmaeSearcher(confirmed, ff, { minTurnoverKRW: YEOKMAE_DEFAULT_MIN_TURNOVER_KRW });
  const sig = evaluateAllYeokmae(confirmed);
  const arrows = { ...EMPTY_ARROWS };
  for (const t of SIGNAL_TYPES) arrows[t] = sig[t].matched;
  const arrowCount = SIGNAL_TYPES.filter(t => arrows[t]).length;
  const verifiedFailed = searcher.failed.filter(c => !UNV.has(c));
  return {
    ...base,
    conditions: searcher.conditions,
    searcherFormulaPass: searcher.matched,
    arrows, anyArrow: arrowCount > 0, arrowCount,
    verifiedFailed, verifiedFailedCount: verifiedFailed.length,
  };
}

// A~U 문자열(1/0) — 로그용.
export function conditionsLine(cond: Record<string, boolean>): string {
  return 'ABCDEFGHIJKLMNOPQRSTU'.split('').map(k => `${k}=${cond[k] ? 1 : 0}`).join('');
}

// 발견 집계.
export interface DiscoverySummary {
  cached: number; ready: number; reverse: number;
  arrow112Original: number; arrow224Original: number; arrow112Upgrade: number; arrow224Upgrade: number; longTerm: number;
  anyArrow: number; searcherFormulaPass: number; bothSearcherAndArrow: number;
}
export function summarize(cachedCount: number, ds: readonly SymbolDiscovery[]): DiscoverySummary {
  const ready = ds.filter(d => d.ready).length;
  const reverse = ds.filter(d => d.reverse).length;
  const cnt = (t: SignalType) => ds.filter(d => d.arrows[t]).length;
  return {
    cached: cachedCount, ready, reverse,
    arrow112Original: cnt('112_ORIGINAL'), arrow224Original: cnt('224_ORIGINAL'),
    arrow112Upgrade: cnt('112_UPGRADE'), arrow224Upgrade: cnt('224_UPGRADE'), longTerm: cnt('LONG_TERM'),
    anyArrow: ds.filter(d => d.anyArrow).length,
    searcherFormulaPass: ds.filter(d => d.searcherFormulaPass).length,
    bothSearcherAndArrow: ds.filter(d => d.searcherFormulaPass && d.anyArrow).length,
  };
}

// 근접후보 랭킹 — reverse 이며 화살표 없는 종목을, verified core 실패수 오름차순.
//   ⚠️ BUY score 아님. HTS 대조 대상 선정용. 원본 조건 완화 없음.
export function rankNearMatches(ds: readonly SymbolDiscovery[]): SymbolDiscovery[] {
  return ds.filter(d => d.reverse && !d.anyArrow)
    .slice()
    .sort((a, b) => a.verifiedFailedCount - b.verifiedFailedCount || a.symbol.localeCompare(b.symbol));
}
