// 역매공파 실제 신호 종목 (P0-32G / P0-35KR2) — 실행: npm run yeokmae:signals -- US|KR
//   캐시 전체에서 SEARCHER_PASS 또는 5신호(arrow) 하나라도 ON 인 종목을 수집·우선순위 출력([YEOKMAE-KR-SIGNAL]).
//   우선순위: 112_UPGRADE/224_UPGRADE > 기타 arrow > searcher-only. 원본 수식 무변경, 주문 0, 네트워크 0(캐시 전용).
import { loadEnvLocal } from './env';
import { DailyCache } from './yeokmae-daily-cache';
import { scanCachedDiscovery, confirmedCandles, loadNameMap } from './yeokmae/discovery-scan';
import { summarize } from './yeokmae/discovery';
import { collectRankedSignals, formatKRSignalDetail, signalTierCounts } from './yeokmae/signal-detail';
import { buildYeokmaeSnapshot } from '../src/lib/yeokmae';

function main() {
  loadEnvLocal();   // P0-35US: .env.local 자동로드(일관성)
  const market = ((process.argv[2] || 'US').toUpperCase() === 'KR' ? 'KR' : 'US') as 'KR' | 'US';
  console.log(`===== [YEOKMAE-SIGNALS] market=${market} — SEARCHER_PASS/5신호 종목 (우선순위: UPGRADE 먼저, 주문 0) =====`);
  console.log(`[YEOKMAE-SAFETY] YEOKMAE_STRATEGY_VALIDATED=false · REAL_ORDER_FROM_YEOKMAE=false · 관찰 전용 · 네트워크 0(캐시 전용)`);
  const { cached, results, exMap, corrupt } = scanCachedDiscovery(market);
  if (cached === 0) { console.log(`  캐시 종목 없음 — 먼저 pool 구축(${market === 'KR' ? 'yeokmae:build-kr-history' : 'yeokmae:build-us-history'}).`); return; }
  const nameOf = loadNameMap(market);

  const ranked = collectRankedSignals(results);
  const counts = signalTierCounts(ranked);
  for (const d of ranked) {
    const cache = new DailyCache(market, d.symbol); cache.load();
    const snap = cache.corrupt ? null : buildYeokmaeSnapshot(d.symbol, confirmedCandles(cache));
    for (const line of formatKRSignalDetail(d, snap, nameOf.get(d.symbol) ?? (exMap.get(d.symbol) ?? '?'))) console.log(line);
  }

  const s = summarize(cached, results);
  console.log(`\n[YEOKMAE-SIGNALS] cached=${cached} ready=${s.ready} reverse=${s.reverse} corrupt=${corrupt}`);
  console.log(`  수집(SEARCHER_PASS||arrow)=${counts.total} · UPGRADE=${counts.upgrade} · 기타arrow=${counts.arrow} · searcher-only=${counts.searcherOnly}`);
  console.log(`  arrow별: 112_ORIGINAL=${s.arrow112Original} 224_ORIGINAL=${s.arrow224Original} 112_UPGRADE=${s.arrow112Upgrade} 224_UPGRADE=${s.arrow224Upgrade} LONG_TERM=${s.longTerm} searcherFormulaPass=${s.searcherFormulaPass} bothSearcherAndArrow=${s.bothSearcherAndArrow}`);
  if (ranked.length === 0) console.log(`  (SEARCHER_PASS/5신호 종목 없음 — 정상. 조건 완화/튜닝하지 않는다. 근접후보는 build 러너의 topNearMatches 참조.)`);
}
main();
