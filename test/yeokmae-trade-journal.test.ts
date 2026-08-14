// P0-33 — 매매일지 영구기록 + 일일리포트 집계.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TradeJournal, computeDailyReport, formatDailyReport, type TradeJournalEntry } from '../local-runner/yeokmae-trade-journal';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'yeok-journal-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const buy = (o: Partial<TradeJournalEntry> = {}): TradeJournalEntry => ({
  ts: '2026-08-14T01:00:00.000Z', market: 'KR', side: 'BUY', symbol: '005930', name: '삼성전자',
  signalType: ['112_UPGRADE'], signalDate: '2026-08-13', orderPrice: 61000, fillPrice: 61000, qty: 1,
  investedKRW: 61000, exitReason: null, realizedPnL: null, ordNo: '900', status: 'placed-filled', ...o,
});
const sell = (o: Partial<TradeJournalEntry> = {}): TradeJournalEntry => ({
  ...buy(), side: 'SELL', investedKRW: null, exitReason: 'TAKE_PROFIT', realizedPnL: 5000, ...o,
});

describe('P0-33 TradeJournal — 영구기록/복원', () => {
  it('append → flush → 재로드 복원', () => {
    const j = new TradeJournal('KR', dir); j.load();
    j.append(buy()); j.append(sell()); j.flush();
    const j2 = new TradeJournal('KR', dir); j2.load();
    expect(j2.entries()).toHaveLength(2);
    expect(j2.entries()[0].side).toBe('BUY');
    expect(j2.entries()[1].side).toBe('SELL');
  });
});

describe('P0-33 computeDailyReport — 집계', () => {
  it('buys/sells/realizedPnL/winRate/capitalUsed 집계', () => {
    const entries = [
      buy({ symbol: 'A', qty: 1, investedKRW: 61000 }),
      sell({ symbol: 'B', realizedPnL: 5000 }),   // 승
      sell({ symbol: 'C', realizedPnL: -2000 }),  // 패
    ];
    const holdings = [{ symbol: 'A', qty: 1, entryAvgPrice: 61000, lastPrice: 62000 }];
    const r = computeDailyReport({ market: 'KR', date: '2026-08-14', signals: 3, entries, holdings });
    expect(r.buys).toBe(1);
    expect(r.sells).toBe(2);
    expect(r.realizedPnL).toBe(3000);            // 5000-2000
    expect(r.winRate).toBeCloseTo(0.5, 5);       // 1/2
    expect(r.unrealizedPnL).toBe(1000);          // (62000-61000)*1
    expect(r.capitalUsedKRW).toBe(61000);
    expect(r.holdings).toBe(1);
  });
  it('다른 날짜 항목은 제외', () => {
    const entries = [buy({ ts: '2026-08-13T01:00:00.000Z' }), buy({ ts: '2026-08-14T02:00:00.000Z' })];
    const r = computeDailyReport({ market: 'KR', date: '2026-08-14', signals: 0, entries, holdings: [] });
    expect(r.buys).toBe(1);
  });
  it('현재가 미확보 → unrealizedPnL=null (추측 안 함)', () => {
    const r = computeDailyReport({ market: 'KR', date: '2026-08-14', signals: 0, entries: [], holdings: [{ symbol: 'A', qty: 1, entryAvgPrice: 61000, lastPrice: null }] });
    expect(r.unrealizedPnL).toBeNull();
    expect(formatDailyReport(r)).toContain('unrealizedPnL=n/a');
  });
  it('SELL 없으면 winRate=null', () => {
    const r = computeDailyReport({ market: 'KR', date: '2026-08-14', signals: 0, entries: [buy()], holdings: [] });
    expect(r.winRate).toBeNull();
  });
  it('formatDailyReport 태그/필드', () => {
    const r = computeDailyReport({ market: 'KR', date: '2026-08-14', signals: 2, entries: [buy(), sell()], holdings: [] });
    const line = formatDailyReport(r);
    expect(line).toContain('[YEOKMAE-DAILY-REPORT]');
    expect(line).toContain('signals=2');
    expect(line).toContain('buys=1');
    expect(line).toContain('sells=1');
  });
});
