// 역매공파 후보 정밀 스캔 (P0-32F) — 실행: npm run yeokmae:scan-candidates -- US|KR
//   1차(역배열) 통과 종목에 대해서만 2차(검색기 A~U + 5신호)를 계산(계층화 = 계산 최적화, 원본 논리 무변경).
//   ⚠️ A/B/C 진단기본값 + T 실데이터 미연결 → 원본검색기 완전일치 주장 금지(UNVERIFIED_EXTERNAL_FILTERS). 주문 0.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evaluateYeokmaeSearcher, evaluateAllYeokmae, YEOKMAE_DEFAULT_MIN_TURNOVER_KRW,
  type Candle, type YeokmaeMarketFlags,
} from '../src/lib/yeokmae';
import { reverseAlignmentAt } from './yeokmae/us-history-pool';
import { DailyCache, YEOKMAE_DAILY_ROOT, listCachedSymbols } from './yeokmae-daily-cache';

function loadExchangeMap(market: 'KR' | 'US'): Map<string, string> {
  const m = new Map<string, string>();
  if (market !== 'US') return m;
  const f = join(YEOKMAE_DAILY_ROOT, 'US.reverse-candidates.json');
  if (existsSync(f)) { try { const j = JSON.parse(readFileSync(f, 'utf8')); for (const c of (j.candidates ?? [])) if (c.symbol) m.set(c.symbol, c.exchange ?? 'US'); } catch { /* noop */ } }
  return m;
}

function main() {
  const market = ((process.argv[2] || 'US').toUpperCase() === 'KR' ? 'KR' : 'US') as 'KR' | 'US';
  console.log(`===== [YEOKMAE-SCAN-CANDIDATES] market=${market} — 역배열 후보 A~U + 5신호 (주문 0) =====`);
  console.log(`[YEOKMAE-SAFETY] YEOKMAE_STRATEGY_VALIDATED=false · REAL_ORDER_FROM_YEOKMAE=false · 관찰 전용`);
  const symbols = listCachedSymbols(market);
  if (symbols.length === 0) { console.log(`  캐시된 ${market} 종목 없음. 먼저 pool 구축.`); return; }
  const exMap = loadExchangeMap(market);
  const flags: YeokmaeMarketFlags = { excluded: false, isCommonStock: true, isEtfEtnSpac: false };
  const turnoverProxy = market === 'KR' ? 'close×volume(원 proxy)' : 'close×volume(USD proxy, 환율 미연결)';

  let scanned = 0, reverse = 0, searcherFormulaPass = 0;
  for (const symbol of symbols) {
    const cache = new DailyCache(market, symbol); cache.load();
    if (cache.corrupt) continue;
    const confirmed: Candle[] = (cache.body?.bars ?? []).filter(b => b.confirmed).map(b => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    const ra = reverseAlignmentAt(confirmed);
    if (!ra.ready) continue;
    scanned++;
    if (!ra.reverse) continue;   // 1차 필터: 역배열만 2차 계산
    reverse++;

    const searcher = evaluateYeokmaeSearcher(confirmed, flags, { minTurnoverKRW: YEOKMAE_DEFAULT_MIN_TURNOVER_KRW });
    const sig = evaluateAllYeokmae(confirmed);
    const on = (['112_ORIGINAL','224_ORIGINAL','112_UPGRADE','224_UPGRADE','LONG_TERM'] as const).filter(t => sig[t].matched);
    if (searcher.matched) searcherFormulaPass++;
    console.log(`\n[YEOKMAE-CANDIDATE] ${symbol} / ${exMap.get(symbol) ?? market} / bars=${ra.bars} / lastConfirmed=${cache.body?.confirmedThrough ?? ra.lastDate}`);
    console.log(`  A~U ` + 'ABCDEFGHIJKLMNOPQRSTU'.split('').map(k => `${k}=${searcher.conditions[k] ? 1 : 0}`).join('') + ` → formulaMatched=${searcher.matched} failed=[${searcher.failed.join(',')}]`);
    console.log(`  [SEARCHER-STATUS] PARTIAL / UNVERIFIED_EXTERNAL_FILTERS — A/B/C=진단기본값, T=${turnoverProxy}. '원본 검색기 통과' 주장 금지.`);
    console.log(`  SIGNALS on=[${on.join(',')}]`);
  }

  console.log(`\n[YEOKMAE-SCAN-CANDIDATES] scanned(ready)=${scanned} reverse=${reverse} searcherFormulaPass=${searcherFormulaPass}`);
  console.log(`  ⚠️ semantics(SHIFT/STDDEV/ICHIMOKU/EMA seed) 미검증 — 실제 후보를 HTS 에서 열어 대조 후 확정.`);
}
main();
