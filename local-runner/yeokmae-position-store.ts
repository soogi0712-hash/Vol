// 역매공파 포지션 영구저장 (P0-34) — strategyTag='YEOKMAE' 포지션 상태 + 재시작 복원. ⚠️ 원본 BUY 무변경, 실주문 없음.
//   기존 us-positions.json(BB 경로)과 분리된 별도 저장소 → BB SELL 이 역매공파 포지션에 적용되지 않게 물리 분리.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DEFAULT_YEOKMAE_EXIT_CONFIG, type ProfitMode, type YeokmaeExitReason } from '../src/lib/yeokmae';

const DEFAULT_DIR = resolve(process.cwd(), 'local-runner', 'data');
const VERSION = 1;

export interface YeokmaePosition {
  symbol: string;
  strategyTag: 'YEOKMAE';
  exchcd: string;
  entryDate: string;            // 진입일 YYYY-MM-DD
  entryAvgPrice: number;        // 진입 평균가(가중)
  qty: number;
  highestPrice: number;         // 진입 후 최고가
  highestPnlPct: number;        // 최고 수익률
  stopLossPct: number;
  profitMode: ProfitMode;
  takeProfitPct: number;
  trailingActivatePct: number;
  trailingDrawdownPct: number;
  holdDays: number;
  lastExitReason: YeokmaeExitReason | null;
  confirmedSignalDate?: string | null;   // P0-35P2: 진입 근거 confirmed 신호일
  matchedSignals?: string[];             // P0-35P2: 진입 시 matched 5신호
}
// P0-35US10: 청산 체결 기록(전량 SELL 후 포지션이 삭제돼도 realizedPnL/사유를 영구 보존).
export interface YeokmaeExitRecordEntry {
  symbol: string; exitReason: YeokmaeExitReason; exitDate: string;
  filledQty: number; avgFill: number; entryAvgPrice: number; realizedPnLGross: number; remainingQty: number;
}
interface Body { version: number; positions: Record<string, YeokmaePosition>; exits?: YeokmaeExitRecordEntry[] }

export class YeokmaePositionStore {
  readonly file: string;
  private tmp: string;
  private body: Body;
  corrupt = false;

  constructor(dir = DEFAULT_DIR) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'us-yeokmae-positions.json');
    this.tmp = this.file + '.tmp';
    this.body = { version: VERSION, positions: {}, exits: [] };
  }
  load(): void {
    if (!existsSync(this.file)) return;
    try {
      const d = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Body>;
      if (!d || typeof d !== 'object' || !d.positions) { this.corrupt = true; return; }
      this.body = { version: VERSION, positions: d.positions, exits: Array.isArray(d.exits) ? d.exits : [] };
    } catch { this.corrupt = true; try { renameSync(this.file, this.file + '.corrupt'); } catch { /* noop */ } }
  }
  get(symbol: string): YeokmaePosition | null { return this.body.positions[symbol] ?? null; }
  all(): YeokmaePosition[] { return Object.values(this.body.positions); }
  exits(): YeokmaeExitRecordEntry[] { return this.body.exits ?? []; }

  // 역매공파 BUY 체결 → 진입/증분(가중평균). config 스냅샷 저장(재시작 복원). flush 필요.
  applyYeokmaeBuyFill(p: {
    symbol: string; exchcd: string; entryDate: string; fillQty: number; fillPrice: number;
    confirmedSignalDate?: string | null; matchedSignals?: string[];
    config?: Partial<typeof DEFAULT_YEOKMAE_EXIT_CONFIG>;
  }): void {
    if (!(p.fillQty > 0)) return;
    const cfg = { ...DEFAULT_YEOKMAE_EXIT_CONFIG, ...(p.config ?? {}) };
    const cur = this.body.positions[p.symbol];
    if (!cur) {
      this.body.positions[p.symbol] = {
        symbol: p.symbol, strategyTag: 'YEOKMAE', exchcd: p.exchcd, entryDate: p.entryDate,
        entryAvgPrice: p.fillPrice, qty: p.fillQty, highestPrice: p.fillPrice,
        highestPnlPct: 0, stopLossPct: cfg.stopLossPct, profitMode: cfg.profitMode, takeProfitPct: cfg.takeProfitPct,
        trailingActivatePct: cfg.trailingActivatePct, trailingDrawdownPct: cfg.trailingDrawdownPct,
        holdDays: 0, lastExitReason: null,
        confirmedSignalDate: p.confirmedSignalDate ?? null, matchedSignals: p.matchedSignals ?? [],
      };
    } else {
      const newQty = cur.qty + p.fillQty;
      cur.entryAvgPrice = newQty > 0 ? (cur.qty * cur.entryAvgPrice + p.fillQty * p.fillPrice) / newQty : p.fillPrice;
      cur.qty = newQty;
      cur.highestPrice = Math.max(cur.highestPrice, p.fillPrice);
    }
  }
  // 실시간가 관찰 → 최고가/최고수익률 갱신(재시작 복원 대상). flush 필요.
  updateHighest(symbol: string, price: number): void {
    const cur = this.body.positions[symbol]; if (!cur || !(price > 0)) return;
    if (price > cur.highestPrice) cur.highestPrice = price;
    if (cur.entryAvgPrice > 0) cur.highestPnlPct = (cur.highestPrice - cur.entryAvgPrice) / cur.entryAvgPrice * 100;
  }
  setHoldDays(symbol: string, days: number): void { const c = this.body.positions[symbol]; if (c) c.holdDays = Math.max(0, Math.floor(days)); }
  syncQty(symbol: string, qty: number): void {
    const c = this.body.positions[symbol]; if (!c) return;
    if (!(qty > 0)) delete this.body.positions[symbol]; else c.qty = qty;
  }
  recordExit(symbol: string, reason: YeokmaeExitReason, remainingQty: number): void {
    const c = this.body.positions[symbol]; if (!c) return;
    c.lastExitReason = reason;
    if (!(remainingQty > 0)) delete this.body.positions[symbol]; else c.qty = remainingQty;
  }
  // P0-35US10: SELL 체결 반영 — realizedPnL gross(=(체결가-진입평균가)*체결수량) 를 exits 로그에 영구저장 후
  //   잔여수량 반영(0 이면 포지션 삭제). 원본 P0-34 정책/임계값 무변경(수량·기록 배선만). flush 필요.
  recordSellFill(symbol: string, p: { exitReason: YeokmaeExitReason; filledQty: number; avgFill: number; exitDate: string }): { realizedPnLGross: number; remainingQty: number } {
    const cur = this.body.positions[symbol];
    if (!cur) return { realizedPnLGross: 0, remainingQty: 0 };
    const filled = Math.max(0, Math.floor(p.filledQty));
    const realizedPnLGross = (p.avgFill - cur.entryAvgPrice) * filled;
    const remainingQty = Math.max(0, cur.qty - filled);
    cur.lastExitReason = p.exitReason;
    if (!this.body.exits) this.body.exits = [];
    this.body.exits.push({ symbol, exitReason: p.exitReason, exitDate: p.exitDate, filledQty: filled, avgFill: p.avgFill, entryAvgPrice: cur.entryAvgPrice, realizedPnLGross, remainingQty });
    if (remainingQty <= 0) delete this.body.positions[symbol]; else cur.qty = remainingQty;
    return { realizedPnLGross, remainingQty };
  }
  flush(): void { if (this.corrupt) return; writeFileSync(this.tmp, JSON.stringify(this.body), 'utf8'); renameSync(this.tmp, this.file); }
}
