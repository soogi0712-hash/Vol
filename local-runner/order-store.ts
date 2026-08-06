// 주문 상태 영구 저장 — 하루 매수/매도 횟수 제한, 동일 확정봉 중복주문 방지, 미체결 추적,
// 재시작 중복주문 방지. 원자적 저장(tmp→rename). ⚠️ 앱키/토큰/계좌번호는 저장하지 않는다.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';

export interface PendingOrder { ordNo: string; symbol: string; candleKey: string; qty: number; price: number; etDate: string; }
interface DayCount { buy: number; sell: number; }
interface OrderStoreBody {
  version: number;
  symbol: string;
  days: Record<string, DayCount>;      // etDate(YYYYMMDD) → {buy,sell}
  orderedCandles: string[];            // 주문한 확정봉 키(symbol|candleDatetime|side)
  pending: PendingOrder[];             // 미체결(체결확인/취소 대상)
}

const DEFAULT_DIR = resolve(process.cwd(), 'local-runner', 'data');
const VERSION = 1;
export const MAX_BUY_PER_DAY = 1;      // 하루 매수 1회
export const MAX_SELL_PER_DAY = 1;     // 하루 매도 1회

export class OrderStore {
  readonly file: string;
  private tmp: string;
  private body: OrderStoreBody;
  corrupt = false;

  constructor(public readonly symbol: string, dir = DEFAULT_DIR) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const safe = symbol.replace(/[^A-Za-z0-9_.-]/g, '_');
    this.file = join(dir, `us-orders-${safe}.json`);
    this.tmp = this.file + '.tmp';
    this.body = { version: VERSION, symbol, days: {}, orderedCandles: [], pending: [] };
  }

  load(): void {
    if (!existsSync(this.file)) return;
    let raw: string;
    try { raw = readFileSync(this.file, 'utf8'); } catch { this.corrupt = true; return; }
    try {
      const d = JSON.parse(raw) as Partial<OrderStoreBody>;
      this.body = {
        version: VERSION, symbol: this.symbol,
        days: d.days ?? {},
        orderedCandles: Array.isArray(d.orderedCandles) ? d.orderedCandles : [],
        pending: Array.isArray(d.pending) ? d.pending : [],
      };
    } catch {
      this.corrupt = true;
      try { renameSync(this.file, this.file + '.corrupt'); } catch { /* noop */ }
    }
  }

  private key(candleDatetime: string, side: 'buy' | 'sell'): string { return `${this.symbol}|${candleDatetime}|${side}`; }

  /** 이 확정봉에 이미 주문했는가(재시작 후에도 유지 — 중복주문 방지). */
  hasOrderedCandle(candleDatetime: string, side: 'buy' | 'sell'): boolean {
    return this.body.orderedCandles.includes(this.key(candleDatetime, side));
  }
  buyCountToday(etDate: string): number { return this.body.days[etDate]?.buy ?? 0; }
  sellCountToday(etDate: string): number { return this.body.days[etDate]?.sell ?? 0; }
  canBuyToday(etDate: string): boolean { return this.buyCountToday(etDate) < MAX_BUY_PER_DAY; }
  canSellToday(etDate: string): boolean { return this.sellCountToday(etDate) < MAX_SELL_PER_DAY; }
  hasPending(): boolean { return this.body.pending.length > 0; }
  get pending(): PendingOrder[] { return [...this.body.pending]; }

  /** 주문 성사(전송 성공) 기록 — 일일 카운트 증가 + 확정봉 키 + 미체결 목록 추가. flush 필요. */
  recordPlaced(side: 'buy' | 'sell', candleDatetime: string, etDate: string, order: Omit<PendingOrder, 'candleKey' | 'etDate'>): void {
    const day = this.body.days[etDate] ?? { buy: 0, sell: 0 };
    day[side] += 1;
    this.body.days[etDate] = day;
    const k = this.key(candleDatetime, side);
    if (!this.body.orderedCandles.includes(k)) this.body.orderedCandles.push(k);
    this.body.pending.push({ ...order, candleKey: k, etDate });
  }
  /** 미체결 해소(체결완료/취소완료) — pending 에서 제거. flush 필요. */
  resolvePending(ordNo: string): void { this.body.pending = this.body.pending.filter(p => p.ordNo !== ordNo); }

  flush(): void {
    if (this.corrupt) return;
    writeFileSync(this.tmp, JSON.stringify(this.body), 'utf8');
    renameSync(this.tmp, this.file);
  }
}
