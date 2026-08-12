// 역매공파 역배열 후보 스캐너 (P0-32E/32F) — 실행: npm run yeokmae:find-reverse -- US|KR
//   캐시된 종목 중 '마지막 확정봉 EMA112<=EMA224<=EMA448(역배열)' 만족 종목만 후보 출력(1차 필터).
//   출력: symbol / exchange / bars / EMA112 / EMA224 / EMA448 / lastConfirmed. 관찰 전용, 주문 0. look-ahead 금지(확정봉만).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  console.log(`===== [YEOKMAE-FIND-REVERSE] market=${market} — 캐시 역배열(EMA112<=224<=448) 후보 스캔 (주문 0) =====`);
  const symbols = listCachedSymbols(market);
  if (symbols.length === 0) { console.log(`  캐시된 ${market} 종목 없음. npm run yeokmae:${market === 'US' ? 'build-us-history' : 'fetch-daily -- KR <SYMBOL>'} 로 먼저 취득.`); return; }
  const exMap = loadExchangeMap(market);
  const f2 = (x: number) => Number.isFinite(x) ? x.toFixed(2) : 'NaN';

  const candidates: Array<{ symbol: string; exchange: string; bars: number; ema112: number; ema224: number; ema448: number; lastConfirmed: string | null }> = [];
  let ready = 0, insufficient = 0, corrupt = 0;
  for (const symbol of symbols) {
    const cache = new DailyCache(market, symbol); cache.load();
    if (cache.corrupt) { corrupt++; continue; }
    const confirmed = (cache.body?.bars ?? []).filter(b => b.confirmed).map(b => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    const ra = reverseAlignmentAt(confirmed);
    if (!ra.ready) { insufficient++; continue; }
    ready++;
    if (ra.reverse) candidates.push({ symbol, exchange: exMap.get(symbol) ?? market, bars: ra.bars, ema112: ra.ema112, ema224: ra.ema224, ema448: ra.ema448, lastConfirmed: cache.body?.confirmedThrough ?? ra.lastDate });
  }

  console.log(`[YEOKMAE-FIND-REVERSE] scanned=${symbols.length} ready=${ready} insufficient=${insufficient} corrupt=${corrupt} reverseCandidates=${candidates.length}`);
  console.log(`  symbol / exchange / bars / EMA112 / EMA224 / EMA448 / lastConfirmed`);
  for (const c of candidates) {
    console.log(`  ✅ ${c.symbol} / ${c.exchange} / ${c.bars} / ${f2(c.ema112)} / ${f2(c.ema224)} / ${f2(c.ema448)} / ${c.lastConfirmed}`);
  }
  if (candidates.length === 0) console.log(`  (역배열 후보 없음 — 현재 캐시 종목들은 EMA112<=224<=448 미충족. 상승추세 종목은 역배열 아님이 정상)`);
  console.log(`\n[YEOKMAE-FIND-REVERSE] 다음: npm run yeokmae:scan-candidates -- ${market} (후보별 A~U + 5신호). 주문 0.`);
}
main();
