// 해외 15분봉 영구 저장/복원 — 종목별 JSON 파일. 확정봉만 영구 저장(형성봉은 별도).
// 안전성: 임시파일 write 후 rename(atomic). 파일 손상 시 corrupt 플래그(주문 금지 신호).
// ⚠️ 앱키/토큰/계좌번호는 절대 저장하지 않는다 — OHLCV + timestamp 만.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';

export interface StoredCandle { datetime: string; open: number; high: number; low: number; close: number; volume: number; }

const DEFAULT_DIR = resolve(process.cwd(), 'local-runner', 'data');
const MAX_KEEP = 400;   // 최근 최대 400개 유지(≥60 보장)
const VERSION = 1;

export class CandleStore {
  readonly file: string;
  private tmp: string;
  private confirmed = new Map<string, StoredCandle>();
  forming: StoredCandle | null = null;
  corrupt = false;

  constructor(public readonly symbol: string, dir = DEFAULT_DIR) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const safe = symbol.replace(/[^A-Za-z0-9_.-]/g, '_');
    this.file = join(dir, `us-candles-${safe}.json`);
    this.tmp = this.file + '.tmp';
  }

  /** 파일 로드. 손상 시 corrupt=true + .corrupt 백업. 없으면 빈 상태. */
  load(): void {
    if (!existsSync(this.file)) return;
    let raw: string;
    try { raw = readFileSync(this.file, 'utf8'); }
    catch { this.corrupt = true; return; }
    try {
      const d = JSON.parse(raw) as { confirmed?: Record<string, StoredCandle>; forming?: StoredCandle | null };
      for (const [ts, c] of Object.entries(d.confirmed ?? {})) {
        if (c && typeof c.close === 'number') this.confirmed.set(ts, { ...c, datetime: ts });
      }
      this.forming = d.forming ?? null;
    } catch {
      this.corrupt = true;
      try { renameSync(this.file, this.file + '.corrupt'); } catch { /* noop */ }
    }
  }

  /** 확정봉 upsert. 신규/변경이면 true(→flush 필요), 동일 중복이면 false. */
  upsertConfirmed(c: StoredCandle): boolean {
    const prev = this.confirmed.get(c.datetime);
    if (prev && prev.open === c.open && prev.high === c.high && prev.low === c.low && prev.close === c.close && prev.volume === c.volume) {
      return false;   // 같은 timestamp 중복 저장 금지
    }
    this.confirmed.set(c.datetime, { ...c });
    // 최근 MAX_KEEP 개만 유지
    if (this.confirmed.size > MAX_KEEP) {
      const keys = [...this.confirmed.keys()].sort();
      for (const k of keys.slice(0, this.confirmed.size - MAX_KEEP)) this.confirmed.delete(k);
    }
    return true;
  }

  setForming(c: StoredCandle | null): void { this.forming = c ? { ...c } : null; }

  /** 확정봉 oldest→newest. */
  confirmedSorted(): StoredCandle[] {
    return [...this.confirmed.values()].sort((a, b) => a.datetime.localeCompare(b.datetime));
  }
  get confirmedCount(): number { return this.confirmed.size; }

  /** atomic write: tmp → rename. corrupt 상태면 저장하지 않는다(추가 손상 방지). */
  flush(): void {
    if (this.corrupt) return;
    const confirmed: Record<string, StoredCandle> = {};
    for (const c of this.confirmedSorted()) confirmed[c.datetime] = c;
    const body = JSON.stringify({ version: VERSION, symbol: this.symbol, confirmed, forming: this.forming });
    writeFileSync(this.tmp, body, 'utf8');
    renameSync(this.tmp, this.file);   // atomic
  }
}
