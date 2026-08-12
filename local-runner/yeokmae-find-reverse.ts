// 역매공파 역배열 후보 스캐너 (P0-32E) — 실행: npm run yeokmae:find-reverse -- US   (또는 KR)
//   캐시된 종목 중 '마지막 확정봉에서 EMA112<=EMA224<=EMA448(역배열)'을 만족하는 종목만 후보로 출력.
//   목적: 다음 단계에서 실제 HTS 와 비교할 진단 후보 선별(관찰 전용, 주문 0). 신호가 나오게 튜닝하지 않는다.
import { computeYeokmaeIndicators, evaluateYeokmaeHistoryReadiness, type Candle } from '../src/lib/yeokmae';
import { DailyCache, listCachedSymbols } from './yeokmae-daily-cache';

interface Row { symbol: string; bars: number; confirmedThrough: string | null; ema112: number; ema224: number; ema448: number; reverse: boolean; note: string }

function main() {
  const market = ((process.argv[2] || 'US').toUpperCase() === 'KR' ? 'KR' : 'US') as 'KR' | 'US';
  console.log(`===== [YEOKMAE-FIND-REVERSE] market=${market} — 캐시 역배열(EMA112<=224<=448) 후보 스캔 (주문 0) =====`);
  const symbols = listCachedSymbols(market);
  if (symbols.length === 0) { console.log(`  캐시된 ${market} 종목 없음. npm run yeokmae:fetch-daily -- ${market} <SYMBOL> 로 먼저 취득.`); return; }

  const f2 = (x: number) => Number.isFinite(x) ? x.toFixed(2) : 'NaN';
  const rows: Row[] = [];
  let ready = 0, insufficient = 0, corrupt = 0;
  for (const symbol of symbols) {
    const cache = new DailyCache(market, symbol); cache.load();
    if (cache.corrupt) { corrupt++; rows.push({ symbol, bars: 0, confirmedThrough: null, ema112: NaN, ema224: NaN, ema448: NaN, reverse: false, note: 'CORRUPT' }); continue; }
    // 확정봉만 사용(진행봉 제외 = look-ahead 금지)
    const confirmed: Candle[] = (cache.body?.bars ?? []).filter(b => b.confirmed).map(b => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    const rd = evaluateYeokmaeHistoryReadiness(confirmed);
    if (!rd.sufficient) { insufficient++; rows.push({ symbol, bars: confirmed.length, confirmedThrough: cache.body?.confirmedThrough ?? null, ema112: NaN, ema224: NaN, ema448: NaN, reverse: false, note: 'INSUFFICIENT_HISTORY' }); continue; }
    ready++;
    const I = computeYeokmaeIndicators(confirmed);
    const i = confirmed.length - 1;
    const e112 = I.e4[i], e224 = I.e5[i], e448 = I.e6[i];
    const reverse = Number.isFinite(e112) && Number.isFinite(e224) && Number.isFinite(e448) && e112 <= e224 && e224 <= e448;
    rows.push({ symbol, bars: confirmed.length, confirmedThrough: cache.body?.confirmedThrough ?? null, ema112: e112, ema224: e224, ema448: e448, reverse, note: reverse ? 'REVERSE_CANDIDATE' : 'not-reverse' });
  }

  const candidates = rows.filter(r => r.reverse);
  console.log(`[YEOKMAE-FIND-REVERSE] scanned=${symbols.length} ready=${ready} insufficient=${insufficient} corrupt=${corrupt} reverseCandidates=${candidates.length}`);
  for (const r of candidates) {
    console.log(`  ✅ ${r.symbol} confirmedThrough=${r.confirmedThrough} bars=${r.bars} ema112=${f2(r.ema112)} <= ema224=${f2(r.ema224)} <= ema448=${f2(r.ema448)}`);
  }
  if (candidates.length === 0) console.log(`  (역배열 후보 없음 — 현재 캐시 종목들은 EMA112<=224<=448 미충족. AAPL 등 상승추세 종목은 역배열 아님이 정상)`);
  console.log(`\n[YEOKMAE-FIND-REVERSE] 다음: 후보에 대해 npm run yeokmae:diag -- <SYMBOL> <confirmedThrough> ${market} 로 A~U/신호 확인 후 실제 HTS 대조.`);
  console.log(`[YEOKMAE-SAFETY] 관찰 전용 · 주문 0 · REAL_ORDER_FROM_YEOKMAE=false`);
}
main();
