// 역매공파 캐시 전체 발견 스캔 (P0-32G, 러너측 IO) — 캐시 confirmed 봉 → analyzeSymbol.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DailyCache, YEOKMAE_DAILY_ROOT, listCachedSymbols } from '../yeokmae-daily-cache';
import { analyzeSymbol, type SymbolDiscovery } from './discovery';
import type { Candle } from '../../src/lib/yeokmae';

export function loadExchangeMap(market: 'KR' | 'US'): Map<string, string> {
  const m = new Map<string, string>();
  if (market !== 'US') return m;
  const f = join(YEOKMAE_DAILY_ROOT, 'US.reverse-candidates.json');
  if (existsSync(f)) { try { const j = JSON.parse(readFileSync(f, 'utf8')); for (const c of (j.candidates ?? [])) if (c.symbol) m.set(c.symbol, c.exchange ?? 'US'); } catch { /* noop */ } }
  return m;
}
// 종목명 맵 — <market>.reverse-candidates.json / real-signals.json 의 name 재사용(캐시 전용, 네트워크 0).
export function loadNameMap(market: 'KR' | 'US'): Map<string, string> {
  const m = new Map<string, string>();
  for (const fname of [`${market}.reverse-candidates.json`, `${market}.real-signals.json`]) {
    const f = join(YEOKMAE_DAILY_ROOT, fname);
    if (!existsSync(f)) continue;
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      for (const c of (j.candidates ?? j.signals ?? [])) if (c.symbol && c.name && !m.has(c.symbol)) m.set(c.symbol, c.name);
    } catch { /* noop */ }
  }
  return m;
}

export function confirmedCandles(cache: DailyCache): Candle[] {
  return (cache.body?.bars ?? []).filter(b => b.confirmed).map(b => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
}

export interface DiscoveryScan { cached: number; results: SymbolDiscovery[]; exMap: Map<string, string>; corrupt: number }
export function scanCachedDiscovery(market: 'KR' | 'US'): DiscoveryScan {
  const symbols = listCachedSymbols(market);
  const exMap = loadExchangeMap(market);
  const results: SymbolDiscovery[] = [];
  let corrupt = 0;
  for (const symbol of symbols) {
    const cache = new DailyCache(market, symbol); cache.load();
    if (cache.corrupt) { corrupt++; continue; }
    results.push(analyzeSymbol(symbol, confirmedCandles(cache)));
  }
  return { cached: symbols.length, results, exMap, corrupt };
}
