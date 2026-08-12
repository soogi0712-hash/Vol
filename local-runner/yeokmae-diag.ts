// 역매공파 진단 CLI (P0-32/32A/32E) — 실행: npm run yeokmae:diag -- SYMBOL YYYY-MM-DD [KR|US] [--mode confirmed|provisional|both]
//   특정 종목/날짜의 OHLCV·지표·A~U·5신호·최종매치 출력. 확정/진행봉은 '캐시의 실제 confirmed 플래그' 기준(요청날짜를 무조건 진행봉 취급하지 않음).
//   기본 mode=confirmed: 요청 date 의 '확정 종가' 기준(그 date 가 confirmed 면 그 date 가 마지막 계산봉). look-ahead 금지(요청 date 이후 봉 미사용).
//   provisional: 캐시 provisionalDate(진행중 당일봉)까지 포함. both: 둘 다 비교(진행봉 repaint 관찰) — 진행봉은 provisional 비교에서만 사용.
//   HTS 함수 의미 4종([SHIFT-DIR][STDDEV-POP][ICHI-DISP][SEED])은 [YEOKMAE-SEMANTICS] 로 보고 + A/B(env). ⚠️ 실 일봉만(합성 금지).
import { existsSync, readFileSync } from 'node:fs';
import {
  computeYeokmaeIndicators, evaluateAllYeokmae, evaluateYeokmaeSearcher, evaluateYeokmaeMatch,
  YEOKMAE_MIN_BARS, YEOKMAE_DEFAULT_MIN_TURNOVER_KRW, YEOKMAE_STRATEGY_VALIDATED, DEFAULT_SEMANTICS,
  type Candle, type YeokmaeMarketFlags, type YeokmaeSemantics,
} from '../src/lib/yeokmae';
import { DailyCache } from './yeokmae-daily-cache';
import { selectConfirmedBars, selectProvisionalBars } from './yeokmae/diag-select';

type Mode = 'confirmed' | 'provisional' | 'both';
interface LoadedBar { date: string; open: number; high: number; low: number; close: number; volume: number; confirmed: boolean }
interface Loaded { bars: LoadedBar[]; provisionalDate: string | null; confirmedThrough: string | null; source: string }

function loadDaily(symbol: string, market: 'KR' | 'US'): Loaded {
  const envPath = process.env.YEOKMAE_DAILY_FILE;
  if (envPath && existsSync(envPath)) {
    const raw = JSON.parse(readFileSync(envPath, 'utf8'));
    const arr: any[] = Array.isArray(raw) ? raw : (raw.bars ?? []);
    const bars: LoadedBar[] = arr.map((r) => ({ date: String(r.date), open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume, confirmed: r.confirmed !== undefined ? !!r.confirmed : true }));
    bars.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const prov = bars.filter(b => !b.confirmed).map(b => b.date).sort().pop() ?? null;
    const conf = bars.filter(b => b.confirmed).map(b => b.date).sort().pop() ?? null;
    return { bars, provisionalDate: prov, confirmedThrough: conf, source: `FILE(${envPath})` };
  }
  const cache = new DailyCache(market, symbol); cache.load();
  if (cache.corrupt) { console.error(`[YEOKMAE-DIAG] 캐시 손상: ${cache.file}`); process.exit(2); }
  const body = cache.body;
  if (!body || body.bars.length === 0) {
    console.error(`[YEOKMAE-DIAG] 일봉 데이터 없음: ${cache.file}`);
    console.error(`  → npm run yeokmae:fetch-daily -- ${market} ${symbol} 로 실 일봉 취득 후 재실행. (합성/복제 금지)`);
    process.exit(2);
  }
  const bars: LoadedBar[] = body.bars.map(b => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, confirmed: b.confirmed }));
  return { bars, provisionalDate: body.provisionalDate, confirmedThrough: body.confirmedThrough, source: `CACHE(${cache.file}) sourceTR=${body.sourceTR ?? '?'} adj=${body.adjustment}` };
}

