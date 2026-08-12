// 역매공파 진단 CLI (P0-32) — 특정 종목/날짜의 OHLCV·지표·A~U·5신호·최종매치를 한 번에 출력.
//   실행: npm run yeokmae:diag -- SYMBOL YYYY-MM-DD [MARKET]
//   사용자가 HTS 차트의 화살표(◆/↑)와 대조할 수 있게 상세값을 낸다. ⚠️ 합성/복제봉 금지 — 실제 일봉 캐시만 사용.
//   일봉 데이터 소스: local-runner/data/yeokmae-daily/<SYMBOL>.json  (또는 env YEOKMAE_DAILY_FILE 경로)
//     형식: [{ "date":"YYYY-MM-DD", "open":.., "high":.., "low":.., "close":.., "volume":.. }, ...] (과거→최근)
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  computeYeokmaeIndicators, evaluateAllYeokmae, evaluateYeokmaeSearcher, evaluateYeokmaeMatch,
  YEOKMAE_MIN_BARS, YEOKMAE_DEFAULT_MIN_TURNOVER_KRW, YEOKMAE_STRATEGY_VALIDATED,
  type Candle, type YeokmaeMarketFlags,
} from '../src/lib/yeokmae';

const DAILY_DIR = resolve(process.cwd(), 'local-runner', 'data', 'yeokmae-daily');

function loadDaily(symbol: string): Candle[] {
  const p = process.env.YEOKMAE_DAILY_FILE || join(DAILY_DIR, `${symbol}.json`);
  if (!existsSync(p)) {
    console.error(`[YEOKMAE-DIAG] 일봉 데이터 없음: ${p}`);
    console.error(`  → HTS/LS 에서 받은 일봉 OHLCV(과거→최근)를 JSON 배열로 위 경로에 저장 후 다시 실행. (합성데이터 사용 안 함)`);
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  if (!Array.isArray(raw)) { console.error('[YEOKMAE-DIAG] 형식 오류: 배열 아님'); process.exit(2); }
  return raw.map((r: any) => ({ date: String(r.date), open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume }));
}

function main() {
  const [symbol, date, marketArg] = process.argv.slice(2);
  if (!symbol || !date) { console.error('사용법: npm run yeokmae:diag -- SYMBOL YYYY-MM-DD [KR|US]'); process.exit(1); }
  const market = (marketArg || 'KR').toUpperCase();
  const all = loadDaily(symbol);
  // CONFIRMED = date 이하 마지막 확정 일봉 기준 / PROVISIONAL = date 가 당일(진행중)일 수 있음 → 둘 다 관찰.
  const upto = all.filter(c => c.date <= date);
  if (upto.length === 0) { console.error(`[YEOKMAE-DIAG] ${date} 이하 일봉 없음`); process.exit(2); }
  const confirmed = upto;   // 마지막 = date (또는 그 이전 마지막). 사용자가 CONFIRMED 로 대조.
  const n = confirmed.length;
  const last = confirmed[n - 1];

  console.log(`===== [YEOKMAE-DIAG] ${symbol} @ ${date} (market=${market}) =====`);
  console.log(`[YEOKMAE-SAFETY] YEOKMAE_STRATEGY_VALIDATED=${YEOKMAE_STRATEGY_VALIDATED} (실주문 하드차단) · 이 도구는 관찰 전용`);
  console.log(`[YEOKMAE-DATA] symbol=${symbol} market=${market} bars=${n} firstDate=${confirmed[0].date} lastDate=${last.date} sufficient=${n >= YEOKMAE_MIN_BARS}`);
  if (n < YEOKMAE_MIN_BARS) {
    console.log(`[YEOKMAE-DIAG] INSUFFICIENT_HISTORY — 최소 ${YEOKMAE_MIN_BARS}봉 필요(EMA600 등). 현재 ${n}봉 → 신호 계산 안 함.`);
    return;
  }

  const I = computeYeokmaeIndicators(confirmed);
  const i = n - 1;
  const f2 = (x: number) => Number.isFinite(x) ? x.toFixed(2) : 'NaN';
  console.log(`[YEOKMAE-IND] symbol=${symbol} O=${f2(last.open)} H=${f2(last.high)} L=${f2(last.low)} C=${f2(last.close)} V=${last.volume}`);
  console.log(`  ema5=${f2(I.e1[i])} ema20=${f2(I.e2[i])} ema60=${f2(I.e3[i])} ema112=${f2(I.e4[i])} ema224=${f2(I.e5[i])} ema448=${f2(I.e6[i])} ema600=${f2(I.e7[i])}`);
  console.log(`  blueLine(x)=${f2(I.blueX[i])} bb40Upper=${f2(I.bolUp40[i])} bb40Lower=${f2(I.bolDn40[i])} ichimokuSpan1=${f2(I.span1[i])} ichimokuSpan2=${f2(I.span2[i])}`);

  // A/B/C 시장플래그 — 진단은 기본값(제외안됨/보통주/일반). 실제 판정은 러너가 LS 마스터필드로.
  const flags: YeokmaeMarketFlags = { excluded: false, isCommonStock: true, isEtfEtnSpac: false };
  const turnover = market === 'US' ? undefined : undefined;   // KR: close×volume(원화). US: 러너가 환율적용 배열 주입(진단 기본 미적용).
  const searcher = evaluateYeokmaeSearcher(confirmed, flags, { minTurnoverKRW: YEOKMAE_DEFAULT_MIN_TURNOVER_KRW, turnoverKRW: turnover });
  console.log(`[YEOKMAE-SEARCH] symbol=${symbol} ` + ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U'].map(k => `${k}=${searcher.conditions[k]}`).join(' '));
  console.log(`  matched=${searcher.matched} failed=[${searcher.failed.join(',')}]`);
  console.log(`  ⚠️ A/B/C 는 진단 기본값(제외안됨/보통주/일반). T 는 KR=close×volume, US 는 환율적용 필요.`);

  const sig = evaluateAllYeokmae(confirmed);
  for (const t of ['112_ORIGINAL','224_ORIGINAL','112_UPGRADE','224_UPGRADE','LONG_TERM'] as const) {
    const s = sig[t];
    console.log(`[YEOKMAE-SIGNAL] symbol=${symbol} type=${t} matched=${s.matched} totNow=${s.totNow} totPrev=${s.totPrev}`);
    console.log(`  conditions=${JSON.stringify(s.conditions)}`);
  }

  const m = evaluateYeokmaeMatch(symbol, confirmed, flags, { turnoverKRW: turnover });
  console.log(`[YEOKMAE-MATCH] symbol=${symbol} searcher=${m.searcherPass} signals=[${m.signals.join(',')}]`);
  console.log(`\n요약: SEARCHER_PASS=${m.searcherPass} 112_ORIGINAL=${sig['112_ORIGINAL'].matched} 224_ORIGINAL=${sig['224_ORIGINAL'].matched} 112_UPGRADE=${sig['112_UPGRADE'].matched} 224_UPGRADE=${sig['224_UPGRADE'].matched} LONG_TERM=${sig['LONG_TERM'].matched}`);
}
main();
