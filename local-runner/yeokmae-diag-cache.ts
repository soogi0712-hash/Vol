// 역매공파 캐시 상태 진단 (P0-32B) — 실행: npm run yeokmae:diag-cache -- SYMBOL [KR|US]
//   저장된 일봉 캐시의 메타데이터 + history readiness + 무결성을 출력(오프라인, 주문 없음).
import { DailyCache } from './yeokmae-daily-cache';
import { evaluateYeokmaeHistoryReadiness, validateDailyIntegrity } from '../src/lib/yeokmae';

function main() {
  const [symbol, marketArg] = process.argv.slice(2);
  if (!symbol) { console.error('사용법: npm run yeokmae:diag-cache -- SYMBOL [KR|US]'); process.exit(1); }
  const market = ((marketArg || 'KR').toUpperCase() === 'US' ? 'US' : 'KR') as 'KR' | 'US';
  const cache = new DailyCache(market, symbol); cache.load();
  if (cache.corrupt) { console.error(`[YEOKMAE-CACHE ${symbol}] 손상 캐시: ${cache.file}`); process.exit(2); }
  const b = cache.body;
  if (!b) { console.error(`[YEOKMAE-CACHE ${symbol}] 캐시 없음: ${cache.file}`); process.exit(2); }
  console.log(`[YEOKMAE-CACHE ${symbol}] market=${b.market} sourceTR=${b.sourceTR ?? '미확정'} adjustment=${b.adjustment} bars=${b.barCount}`);
  console.log(`  firstDate=${b.firstDate} lastDate=${b.lastDate} confirmedThrough=${b.confirmedThrough} provisionalDate=${b.provisionalDate ?? '없음'} fetchedAt=${b.fetchedAt}`);
  if (b.adjustment === 'UNKNOWN') console.log(`[YEOKMAE-DATA-WARN] adjustment=UNKNOWN — 수정주가 상태 불명(과거 정확일치 주장 금지)`);
  const candles = cache.toCandles();
  const ready = evaluateYeokmaeHistoryReadiness(candles, b.confirmedThrough);
  console.log(`[YEOKMAE-READINESS ${symbol}] total=${ready.totalBars} confirmed=${ready.confirmedBars} has600=${ready.has600} hasWarmup=${ready.hasWarmup} sufficient=${ready.sufficient} reason=${ready.reason}`);
  const integ = validateDailyIntegrity(b.bars);
  console.log(`[YEOKMAE-INTEGRITY ${symbol}] valid=${integ.valid} errors=${integ.errors.length}${integ.errors.length ? ' ['+integ.errors.slice(0,5).join(',')+(integ.errors.length>5?'…':'')+']' : ''} warnings=${integ.warnings.length}`);
  if (!integ.valid) console.log(`  ⚠️ 무결성 위반 → 신호 계산 금지 대상`);
}
main();
