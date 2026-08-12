// 역매공파 semantics 그리드 (P0-32B) — 실행: npm run yeokmae:semantics-grid -- SYMBOL YYYY-MM-DD [KR|US]
//   4개 FLAGGED 의미([SHIFT-DIR][STDDEV-POP][ICHI-DISP][SEED])의 2^4=16 조합 각각에 대해
//   A~U 검색기 + 5신호 + 핵심지표를 출력 → 원본 HTS 와 대조해 어느 의미가 맞는지 판별용(관찰 전용).
//   ⚠️ 실 일봉 필요. 어느 조합도 실주문에 연결하지 않는다(판별 목적).
import { existsSync, readFileSync } from 'node:fs';
import {
  computeYeokmaeIndicators, evaluateYeokmae112Original, evaluateYeokmae224Original,
  evaluateYeokmae112Upgrade, evaluateYeokmae224Upgrade, evaluateYeokmaeLongTerm,
  evaluateYeokmaeSearcher, YEOKMAE_MIN_BARS, YEOKMAE_DEFAULT_MIN_TURNOVER_KRW,
  DEFAULT_112_ORIGINAL, DEFAULT_224_ORIGINAL, DEFAULT_112_UPGRADE, DEFAULT_224_UPGRADE, DEFAULT_LONG_TERM,
  type Candle, type YeokmaeMarketFlags, type YeokmaeSemantics,
} from '../src/lib/yeokmae';
import { DailyCache } from './yeokmae-daily-cache';

function loadDaily(symbol: string, market: 'KR' | 'US'): Candle[] {
  const envPath = process.env.YEOKMAE_DAILY_FILE;
  if (envPath && existsSync(envPath)) {
    const raw = JSON.parse(readFileSync(envPath, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.bars ?? []);
    return arr.map((r: any) => ({ date: String(r.date), open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume }));
  }
  const cache = new DailyCache(market, symbol); cache.load();
  if (cache.corrupt) { console.error(`[YEOKMAE-GRID] 캐시 손상: ${cache.file}`); process.exit(2); }
  const candles = cache.toCandles();
  if (candles.length === 0) { console.error(`[YEOKMAE-GRID] 일봉 없음: ${cache.file} (실 일봉 필요)`); process.exit(2); }
  return candles;
}

// 16 조합 생성 (emaSeed × shiftDir × stddevPopulation × ichimokuDisplaced)
function allCombos(): YeokmaeSemantics[] {
  const seeds: Array<YeokmaeSemantics['emaSeed']> = ['first', 'sma'];
  const shifts: Array<YeokmaeSemantics['shiftDir']> = ['past', 'future'];
  const combos: YeokmaeSemantics[] = [];
  for (const emaSeed of seeds)
    for (const shiftDir of shifts)
      for (const stddevPopulation of [true, false])
        for (const ichimokuDisplaced of [true, false])
          combos.push({ emaSeed, shiftDir, stddevPopulation, ichimokuDisplaced });
  return combos;
}

function tag(s: YeokmaeSemantics): string {
  return `SEED=${s.emaSeed} SHIFT=${s.shiftDir} STDDEV=${s.stddevPopulation ? 'pop' : 'sample'} ICHI=${s.ichimokuDisplaced ? 'disp' : 'nodisp'}`;
}

function main() {
  const [symbol, date, marketArg] = process.argv.slice(2);
  if (!symbol || !date) { console.error('사용법: npm run yeokmae:semantics-grid -- SYMBOL YYYY-MM-DD [KR|US]'); process.exit(1); }
  const market = ((marketArg || 'KR').toUpperCase() === 'US' ? 'US' : 'KR') as 'KR' | 'US';
  const all = loadDaily(symbol, market).filter(c => c.date <= date);
  if (all.length < YEOKMAE_MIN_BARS) { console.error(`[YEOKMAE-GRID] bars=${all.length} < ${YEOKMAE_MIN_BARS} → INSUFFICIENT_HISTORY`); process.exit(2); }
  const flags: YeokmaeMarketFlags = { excluded: false, isCommonStock: true, isEtfEtnSpac: false };
  const i = all.length - 1; const last = all[i];
  const f2 = (x: number) => Number.isFinite(x) ? x.toFixed(2) : 'NaN';

  console.log(`===== [YEOKMAE-SEMANTICS-GRID] ${symbol} @ ${date} (market=${market}) bars=${all.length} =====`);
  console.log(`[YEOKMAE-SAFETY] 판별 전용 · 주문 0 · REAL_ORDER_FROM_YEOKMAE=false · 어느 조합도 실주문 미연결`);
  console.log(`기준봉 date=${last.date} O=${f2(last.open)} H=${f2(last.high)} L=${f2(last.low)} C=${f2(last.close)} V=${last.volume}`);

  for (const sem of allCombos()) {
    const ind = computeYeokmaeIndicators(all, { semantics: sem });
    const searcher = evaluateYeokmaeSearcher(all, flags, { minTurnoverKRW: YEOKMAE_DEFAULT_MIN_TURNOVER_KRW, semantics: sem });
    const sigs = {
      '112_ORIGINAL': evaluateYeokmae112Original(all, DEFAULT_112_ORIGINAL, ind).matched,
      '224_ORIGINAL': evaluateYeokmae224Original(all, DEFAULT_224_ORIGINAL, ind).matched,
      '112_UPGRADE': evaluateYeokmae112Upgrade(all, DEFAULT_112_UPGRADE, ind).matched,
      '224_UPGRADE': evaluateYeokmae224Upgrade(all, DEFAULT_224_UPGRADE, ind).matched,
      'LONG_TERM': evaluateYeokmaeLongTerm(all, DEFAULT_LONG_TERM, ind).matched,
    };
    const on = Object.entries(sigs).filter(([, v]) => v).map(([k]) => k);
    console.log(`\n--- ${tag(sem)} ---`);
    console.log(`  IND ema112=${f2(ind.e4[i])} ema224=${f2(ind.e5[i])} ema600=${f2(ind.e7[i])} bb40U=${f2(ind.bolUp40[i])} ichiSpan1=${f2(ind.span1[i])} ichiSpan2=${f2(ind.span2[i])} blueLine=${f2(ind.blueX[i])}`);
    console.log(`  A~U ` + 'ABCDEFGHIJKLMNOPQRSTU'.split('').map(k => `${k}=${searcher.conditions[k] ? 1 : 0}`).join('') + ` → searcher=${searcher.matched} failed=[${searcher.failed.join(',')}]`);
    console.log(`  SIGNALS on=[${on.join(',')}]`);
  }
  console.log(`\n⚠️ 조합별 결과가 다르면, 원본 HTS 실측과 대조해 참 의미를 확정해야 함(추측 확정 금지). 확정 전 실주문 미연결.`);
}
main();