function toCandles(bars: LoadedBar[]): Candle[] {
  return bars.map(b => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
}

function semanticsFromEnv(): YeokmaeSemantics {
  return {
    emaSeed: (process.env.YEOKMAE_EMA_SEED as any) === 'sma' ? 'sma' : DEFAULT_SEMANTICS.emaSeed,
    shiftDir: (process.env.YEOKMAE_SHIFT_DIR as any) === 'future' ? 'future' : DEFAULT_SEMANTICS.shiftDir,
    stddevPopulation: process.env.YEOKMAE_STDDEV_SAMPLE === 'true' ? false : DEFAULT_SEMANTICS.stddevPopulation,
    ichimokuDisplaced: process.env.YEOKMAE_ICHIMOKU_NODISP === 'true' ? false : DEFAULT_SEMANTICS.ichimokuDisplaced,
  };
}

function report(label: string, symbol: string, market: string, candles: Candle[], sem: YeokmaeSemantics, flags: YeokmaeMarketFlags) {
  const n = candles.length;
  if (n === 0) { console.log(`[YEOKMAE-${label}] 계산봉 없음`); return; }
  const last = candles[n - 1];
  if (n < YEOKMAE_MIN_BARS) { console.log(`[YEOKMAE-${label}] lastCalcBar=${last.date} bars=${n} < ${YEOKMAE_MIN_BARS} → INSUFFICIENT_HISTORY(신호 계산 안 함)`); return; }
  const I = computeYeokmaeIndicators(candles, { semantics: sem });
  const i = n - 1;
  const f2 = (x: number) => Number.isFinite(x) ? x.toFixed(2) : 'NaN';
  console.log(`[YEOKMAE-${label} IND] lastCalcBar=${last.date} O=${f2(last.open)} H=${f2(last.high)} L=${f2(last.low)} C=${f2(last.close)} V=${last.volume}`);
  console.log(`  ema5=${f2(I.e1[i])} ema20=${f2(I.e2[i])} ema60=${f2(I.e3[i])} ema112=${f2(I.e4[i])} ema224=${f2(I.e5[i])} ema448=${f2(I.e6[i])} ema600=${f2(I.e7[i])}`);
  console.log(`  reverseAlign(112<=224<=448)=${I.e4[i] <= I.e5[i] && I.e5[i] <= I.e6[i]} blueLine=${f2(I.blueX[i])} bb40Upper=${f2(I.bolUp40[i])} bb40Lower=${f2(I.bolDn40[i])} ichiSpan1=${f2(I.span1[i])} ichiSpan2=${f2(I.span2[i])}`);
  const searcher = evaluateYeokmaeSearcher(candles, flags, { minTurnoverKRW: YEOKMAE_DEFAULT_MIN_TURNOVER_KRW, semantics: sem });
  console.log(`[YEOKMAE-${label} SEARCH] ` + 'ABCDEFGHIJKLMNOPQRSTU'.split('').map(k => `${k}=${searcher.conditions[k] ? 1 : 0}`).join('') + ` → formulaMatched=${searcher.matched} failed=[${searcher.failed.join(',')}]`);
  // rule 7: A/B/C 기본값 + T 실데이터 미연결 → 원본검색기 완전일치 주장 금지.
  const turnoverReal = market === 'KR' ? 'close×volume(원 proxy)' : 'close×volume(USD proxy, 환율 미연결)';
  console.log(`  [SEARCHER-STATUS] PARTIAL / UNVERIFIED_EXTERNAL_FILTERS — A/B/C=진단기본값(제외/보통주/ETF판정 미연결), T=${turnoverReal}. A~U 전체 실데이터 연결 전까지 '원본 검색기 통과' 주장 금지.`);
  const sig = evaluateAllYeokmae(candles);
  for (const t of ['112_ORIGINAL','224_ORIGINAL','112_UPGRADE','224_UPGRADE','LONG_TERM'] as const) {
    const s = sig[t];
    console.log(`[YEOKMAE-${label} SIGNAL] type=${t} matched=${s.matched} totNow=${s.totNow} conditions=${JSON.stringify(s.conditions)}`);
  }
  const m = evaluateYeokmaeMatch(symbol, candles, flags);
  console.log(`[YEOKMAE-${label} MATCH] symbol=${symbol} searcherFormula=${m.searcherPass}(UNVERIFIED_EXTERNAL_FILTERS) signals=[${m.signals.join(',')}]`);
}

function main() {
  const argv = process.argv.slice(2);
  const flagsArgs = argv.filter(a => a.startsWith('--'));
  const pos = argv.filter(a => !a.startsWith('--'));
  const [symbol, date, marketArg] = pos;
  if (!symbol || !date) { console.error('사용법: npm run yeokmae:diag -- SYMBOL YYYY-MM-DD [KR|US] [--mode confirmed|provisional|both]'); process.exit(1); }
  const market = ((marketArg || 'KR').toUpperCase() === 'US' ? 'US' : 'KR') as 'KR' | 'US';
  let mode: Mode = 'confirmed';
  const mi = flagsArgs.find(a => a.startsWith('--mode'));
  if (mi) { const v = (mi.includes('=') ? mi.split('=')[1] : argv[argv.indexOf(mi) + 1]) as Mode; if (v === 'provisional' || v === 'both' || v === 'confirmed') mode = v; }

  const loaded = loadDaily(symbol, market);
  const sem = semanticsFromEnv();
  const flags: YeokmaeMarketFlags = { excluded: false, isCommonStock: true, isEtfEtnSpac: false };

  // ── 계산봉 집합 결정 (캐시 confirmed 플래그 기준, look-ahead 금지) — 순수 로직 diag-select ──
  const confSel = selectConfirmedBars(loaded.bars, date);
  const confirmedBars = confSel.bars; const confirmedLast = confSel.lastDate;
  const provDate = loaded.provisionalDate;
  const provSel = selectProvisionalBars(loaded.bars, provDate);
  const provisionalBars = provSel.bars;

  console.log(`===== [YEOKMAE-DIAG] ${symbol} @ ${date} (market=${market}, mode=${mode}) =====`);
  console.log(`[YEOKMAE-SAFETY] YEOKMAE_STRATEGY_VALIDATED=${YEOKMAE_STRATEGY_VALIDATED} · REAL_ORDER_FROM_YEOKMAE=false · 관찰 전용(주문 0)`);
  console.log(`[YEOKMAE-SEMANTICS] SHIFT=${sem.shiftDir} STDDEV=${sem.stddevPopulation ? 'population(÷N)' : 'sample(÷N-1)'} ICHIMOKU=${sem.ichimokuDisplaced ? 'displaced(26)' : 'nondisplaced'} EMA_SEED=${sem.emaSeed} (env: YEOKMAE_SHIFT_DIR/STDDEV_SAMPLE/ICHIMOKU_NODISP/EMA_SEED 로 A/B) — ⚠️ 미검증(실 HTS 대조 전)`);
  console.log(`[YEOKMAE-DATA] ${loaded.source}`);
  console.log(`  totalBars=${loaded.bars.length} confirmedThrough=${loaded.confirmedThrough ?? '없음'} provisionalDate=${loaded.provisionalDate ?? '없음'} requestDate=${date}`);
  console.log(`  → CONFIRMED lastCalcBar=${confirmedLast ?? '없음'}(요청일 이하 확정봉) / PROVISIONAL lastCalcBar=${provDate ?? '없음(캐시에 진행봉 없음)'}`);
  if (confirmedLast && confirmedLast !== date) console.log(`  ℹ️ 요청일 ${date} 이 캐시 확정봉이 아니어서 직전 확정봉 ${confirmedLast} 기준으로 계산(무조건 진행봉 취급 안 함).`);

  if (mode === 'confirmed' || mode === 'both') {
    console.log(`\n----- CONFIRMED (요청일 이하 마지막 확정봉 기준, look-ahead 금지) -----`);
    report('CONFIRMED', symbol, market, toCandles(confirmedBars), sem, flags);
  }
  if (mode === 'provisional' || mode === 'both') {
    console.log(`\n----- PROVISIONAL (진행중 당일봉 포함 — repaint 관찰) -----`);
    if (!provDate) console.log(`[YEOKMAE-PROVISIONAL] 캐시에 진행봉(provisionalDate) 없음 → 비교 생략(요청일을 임의로 진행봉 취급하지 않음).`);
    else report('PROVISIONAL', symbol, market, toCandles(provisionalBars), sem, flags);
  }
  if (mode === 'both') console.log(`\n⚠️ CONFIRMED/PROVISIONAL 신호가 다르면 진행봉 변화로 repaint 가능. 실전 승인 전까지 어느 쪽도 주문 미연결.`);
  console.log(`\n[YEOKMAE-NOTE] 검색기/신호는 원본 HTS 대조 전(semantics 미검증) — 관찰 전용. AAPL 등 특정 종목에서 신호가 나오도록 로직 튜닝 금지.`);
}
main();
