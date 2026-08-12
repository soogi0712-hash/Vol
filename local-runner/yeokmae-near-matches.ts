// 역매공파 근접후보 순위 (P0-32G) — 실행: npm run yeokmae:near-matches -- US|KR [TOP]
//   원본 조건을 절대 완화하지 않고, HTS 대조 대상 선정용 관찰 점수(verified core 실패수 오름차순)만 출력.
//   ⚠️ 이것은 BUY score 가 아니다. 신호가 없는 역배열 종목 중 '가까운' 순서일 뿐. 주문 0.
import { scanCachedDiscovery } from './yeokmae/discovery-scan';
import { rankNearMatches, conditionsLine } from './yeokmae/discovery';

function main() {
  const market = ((process.argv[2] || 'US').toUpperCase() === 'KR' ? 'KR' : 'US') as 'KR' | 'US';
  const top = Number(process.argv[3] || 20) || 20;
  console.log(`===== [YEOKMAE-NEAR-MATCHES] market=${market} — 근접후보(원본 무변경, HTS 대조 선정용) =====`);
  console.log(`[YEOKMAE-SAFETY] YEOKMAE_STRATEGY_VALIDATED=false · REAL_ORDER_FROM_YEOKMAE=false · 관찰 전용`);
  console.log(`  ⚠️ 정렬키=verifiedFailedCount(검증 core 실패수) 오름차순 — BUY score 아님. 조건 완화 없음.`);
  const { cached, results, exMap } = scanCachedDiscovery(market);
  if (cached === 0) { console.log('  캐시 종목 없음 — 먼저 pool 구축.'); return; }

  const ranked = rankNearMatches(results).slice(0, top);
  const f2 = (x: number) => Number.isFinite(x) ? x.toFixed(2) : 'NaN';
  ranked.forEach((d, idx) => {
    console.log(`\n[YEOKMAE-NEAR-MATCH] rank=${idx + 1} symbol=${d.symbol} exch=${exMap.get(d.symbol) ?? market} verifiedFailedCount=${d.verifiedFailedCount} confirmedDate=${d.lastConfirmed}`);
    console.log(`  A~U ${conditionsLine(d.conditions)} searcherFormula=${d.searcherFormulaPass} arrows=0`);
    console.log(`  verifiedFailed=[${d.verifiedFailed.join(',')}] unverified=[${d.unverifiedExternal.join(',')}]`);
    console.log(`  EMA112=${f2(d.ema112)} EMA224=${f2(d.ema224)} EMA448=${f2(d.ema448)}`);
  });
  const reverseNoArrow = results.filter(d => d.reverse && !d.anyArrow).length;
  console.log(`\n[YEOKMAE-NEAR-MATCHES] cached=${cached} reverseNoArrow=${reverseNoArrow} shown=${ranked.length}`);
  console.log(`  다음: 상위 rank 종목을 HTS 에서 열어 실제 화살표/검색기와 대조(semantics 확정). 근접점수를 BUY 로 사용 금지.`);
}
main();
