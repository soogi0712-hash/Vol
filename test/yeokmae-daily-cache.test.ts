import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeDailyBars, lastCachedDate, DailyCache, type DailyBar } from '../local-runner/yeokmae-daily-cache';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'yk-daily-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const bar = (date: string, close = 100): DailyBar => ({ date, open: close, high: close + 1, low: close - 1, close, volume: 1000 });

describe('P0-32A 일봉 캐시 — 증분 병합/재시작 복원', () => {
  it('mergeDailyBars — date 유니크·오름차순, 신규가 기존 덮어씀', () => {
    const existing = [bar('2023-01-01', 10), bar('2023-01-02', 20)];
    const incoming = [bar('2023-01-02', 25), bar('2023-01-03', 30)];   // 01-02 갱신 + 01-03 신규
    const m = mergeDailyBars(existing, incoming);
    expect(m.map(b => b.date)).toEqual(['2023-01-01', '2023-01-02', '2023-01-03']);
    expect(m[1].close).toBe(25);   // 신규 우선
  });
  it('lastCachedDate — 마지막 캐시 date(증분 시작점)', () => {
    expect(lastCachedDate(null)).toBeNull();
    expect(lastCachedDate({ version: 1, market: 'KR', symbol: 'X', adjusted: null, source: 't', fetchedAt: '', bars: [bar('2023-01-01'), bar('2023-01-05')] })).toBe('2023-01-05');
  });
  it('DailyCache — upsert 증분(added 수) + flush/load 복원', () => {
    const c1 = new DailyCache('KR', '005930', dir);
    c1.load();
    const r1 = c1.upsert([bar('2023-01-01'), bar('2023-01-02')], { source: 't8413', adjusted: true, fetchedAtISO: '2023-01-02T00:00:00Z' });
    expect(r1).toEqual({ added: 2, total: 2 });
    c1.flush();
    // 재실행 — 누락분만 증분
    const c2 = new DailyCache('KR', '005930', dir);
    c2.load();
    expect(c2.bars().length).toBe(2);
    const r2 = c2.upsert([bar('2023-01-02'), bar('2023-01-03')], { source: 't8413', adjusted: true, fetchedAtISO: '2023-01-03T00:00:00Z' });
    expect(r2).toEqual({ added: 1, total: 3 });   // 01-03 만 신규
    c2.flush();
    const c3 = new DailyCache('KR', '005930', dir); c3.load();
    expect(c3.toCandles().map(b => b.date)).toEqual(['2023-01-01', '2023-01-02', '2023-01-03']);
    expect(c3.body?.source).toBe('t8413');
    expect(c3.body?.adjusted).toBe(true);
  });
  it('toCandles — OHLCV 만 추출(지표 입력용)', () => {
    const c = new DailyCache('US', 'AAPL', dir);
    c.upsert([bar('2023-01-01', 150)], { source: 'g3103', adjusted: null, fetchedAtISO: 'x' });
    expect(c.toCandles()[0]).toEqual({ date: '2023-01-01', open: 150, high: 151, low: 149, close: 150, volume: 1000 });
  });
});
