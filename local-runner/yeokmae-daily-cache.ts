// 역매공파 일봉 영구 캐시 (P0-32B) — 실제 LS 일봉 저장/증분갱신. 경로: yeokmae-daily/<market>/<symbol>.json
//   재실행 시 전체 재취득 금지 — 누락 일봉만 증분 병합. confirmed 가 provisional 을 덮어쓴다. 합성/복제/0-padding 금지.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Candle } from '../src/lib/yeokmae/hts';
import type { AdjustmentStatus } from '../src/lib/yeokmae/history';

export const YEOKMAE_DAILY_ROOT = resolve(process.cwd(), 'local-runner', 'data', 'yeokmae-daily');
const VERSION = 2;

export interface DailyBar {
  date: string;            // YYYY-MM-DD
  open: number; high: number; low: number; close: number; volume: number;
  turnoverKRW: number | null;   // 원화거래대금(공식 확정 시). 단위 미확정 raw 는 여기 넣지 않는다 → null.
  rawTurnover?: number | null;  // TR 원문 거래대금(예: KR t8413 value). 단위 실측 추정만(estimateTurnoverUnit) — KRW 단정 금지.
  confirmed: boolean;           // 확정봉 true / 진행중 당일봉 false
}
export interface DailyCacheBody {
  version: number;
  market: 'KR' | 'US';
  symbol: string;
  sourceTR: string | null;      // 취득 TR(예: t8413/g3103). manual/hts-export 도 가능. 미확정=null
  adjustment: AdjustmentStatus; // UNKNOWN | RAW | ADJUSTED
  fetchedAt: string;            // 마지막 취득시각 ISO(러너가 인자로 넘김 — 순수성)
  firstDate: string | null; lastDate: string | null; barCount: number;
  confirmedThrough: string | null;   // 마지막 확정봉 date
  provisionalDate: string | null;    // 진행중 당일봉 date(있으면)
  bars: DailyBar[];             // 과거→최근, date 유니크, 오름차순
}

// ── 순수 병합: date 유니크·오름차순. confirmed 가 provisional 을 덮어쓴다. 같은 상태면 신규 우선. ──
export function mergeDailyBars(existing: readonly DailyBar[], incoming: readonly DailyBar[]): DailyBar[] {
  const map = new Map<string, DailyBar>();
  for (const b of existing) if (b?.date) map.set(b.date, b);
  for (const b of incoming) {
    if (!b?.date) continue;
    const prev = map.get(b.date);
    if (!prev) { map.set(b.date, b); continue; }
    // confirmed 우선: 기존이 confirmed 이고 신규가 provisional 이면 유지, 그 외엔 신규로 갱신.
    if (prev.confirmed && !b.confirmed) continue;
    map.set(b.date, b);
  }
  return [...map.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}
export function lastConfirmedCachedDate(bars: readonly DailyBar[]): string | null {
  let last: string | null = null;
  for (const b of bars) if (b.confirmed && (last === null || b.date > last)) last = b.date;
  return last;
}

// 시장별 캐시된 심볼 목록(파일명 기준). 없으면 빈 배열.
export function listCachedSymbols(market: 'KR' | 'US', root = YEOKMAE_DAILY_ROOT): string[] {
  const dir = join(root, market);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.tmp') && !f.endsWith('.corrupt')).map(f => f.replace(/\.json$/, '')).sort();
}

export class DailyCache {
  readonly file: string;
  private tmp: string;
  body: DailyCacheBody | null = null;
  corrupt = false;

  constructor(public readonly market: 'KR' | 'US', public readonly symbol: string, root = YEOKMAE_DAILY_ROOT) {
    const dir = join(root, market);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const safe = symbol.replace(/[^A-Za-z0-9_.-]/g, '_');
    this.file = join(dir, `${safe}.json`);
    this.tmp = this.file + '.tmp';
  }
  load(): void {
    if (!existsSync(this.file)) return;
    try {
      const b = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!b || !Array.isArray(b.bars)) { this.corrupt = true; return; }
      this.body = b;
    } catch { this.corrupt = true; try { renameSync(this.file, this.file + '.corrupt'); } catch { /* noop */ } }
  }
  bars(): DailyBar[] { return this.body?.bars ?? []; }
  toCandles(confirmedOnly = false): Candle[] {
    return (this.body?.bars ?? []).filter(b => !confirmedOnly || b.confirmed)
      .map(b => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
  }
  upsert(incoming: readonly DailyBar[], meta: { sourceTR: string | null; adjustment: AdjustmentStatus; fetchedAtISO: string }): { added: number; total: number } {
    const prev = this.body?.bars ?? [];
    const merged = mergeDailyBars(prev, incoming);
    const added = merged.length - prev.length;
    const confirmedThrough = lastConfirmedCachedDate(merged);
    const prov = merged.find(b => !b.confirmed) ?? null;
    this.body = {
      version: VERSION, market: this.market, symbol: this.symbol,
      sourceTR: meta.sourceTR, adjustment: meta.adjustment, fetchedAt: meta.fetchedAtISO,
      firstDate: merged.length ? merged[0].date : null, lastDate: merged.length ? merged[merged.length - 1].date : null,
      barCount: merged.length, confirmedThrough, provisionalDate: prov ? prov.date : null, bars: merged,
    };
    return { added, total: merged.length };
  }
  flush(): void {
    if (!this.body) return;
    writeFileSync(this.tmp, JSON.stringify(this.body), 'utf8');
    renameSync(this.tmp, this.file);
  }
}
