// 역매공파 진단 CLI (P0-32/32A) — 실행: npm run yeokmae:diag -- SYMBOL YYYY-MM-DD [KR|US]
//   특정 종목/날짜의 OHLCV·지표·A~U·5신호·최종매치를 CONFIRMED/PROVISIONAL 로 나눠 출력.
//   일봉 소스: DailyCache(local-runner/data/yeokmae-daily/<SYMBOL>.json). ⚠️ 합성/복제봉 금지 — 실 일봉만.
//   HTS 함수 의미 4종([SHIFT-DIR][STDDEV-POP][ICHI-DISP][SEED])은 [YEOKMAE-SEMANTICS] 로 보고 + A/B(env).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeYeokmaeIndicators, evaluateAllYeokmae, evaluateYeokmaeSearcher, evaluateYeokmaeMatch,
  YEOKMAE_MIN_BARS, YEOKMAE_DEFAULT_MIN_TURNOVER_KRW, YEOKMAE_STRATEGY_VALIDATED, DEFAULT_SEMANTICS,
  type Candle, type YeokmaeMarketFlags, type YeokmaeSemantics,
} from '../src/lib/yeokmae';
import { DailyCache, YEOKMAE_DAILY_DIR } from './yeokmae-daily-cache';

function loadDaily(symbol: string, market: 'KR' | 'US'): Candle[] {
  const envPath = process.env.YEOKMAE_DAILY_FILE;
  if (envPath && existsSync(envPath)) {
    const raw = JSON.parse(readFileSync(envPath, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.bars ?? []);
    return arr.map((r: any) => ({ date: String(r.date), open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume }));
  }
  const cache = new DailyCache(market, symbol); cache.load();
  if (cache.corrupt) { console.error(`[YEOKMAE-DIAG] 캐시 손상: ${cache.file}`); process.exit(2); }
  const candles = cache.toCandles();
  if (candles.length === 0) {
    const flat = join(YEOKMAE_DAILY_DIR, `${symbol}.json`);
    console.error(`[YEOKMAE-DIAG] 일봉 데이터 없음: ${flat}`);
    console.error(`  → LS 일봉을 취득해 캐시에 저장하거나(HTS export → DailyCache), YEOKMAE_DAILY_FILE 로 JSON 경로 지정.`);
    console.error(`  ⚠️ 합성/복제 데이터는 사용하지 않음. 실제 일봉만.`);
    process.exit(2);
  }
  return candles;
}

function semanticsFromEnv(): YeokmaeSemantics {
  return {
    emaSeed: (process.env.YEOKMAE_EMA_SEED as any) === 'sma' ? 'sma' : DEFAULT_SEMANTICS.emaSeed,
    shiftDir: (process.env.YEOKMAE_SHIFT_DIR as any) === 'future' ? 'future' : DEFAULT_SEMANTICS.shiftDir,
    stddevPopulation: process.env.YEOKMAE_STDDEV_SAMPLE === 'true' ? false : DEFAULT_SEMANTICS.stddevPopulation,
    ichimokuDisplaced: process.env.YEOKMAE_ICHIMOKU_NODISP === 'true' ? false : DEFAULT_SEMANTICS.ichimokuDisplaced,
  };
}

function report(label: string, candles: Candle[], sem: YeokmaeSemantics, flags: YeokmaeMarketFlags, market: string) {
  const n = candles.length;
  if (n < YEOKMAE_MIN_BARS) { console.log(`[YEOKMAE-${label}] bars=${n} < ${YEOKMAE_MIN_BARS} → INSUFFICIENT_HISTORY(신호 계산 안 함)`); return; }
  const I = computeYeokmaeIndicators(candles, { semantics: sem });
  const i = n - 1; const last = candles[i];
  const f2 = (x: number) => Number.isFinite(x) ? x.toFixed(2) : 'NaN';
  console.log(`[YEOKMAE-${label} IND] date=${last.date} O=${f2(last.open)} H=${f2(last.high)} L=${f2(last.low)} C=${f2(last.close)} V=${last.volume}`);
  console.log(`  ema5=${f2(I.e1[i])} ema20=${f2(I.e2[i])} ema60=${f2(I.e3[i])} ema112=${f2(I.e4[i])} ema224=${f2(I.e5[i])} ema448=${f2(I.e6[i])} ema600=${f2(I.e7[i])}`);
  console.log(`  blueLine=${f2(I.blueX[i])} bb40Upper=${f2(I.bolUp40[i])} bb40Lower=${f2(I.bolDn40[i])} ichiSpan1=${f2(I.span1[i])} ichiSpan2=${f2(I.span2[i])}`);
  const searcher = evaluateYeokmaeSearcher(candles, flags, { minTurnoverKRW: YEOKMAE_DEFAULT_MIN_TURNOVER_KRW, semantics: sem });
  console.log(`[YEOKMAE-${label} SEARCH] ` + 'ABCDEFGHIJKLMNOPQRSTU'.split('').map(k => `${k}=${searcher.conditions[k]}`).join(' ') + ` → matched=${searcher.matched} failed=[${searcher.failed.join(',')}]`);
  const sig = evaluateAllYeokmae(candles);   // 기본 semantics — A/B 는 아래 SEMANTICS 블록에서
  for (const t of ['112_ORIGINAL','224_ORIGINAL','112_UPGRADE','224_UPGRADE','LONG_TERM'] as const) {
    const s = sig[t];
    console.log(`[YEOKMAE-${label} SIGNAL] type=${t} matched=${s.matched} totNow=${s.totNow} conditions=${JSON.stringify(s.conditions)}`);
  }
  const m = evaluateYeokmaeMatch(last.date, candles, flags);
  console.log(`[YEOKMAE-${label} MATCH] symbol=? searcher=${m.searcherPass} signals=[${m.signals.join(',')}]`);
}

function main() {
  const [symbol, date, marketArg] = process.argv.slice(2);
  if (!symbol || !date) { console.error('사용법: npm run yeokmae:diag -- SYMBOL YYYY-MM-DD [KR|US]'); process.exit(1); }
  const market = ((marketArg || 'KR').toUpperCase() === 'US' ? 'US' : 'KR') as 'KR' | 'US';
  const all = loadDaily(symbol, market);
  const upto = all.filter(c => c.date <= date);
  if (upto.length === 0) { console.error(`[YEOKMAE-DIAG] ${date} 이하 일봉 없음`); process.exit(2); }
  const sem = semanticsFromEnv();
  const flags: YeokmaeMarketFlags = { excluded: false, isCommonStock: true, isEtfEtnSpac: false };

  console.log(`===== [YEOKMAE-DIAG] ${symbol} @ ${date} (market=${market}) =====`);
  console.log(`[YEOKMAE-SAFETY] YEOKMAE_STRATEGY_VALIDATED=${YEOKMAE_STRATEGY_VALIDATED} · REAL_ORDER_FROM_YEOKMAE=false · 관찰 전용(주문 0)`);
  console.log(`[YEOKMAE-SEMANTICS] SHIFT=${sem.shiftDir} STDDEV=${sem.stddevPopulation ? 'population(÷N)' : 'sample(÷N-1)'} ICHIMOKU=${sem.ichimokuDisplaced ? 'displaced(26)' : 'nondisplaced'} EMA_SEED=${sem.emaSeed} (env: YEOKMAE_SHIFT_DIR/STDDEV_SAMPLE/ICHIMOKU_NODISP/EMA_SEED 로 A/B)`);
  console.log(`[YEOKMAE-DATA] symbol=${symbol} market=${market} bars=${upto.length} firstDate=${upto[0].date} lastDate=${upto[upto.length - 1].date} sufficient=${upto.length >= YEOKMAE_MIN_BARS}`);
  console.log(`  A/B/C 는 진단 기본값(제외안됨/보통주/일반). T 는 KR=close×volume / US 는 환율적용(러너 연결 시).`);

  // ── CONFIRMED = 마지막 완성 일봉(진행중 당일봉 제외) / PROVISIONAL = 진행중 당일봉 포함 ──
  const provisional = upto;                        // 마지막 봉 = date(진행중일 수 있음)
  const confirmed = upto.slice(0, -1);             // 마지막 1봉(진행중 가능성) 제외 → 직전 완성봉 기준
  console.log(`\n----- CONFIRMED (마지막 완성 일봉 기준) -----`);
  report('CONFIRMED', confirmed, sem, flags, market);
  console.log(`\n----- PROVISIONAL (진행중 당일봉 포함 — repaint 관찰) -----`);
  report('PROVISIONAL', provisional, sem, flags, market);
  console.log(`\n⚠️ CONFIRMED/PROVISIONAL 신호가 다르면 당일봉 변화로 repaint 가능. 실전 승인 전까지 어느 쪽도 주문 미연결.`);
}
main();
