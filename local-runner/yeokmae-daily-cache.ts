// 역매공파 일봉 영구 캐시 (P0-32A) — 실제 LS 일봉을 종목별로 저장/증분갱신.
//   경로: local-runner/data/yeokmae-daily/<SYMBOL>.json
//   재실행 시 전체를 다시 받지 않고 '누락 일봉만' 증분 병합한다. 합성/복제/0-padding 금지.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Candle } from '../src/lib/yeokmae/hts';

export const YEOKMAE_DAILY_DIR = resolve(process.cwd(), 'local-runner', 'data', 'yeokmae-daily');
const VERSION = 1;

// 캐시 봉 — OHLCV + turnover(공식제공 시) + 수정주가여부 + 출처/취득시각.
export interface DailyBar {
  date: string;            // YYYY-MM-DD (확정 일봉)
  open: number; high: number; low: number; close: number; volume: number;
  turnover?: number | null;    // 거래대금(공식 제공 시). 미제공=null
}
export interface DailyCacheBody {
  version: number;
  market: 'KR' | 'US';
  symbol: string;
  adjusted: boolean | null;    // 수정주가 여부(공식 확인 시). 미확인=null
  source: string;              // 데이터 출처(TR명 또는 'manual'/'hts-export')
  fetchedAt: string;           // 마지막 취득시각(ISO). ⚠️ 러너가 넘김(new Date 회피 위해 인자화)
  bars: DailyBar[];            // 과거→최근, date 오름차순, 중복 없음
}

// ── 순수 병합: 기존 + 신규 → date 유니크·오름차순. 신규가 같은 date 를 덮어씀(최근 취득 우선). ──
export function mergeDailyBars(existing: readonly DailyBar[], incoming: readonly DailyBar[]): DailyBar[] {
  const map = new Map<string, DailyBar>();
  for (const b of existing) if (b && b.date) map.set(b.date, b);
  for (const b of incoming) if (b && b.date) map.set(b.date, b);   // 신규 우선(덮어쓰기)
  return [...map.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

// 증분 취득에 필요한 '누락 시작일' — 캐시 마지막 date 의 다음날부터만 받으면 됨(없으면 null=전체).
export function lastCachedDate(body: DailyCacheBody | null): string | null {
  if (!body || body.bars.length === 0) return null;
  return body.bars[body.bars.length - 1].date;
}

export class DailyCache {
  readonly file: string;
  private tmp: string;
  body: DailyCacheBody | null = null;
  corrupt = false;

  constructor(public readonly market: 'KR' | 'US', public readonly symbol: string, dir = YEOKMAE_DAILY_DIR) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const safe = symbol.replace(/[^A-Za-z0-9_.-]/g, '_');
    this.file = join(dir, `${safe}.json`);
    this.tmp = this.file + '.tmp';
  }
  load(): void {
    if (!existsSync(this.file)) return;
    try { this.body = JSON.parse(readFileSync(this.file, 'utf8')); }
    catch { this.corrupt = true; try { renameSync(this.file, this.file + '.corrupt'); } catch { /* noop */ } }
  }
  bars(): DailyBar[] { return this.body?.bars ?? []; }
  toCandles(): Candle[] {
    return (this.body?.bars ?? []).map(b => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
  }
  // 증분 병합 저장. fetchedAtISO 는 러너가 넘김(순수성 유지). source/adjusted 는 취득경로가 지정.
  upsert(incoming: readonly DailyBar[], meta: { source: string; adjusted: boolean | null; fetchedAtISO: string }): { added: number; total: number } {
    const prev = this.body?.bars ?? [];
    const merged = mergeDailyBars(prev, incoming);
    const added = merged.length - prev.length;
    this.body = { version: VERSION, market: this.market, symbol: this.symbol, adjusted: meta.adjusted, source: meta.source, fetchedAt: meta.fetchedAtISO, bars: merged };
    return { added, total: merged.length };
  }
  flush(): void {
    if (!this.body) return;
    writeFileSync(this.tmp, JSON.stringify(this.body), 'utf8');
    renameSync(this.tmp, this.file);
  }
}
