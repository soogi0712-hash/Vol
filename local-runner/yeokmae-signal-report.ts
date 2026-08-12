// 역매공파 실신호 상세 스냅샷 리포트 (P0-33A) — 실행: npm run yeokmae:signal-report -- US|KR
//   실 [YEOKMAE-REAL-SIGNAL] 종목(5신호 1개+ ON)에 대해 HTS 대조용 상세 스냅샷 저장(JSON + Markdown). 주문 0.
//   confirmedDate/OHLCV/EMA5~600/blueLine/BB40/Ichimoku/A~U/5신호 sub-condition. semantics 미검증 유지.
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { buildYeokmaeSnapshot, snapshotToMarkdown, YEOKMAE_SELL_INVESTIGATION, YEOKMAE_STRATEGY_VALIDATED, type YeokmaeSnapshot } from '../src/lib/yeokmae';
import { DailyCache, YEOKMAE_DAILY_ROOT } from './yeokmae-daily-cache';
import { scanCachedDiscovery, confirmedCandles } from './yeokmae/discovery-scan';

function saveAtomic(file: string, content: string) { const tmp = file + '.tmp'; writeFileSync(tmp, content, 'utf8'); renameSync(tmp, file); }

function main() {
  const market = ((process.argv[2] || 'US').toUpperCase() === 'KR' ? 'KR' : 'US') as 'KR' | 'US';
  console.log(`===== [YEOKMAE-SIGNAL-REPORT] market=${market} — 실신호 상세 스냅샷(HTS 대조용, 주문 0) =====`);
  console.log(`[YEOKMAE-SAFETY] YEOKMAE_STRATEGY_VALIDATED=${YEOKMAE_STRATEGY_VALIDATED} · REAL_ORDER_FROM_YEOKMAE=false`);

  const { cached, results, exMap } = scanCachedDiscovery(market);
  if (cached === 0) { console.log('  캐시 종목 없음 — 먼저 pool 구축(yeokmae:build-us-history).'); return; }
  const arrowSymbols = results.filter(d => d.anyArrow);

  const snapshots: YeokmaeSnapshot[] = [];
  for (const d of arrowSymbols) {
    const cache = new DailyCache(market, d.symbol); cache.load();
    if (cache.corrupt) continue;
    const snap = buildYeokmaeSnapshot(d.symbol, confirmedCandles(cache));
    if (snap) snapshots.push(snap);
  }

  // JSON(구조화) + Markdown(사람이 읽는 HTS 대조표) 저장
  const jsonFile = join(YEOKMAE_DAILY_ROOT, `${market}.signal-report.json`);
  const mdFile = join(YEOKMAE_DAILY_ROOT, `${market}.signal-report.md`);
  saveAtomic(jsonFile, JSON.stringify({ market, count: snapshots.length, sellPolicy: YEOKMAE_SELL_INVESTIGATION, snapshots }, null, 2));

  const md: string[] = [];
  md.push(`# 역매공파 실신호 리포트 (${market}) — HTS 대조용`);
  md.push('');
  md.push(`- 실신호 종목수: **${snapshots.length}**  (5신호 중 1개+ matched=true 인 confirmed 종목만)`);
  md.push(`- ⚠️ semantics(SHIFT/STDDEV/ICHIMOKU/EMA seed) **미검증** — 실 HTS 화살표와 일치 확인 전까지 확정 금지.`);
  md.push(`- ⚠️ 검색기 A/B/C/T 는 UNVERIFIED_EXTERNAL(진입 필수조건 아님, diagnostic).`);
  md.push('');
  md.push(`## SELL 정책`);
  md.push(`- 자료 재조사 결과: **${YEOKMAE_SELL_INVESTIGATION.finding}** (hasExitFormulaInSource=${YEOKMAE_SELL_INVESTIGATION.hasExitFormulaInSource})`);
  md.push(`- ${YEOKMAE_SELL_INVESTIGATION.note}`);
  md.push('');
  md.push(`## HTS 대조 필요값 (각 종목을 HTS 에서 열어 아래 값 일치 확인)`);
  md.push(`EMA5/20/60/112/224/448/600, blueLine, BB40(upper/lower), Ichimoku(span1/span2), A~U 각 조건, 5신호 sub-condition.`);
  md.push('');
  for (const s of snapshots) { md.push(snapshotToMarkdown(s)); md.push('\n---\n'); }
  if (snapshots.length === 0) md.push(`_(현재 실신호 종목 없음 — reverse=있어도 5신호 all false 이면 리포트 비어있음이 정상. 조건 완화 금지.)_`);
  saveAtomic(mdFile, md.join('\n'));

  for (const s of snapshots) {
    console.log(`[YEOKMAE-SIGNAL-REPORT] ${s.symbol} exch=${exMap.get(s.symbol) ?? market} confirmedDate=${s.confirmedDate} arrows=[${(['112_ORIGINAL','224_ORIGINAL','112_UPGRADE','224_UPGRADE','LONG_TERM'] as const).filter(t=>s.signals[t].matched).join(',')}]`);
  }
  console.log(`[YEOKMAE-SIGNAL-REPORT] realSignalSymbols=${snapshots.length} → ${jsonFile} · ${mdFile}`);
  console.log(`[YEOKMAE-SELL] finding=${YEOKMAE_SELL_INVESTIGATION.finding} (자료 기반 SELL 없음). BB SELL 역매공파 적용 금지, 임의 손절/익절 금지.`);
  if (snapshots.length === 0) console.log(`  (실신호 0 — 정상. 실전 활성화에는 실 HTS 대조 가능한 실신호 종목이 필요.)`);
}
main();
