// 역매공파 배치 진단 (P0-32B) — 실행: npm run yeokmae:batch-diag -- SYMBOLS_FILE [KR|US] [YYYY-MM-DD]
//   심볼 목록 파일(줄당 1심볼, # 주석 허용)을 읽어 종목별 readiness/검색기/5신호/탈락조건을 요약.
//   결과는 stdout(JSON) + 같은 폴더 CSV 로 저장. 오프라인·관찰 전용(주문 0). 캐시에 실 일봉이 있어야 평가.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import {
  evaluateYeokmaeMatch, evaluateYeokmaeHistoryReadiness, validateDailyIntegrity,
  YEOKMAE_DEFAULT_MIN_TURNOVER_KRW, type YeokmaeMarketFlags,
} from '../src/lib/yeokmae';
import { DailyCache } from './yeokmae-daily-cache';

interface Row {
  symbol: string; market: 'KR' | 'US';
  cached: boolean; corrupt: boolean; bars: number; confirmedThrough: string | null;
  adjustment: string | null; integrityValid: boolean | null; integrityErrors: number;
  sufficient: boolean; readinessReason: string;
  searcherPass: boolean | null; signals: string[]; searcherFailed: string[];
}

function readSymbols(file: string): string[] {
  const txt = readFileSync(file, 'utf8');
  return txt.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
}

function main() {
  const [file, marketArg, dateArg] = process.argv.slice(2);
  if (!file || !existsSync(file)) { console.error('사용법: npm run yeokmae:batch-diag -- SYMBOLS_FILE [KR|US] [YYYY-MM-DD]'); process.exit(1); }
  const market = ((marketArg || 'KR').toUpperCase() === 'US' ? 'US' : 'KR') as 'KR' | 'US';
  const asOf = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : null;
  const flags: YeokmaeMarketFlags = { excluded: false, isCommonStock: true, isEtfEtnSpac: false };
  const symbols = readSymbols(file);
  const rows: Row[] = [];

  for (const symbol of symbols) {
    const cache = new DailyCache(market, symbol); cache.load();
    if (cache.corrupt) { rows.push({ symbol, market, cached: true, corrupt: true, bars: 0, confirmedThrough: null, adjustment: null, integrityValid: null, integrityErrors: 0, sufficient: false, readinessReason: 'CORRUPT_CACHE', searcherPass: null, signals: [], searcherFailed: [] }); continue; }
    const b = cache.body;
    if (!b) { rows.push({ symbol, market, cached: false, corrupt: false, bars: 0, confirmedThrough: null, adjustment: null, integrityValid: null, integrityErrors: 0, sufficient: false, readinessReason: 'NO_CACHE', searcherPass: null, signals: [], searcherFailed: [] }); continue; }
    const all = cache.toCandles();
    const upto = asOf ? all.filter(c => c.date <= asOf) : all;
    const integ = validateDailyIntegrity(b.bars);
    const ready = evaluateYeokmaeHistoryReadiness(upto, b.confirmedThrough);
    if (!ready.sufficient || !integ.valid) {
      rows.push({ symbol, market, cached: true, corrupt: false, bars: upto.length, confirmedThrough: b.confirmedThrough, adjustment: b.adjustment, integrityValid: integ.valid, integrityErrors: integ.errors.length, sufficient: ready.sufficient, readinessReason: integ.valid ? ready.reason : 'INTEGRITY_FAIL', searcherPass: null, signals: [], searcherFailed: [] });
      continue;
    }
    const m = evaluateYeokmaeMatch(symbol, upto, flags, { minTurnoverKRW: YEOKMAE_DEFAULT_MIN_TURNOVER_KRW });
    rows.push({ symbol, market, cached: true, corrupt: false, bars: upto.length, confirmedThrough: b.confirmedThrough, adjustment: b.adjustment, integrityValid: true, integrityErrors: 0, sufficient: true, readinessReason: ready.reason, searcherPass: m.searcherPass, signals: m.signals, searcherFailed: m.searcherFailed });
  }

  const pass = rows.filter(r => r.searcherPass === true);
  const summary = {
    market, asOf, total: rows.length,
    evaluated: rows.filter(r => r.sufficient && r.integrityValid).length,
    noCache: rows.filter(r => !r.cached).length,
    corrupt: rows.filter(r => r.corrupt).length,
    insufficient: rows.filter(r => r.cached && !r.corrupt && !r.sufficient).length,
    integrityFail: rows.filter(r => r.integrityValid === false).length,
    adjustmentUnknown: rows.filter(r => r.adjustment === 'UNKNOWN').length,
    searcherPass: pass.length,
    signalTally: rows.reduce((acc, r) => { for (const s of r.signals) acc[s] = (acc[s] ?? 0) + 1; return acc; }, {} as Record<string, number>),
  };

  console.log('[YEOKMAE-BATCH-DIAG] ' + JSON.stringify(summary));
  console.log(`  검색기 통과(${pass.length}): ${pass.map(r => r.symbol).join(', ') || '(없음)'}`);
  if (summary.adjustmentUnknown > 0) console.log(`[YEOKMAE-DATA-WARN] adjustment=UNKNOWN 종목 ${summary.adjustmentUnknown}개 — 과거 정확일치 주장 금지`);

  // CSV 저장
  const csvPath = join(dirname(file), basename(file).replace(/\.[^.]+$/, '') + `.yeokmae-batch.${market}.csv`);
  const header = 'symbol,market,cached,corrupt,bars,confirmedThrough,adjustment,integrityValid,integrityErrors,sufficient,readinessReason,searcherPass,signals,searcherFailed';
  const lines = rows.map(r => [r.symbol, r.market, r.cached, r.corrupt, r.bars, r.confirmedThrough ?? '', r.adjustment ?? '', r.integrityValid ?? '', r.integrityErrors, r.sufficient, r.readinessReason, r.searcherPass ?? '', `"${r.signals.join('|')}"`, `"${r.searcherFailed.join('|')}"`].join(','));
  writeFileSync(csvPath, [header, ...lines].join('\n') + '\n', 'utf8');
  console.log(`[YEOKMAE-BATCH-DIAG] CSV 저장: ${csvPath}`);
  console.log(`[YEOKMAE-SAFETY] 관찰 전용 · 주문 0 · REAL_ORDER_FROM_YEOKMAE=false`);
}
main();
