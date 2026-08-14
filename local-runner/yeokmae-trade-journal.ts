// 역매공파 실전 매매일지 + 일일리포트 (P0-33) — 모든 BUY/SELL 영구기록 + [YEOKMAE-DAILY-REPORT]. 주문 0(기록 전용).
//   ⚠️ 원본 수식/게이트 무변경. 파일은 시장별 append-only(atomic). realizedPnL 은 SELL 시 (fill-entry)×qty.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { YEOKMAE_DAILY_ROOT } from './yeokmae-daily-cache';

export interface TradeJournalEntry {
  ts: string;                       // ISO 기록시각
  market: 'KR' | 'US'; side: 'BUY' | 'SELL';
  symbol: string; name: string;
  signalType: string[]; signalDate: string | null;
  orderPrice: number; fillPrice: number | null; qty: number;
  investedKRW: number | null;       // BUY: fill×qty(원). SELL: null(청산금액은 realizedPnL 로)
  exitReason: string | null;        // SELL 사유(STOP_LOSS/TAKE_PROFIT/MAX_HOLD_DAYS/EMERGENCY 등)
  realizedPnL: number | null;       // SELL: (fillPrice-entryAvg)×qty. BUY: null
  ordNo: string | null; status: string;
}
interface JournalBody { version: number; market: 'KR' | 'US'; entries: TradeJournalEntry[] }
const VERSION = 1;

export class TradeJournal {
  readonly file: string; private tmp: string; private body: JournalBody; corrupt = false;
  constructor(public readonly market: 'KR' | 'US', dir = YEOKMAE_DAILY_ROOT) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.file = join(dir, `${market}.trade-journal.json`);
    this.tmp = this.file + '.tmp';
    this.body = { version: VERSION, market, entries: [] };
  }
  load(): void {
    if (!existsSync(this.file)) return;
    try { const d = JSON.parse(readFileSync(this.file, 'utf8')); if (!d || !Array.isArray(d.entries)) { this.corrupt = true; return; } this.body = { version: VERSION, market: this.market, entries: d.entries }; }
    catch { this.corrupt = true; try { renameSync(this.file, this.file + '.corrupt'); } catch { /* noop */ } }
  }
  append(e: TradeJournalEntry): void { if (this.corrupt) return; this.body.entries.push(e); }
  entries(): TradeJournalEntry[] { return this.body.entries; }
  flush(): void { if (this.corrupt) return; writeFileSync(this.tmp, JSON.stringify(this.body, null, 2), 'utf8'); renameSync(this.tmp, this.file); }
}

// ── 일일 리포트(순수) — 특정 날짜의 매매일지 + 현재 보유로 집계. ──
export interface DailyReportInput {
  market: 'KR' | 'US'; date: string;              // YYYY-MM-DD (해당일 필터)
  signals: number;                                 // 오늘 관측된 신호 종목수
  entries: readonly TradeJournalEntry[];           // 전체 일지(내부에서 date 필터)
  holdings: readonly { symbol: string; qty: number; entryAvgPrice: number; lastPrice: number | null }[];
}
export interface DailyReport {
  market: 'KR' | 'US'; date: string;
  signals: number; buys: number; sells: number; holdings: number;
  realizedPnL: number; unrealizedPnL: number | null; winRate: number | null; capitalUsedKRW: number;
}
export function computeDailyReport(inp: DailyReportInput): DailyReport {
  const today = inp.entries.filter(e => (e.ts || '').slice(0, 10) === inp.date);
  const buys = today.filter(e => e.side === 'BUY').length;
  const sellEntries = today.filter(e => e.side === 'SELL');
  const sells = sellEntries.length;
  const realizedPnL = sellEntries.reduce((s, e) => s + (e.realizedPnL ?? 0), 0);
  // 승률 = realizedPnL>0 인 SELL / 전체 SELL(청산 있을 때만).
  const wins = sellEntries.filter(e => (e.realizedPnL ?? 0) > 0).length;
  const winRate = sells > 0 ? wins / sells : null;
  // 미실현 = Σ(lastPrice-entryAvg)×qty (lastPrice 있는 보유만). 하나라도 미확보면 부분(가능분만).
  let unreal = 0; let unrealKnown = false;
  for (const h of inp.holdings) { if (h.lastPrice != null && h.entryAvgPrice > 0 && h.qty > 0) { unreal += (h.lastPrice - h.entryAvgPrice) * h.qty; unrealKnown = true; } }
  const capitalUsedKRW = inp.holdings.reduce((s, h) => s + (h.qty > 0 && h.entryAvgPrice > 0 ? h.qty * h.entryAvgPrice : 0), 0);
  return {
    market: inp.market, date: inp.date, signals: inp.signals, buys, sells, holdings: inp.holdings.filter(h => h.qty > 0).length,
    realizedPnL, unrealizedPnL: unrealKnown ? unreal : null, winRate, capitalUsedKRW,
  };
}
export function formatDailyReport(r: DailyReport): string {
  const pct = r.winRate == null ? 'n/a' : `${(r.winRate * 100).toFixed(0)}%`;
  const un = r.unrealizedPnL == null ? 'n/a(현재가 미확보)' : Math.round(r.unrealizedPnL).toString();
  return `[YEOKMAE-DAILY-REPORT] market=${r.market} date=${r.date} signals=${r.signals} buys=${r.buys} sells=${r.sells}`
    + ` holdings=${r.holdings} realizedPnL=${Math.round(r.realizedPnL)} unrealizedPnL=${un} winRate=${pct} capitalUsedKRW=${Math.round(r.capitalUsedKRW)}`;
}
