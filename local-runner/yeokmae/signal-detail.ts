// 역매공파 신호 우선순위/상세 출력 (P0-35KR2, 순수·테스트용) — 원본 수식/조건 무변경. 주문 0.
//   수집: SEARCHER_PASS 또는 5신호(arrow) 하나라도 true. 우선순위: 112_UPGRADE/224_UPGRADE > 기타 arrow > searcher-only.
import { conditionsLine, type SymbolDiscovery } from './discovery';
import type { YeokmaeSnapshot } from '../../src/lib/yeokmae';

export type SignalTier = 'UPGRADE' | 'ARROW' | 'SEARCHER_ONLY';
export function signalTier(d: SymbolDiscovery): SignalTier {
  if (d.arrows['112_UPGRADE'] || d.arrows['224_UPGRADE']) return 'UPGRADE';   // item3: 업그레이드 최우선
  if (d.anyArrow) return 'ARROW';                                            // 기타 5신호(112/224_ORIGINAL, LONG_TERM)
  return 'SEARCHER_ONLY';                                                    // A~U 전부 통과했으나 화살표 없음
}
const TIER_RANK: Record<SignalTier, number> = { UPGRADE: 0, ARROW: 1, SEARCHER_ONLY: 2 };

// item2 수집 + item3 정렬 — ready·reverse 이며 (searcherFormulaPass || anyArrow). UPGRADE 먼저, 동순위 symbol 오름차순.
export function collectRankedSignals(results: readonly SymbolDiscovery[]): SymbolDiscovery[] {
  return results
    .filter(d => d.ready && d.reverse && (d.searcherFormulaPass || d.anyArrow))
    .slice()
    .sort((a, b) => TIER_RANK[signalTier(a)] - TIER_RANK[signalTier(b)] || a.symbol.localeCompare(b.symbol));
}

// 활성 신호 라벨(업그레이드 우선 순서) + SEARCHER_PASS.
const LABEL_ORDER = ['112_UPGRADE', '224_UPGRADE', '112_ORIGINAL', '224_ORIGINAL', 'LONG_TERM'] as const;
export function activeSignalLabels(d: SymbolDiscovery): string[] {
  const labels: string[] = LABEL_ORDER.filter(t => d.arrows[t]);
  if (d.searcherFormulaPass) labels.push('SEARCHER_PASS');
  return labels;
}

// item4: 종목별 상세 로그 라인(symbol/name/signalType/signalDate/close/EMA112·224·448/blueLine/BB40upper/A~U failed).
export function formatKRSignalDetail(d: SymbolDiscovery, snap: YeokmaeSnapshot | null, name: string): string[] {
  const f = (x: number) => Number.isFinite(x) ? x.toFixed(2) : 'NaN';
  const lines: string[] = [];
  lines.push(`[YEOKMAE-KR-SIGNAL] symbol=${d.symbol} name=${name} tier=${signalTier(d)} signalType=[${activeSignalLabels(d).join(',')}] signalDate=${d.lastConfirmed ?? '-'}`);
  if (snap) {
    lines.push(`  close=${f(snap.ohlcv.close)} EMA112=${f(snap.ema.e112)} EMA224=${f(snap.ema.e224)} EMA448=${f(snap.ema.e448)} blueLine=${f(snap.blueLine)} BB40upper=${f(snap.bb40.upper)}`);
    lines.push(`  A~U=${conditionsLine(snap.searcher.conditions)} failedConditions=[${snap.searcher.failed.join(',')}] verifiedFailed(core)=[${d.verifiedFailed.join(',')}] unverified=[${d.unverifiedExternal.join(',')}]`);
  } else {
    lines.push(`  close=n/a blueLine=n/a BB40upper=n/a (snapshot 불가: confirmed<600) EMA112=${f(d.ema112)} EMA224=${f(d.ema224)} EMA448=${f(d.ema448)}`);
  }
  return lines;
}

// 집계 라인 — tier 별 개수.
export function signalTierCounts(ranked: readonly SymbolDiscovery[]): { upgrade: number; arrow: number; searcherOnly: number; total: number } {
  let upgrade = 0, arrow = 0, searcherOnly = 0;
  for (const d of ranked) { const t = signalTier(d); if (t === 'UPGRADE') upgrade++; else if (t === 'ARROW') arrow++; else searcherOnly++; }
  return { upgrade, arrow, searcherOnly, total: ranked.length };
}
