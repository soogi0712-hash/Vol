// 역매공파 실제 신호 종목 (P0-32G) — 실행: npm run yeokmae:signals -- US|KR
//   캐시 전체에서 5신호 중 하나라도 ON 인 종목만 출력([YEOKMAE-REAL-SIGNAL]). 원본 무변경, 주문 0.
//   ⚠️ 역배열만 true 이고 5신호 모두 false 인 종목은 BUY 후보 아님(여기 출력 안 됨).
import { scanCachedDiscovery } from './yeokmae/discovery-scan';
import { conditionsLine, summarize, SIGNAL_TYPES } from './yeokmae/discovery';

function main() {
  const market = ((process.argv[2] || 'US').toUpperCase() === 'KR' ? 'KR' : 'US') as 'KR' | 'US';
  console.log(`===== [YEOKMAE-SIGNALS] market=${market} — 5신호 중 1개+ ON 종목 (주문 0) =====`);
  console.log(`[YEOKMAE-SAFETY] YEOKMAE_STRATEGY_VALIDATED=false · REAL_ORDER_FROM_YEOKMAE=false · 관찰 전용`);
  const { cached, results, exMap, corrupt } = scanCachedDiscovery(market);
  if (cached === 0) { console.log('  캐시 종목 없음 — 먼저 pool 구축(yeokmae:build-us-history).'); return; }

  const hits = results.filter(d => d.anyArrow);
  const f2 = (x: number) => Number.isFinite(x) ? x.toFixed(2) : 'NaN';
  for (const d of hits) {
    const on = SIGNAL_TYPES.filter(t => d.arrows[t]);
    console.log(`\n[YEOKMAE-REAL-SIGNAL] symbol=${d.symbol} exch=${exMap.get(d.symbol) ?? market} confirmedDate=${d.lastConfirmed} arrows=[${on.join(',')}]`);
    console.log(`  A~U ${conditionsLine(d.conditions)} searcherFormula=${d.searcherFormulaPass}`);
    console.log(`  112_ORIGINAL=${d.arrows['112_ORIGINAL']} 224_ORIGINAL=${d.arrows['224_ORIGINAL']} 112_UPGRADE=${d.arrows['112_UPGRADE']} 224_UPGRADE=${d.arrows['224_UPGRADE']} LONG_TERM=${d.arrows['LONG_TERM']}`);
    console.log(`  EMA112=${f2(d.ema112)} EMA224=${f2(d.ema224)} EMA448=${f2(d.ema448)}`);
    console.log(`  verifiedFailed=[${d.verifiedFailed.join(',')}] unverified=[${d.unverifiedExternal.join(',')}] (A/B/C 매핑·T 환율 미검증 — 완전일치 주장 금지)`);
  }
  const s = summarize(cached, results);
  console.log(`\n[YEOKMAE-SIGNALS] cached=${cached} ready=${s.ready} reverse=${s.reverse} withArrow=${s.anyArrow} bothSearcherAndArrow=${s.bothSearcherAndArrow} corrupt=${corrupt}`);
  if (hits.length === 0) console.log(`  (5신호 ON 종목 없음 — 정상. 조건 완화/튜닝하지 않는다. 근접후보는 yeokmae:near-matches 로 확인.)`);
}
main();
