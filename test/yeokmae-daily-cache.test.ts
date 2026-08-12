import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeDailyBars, lastConfirmedCachedDate, DailyCache, type DailyBar } from '../local-runner/yeokmae-daily-cache';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'yk-daily-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const bar = (date: string, close = 100, confirmed = true): DailyBar =>
  ({ date, open: close, high: close + 1, low: close - 1, close, volume: 1000, turnoverKRW: null, confirmed });

describe('P0-32B 일봉 캐시 v2 — 병합/멱등/재시작/손상', () => {
  it('mergeDailyBars — date 유니크·오름차순, 신규가 기존 덮어씀', () => {
    const existing = [bar('2023-01-01', 10), bar('2023-01-02', 20)];
    const incoming = [bar('2023-01-02', 25), bar('2023-01-03', 30)];
    const m = mergeDailyBars(existing, incoming);
    expect(m.map(b => b.date)).toEqual(['2023-01-01', '2023-01-02', '2023-01-03']);
    expect(m[1].close).toBe(25);   // 같은 confirmed 상태면 신규 우선
  });

  it('mergeDailyBars — confirmed 가 provisional 을 덮어쓴다(반대는 유지)', () => {
    const existing = [bar('2023-01-02', 20, true)];                 // 기존: 확정
    const incoming = [bar('2023-01-02', 99, false)];                // 신규: 진행중 → 무시
    const m1 = mergeDailyBars(existing, incoming);
    expect(m1[0].close).toBe(20);
    expect(m1[0].confirmed).toBe(true);
    // 반대: 기존 provisional → 신규 confirmed 로 승격
    const m2 = mergeDailyBars([bar('2023-01-02', 20, false)], [bar('2023-01-02', 21, true)]);
    expect(m2[0].close).toBe(21);
    expect(m2[0].confirmed).toBe(true);
  });

  it('mergeDailyBars — 멱등(같은 배열 두 번 병합 = 그대로)', () => {
    const base = [bar('2023-01-01'), bar('2023-01-02'), bar('2023-01-03')];
    const once = mergeDailyBars([], base);
    const twice = mergeDailyBars(once, base);
    expect(twice).toEqual(once);
  });

  it('lastConfirmedCachedDate — 마지막 확정봉 date(진행중봉 제외)', () => {
    expect(lastConfirmedCachedDate([])).toBeNull();
    const bars = [bar('2023-01-01', 10, true), bar('2023-01-05', 12, true), bar('2023-01-06', 13, false)];
    expect(lastConfirmedCachedDate(bars)).toBe('2023-01-05');   // 01-06 은 진행중 → 제외
  });

  it('DailyCache — <market>/<symbol>.json 경로 + upsert 증분 + flush/load 복원', () => {
    const c1 = new DailyCache('KR', '005930', dir);
    c1.load();
    const r1 = c1.upsert([bar('2023-01-01'), bar('2023-01-02')], { sourceTR: 't8413', adjustment: 'ADJUSTED', fetchedAtISO: '2023-01-02T00:00:00Z' });
    expect(r1).toEqual({ added: 2, total: 2 });
    c1.flush();
    expect(existsSync(join(dir, 'KR', '005930.json'))).toBe(true);

    const c2 = new DailyCache('KR', '005930', dir); c2.load();
    expect(c2.bars().length).toBe(2);
    const r2 = c2.upsert([bar('2023-01-02'), bar('2023-01-03')], { sourceTR: 't8413', adjustment: 'ADJUSTED', fetchedAtISO: '2023-01-03T00:00:00Z' });
    expect(r2).toEqual({ added: 1, total: 3 });
    c2.flush();

    const c3 = new DailyCache('KR', '005930', dir); c3.load();
    expect(c3.toCandles().map(b => b.date)).toEqual(['2023-01-01', '2023-01-02', '2023-01-03']);
    expect(c3.body?.sourceTR).toBe('t8413');
    expect(c3.body?.adjustment).toBe('ADJUSTED');
    expect(c3.body?.version).toBe(2);
  });

  it('DailyCache — provisional → confirmed 재취득 시 대체 + confirmedThrough 갱신', () => {
    const c = new DailyCache('KR', '000660', dir); c.load();
    c.upsert([bar('2023-02-01', 50, true), bar('2023-02-02', 51, false)], { sourceTR: 't', adjustment: 'RAW', fetchedAtISO: 'x' });
    expect(c.body?.confirmedThrough).toBe('2023-02-01');
    expect(c.body?.provisionalDate).toBe('2023-02-02');
    // 다음날: 02-02 가 확정으로 재취득 + 02-03 진행중
    c.upsert([bar('2023-02-02', 52, true), bar('2023-02-03', 53, false)], { sourceTR: 't', adjustment: 'RAW', fetchedAtISO: 'y' });
    expect(c.body?.confirmedThrough).toBe('2023-02-02');
    expect(c.body?.provisionalDate).toBe('2023-02-03');
    const b0202 = c.body?.bars.find(b => b.date === '2023-02-02');
    expect(b0202?.confirmed).toBe(true);
    expect(b0202?.close).toBe(52);
  });

  it('DailyCache — 손상 캐시(JSON 아님) → corrupt=true, 신호계산 입력 안 됨', () => {
    mkdirSync(join(dir, 'US'), { recursive: true });
    writeFileSync(join(dir, 'US', 'AAPL.json'), '{ this is not valid json', 'utf8');
    const c = new DailyCache('US', 'AAPL', dir); c.load();
    expect(c.corrupt).toBe(true);
    expect(c.toCandles()).toEqual([]);
  });

  it('DailyCache — bars 배열 없는 형식 → corrupt', () => {
    mkdirSync(join(dir, 'KR'), { recursive: true });
    writeFileSync(join(dir, 'KR', 'X.json'), JSON.stringify({ version: 2, market: 'KR' }), 'utf8');
    const c = new DailyCache('KR', 'X', dir); c.load();
    expect(c.corrupt).toBe(true);
  });

  it('toCandles(confirmedOnly) — 진행중봉 제외 옵션', () => {
    const c = new DailyCache('US', 'MSFT', dir); c.load();
    c.upsert([bar('2023-03-01', 10, true), bar('2023-03-02', 11, false)], { sourceTR: 'g', adjustment: 'UNKNOWN', fetchedAtISO: 'x' });
    expect(c.toCandles().length).toBe(2);
    expect(c.toCandles(true).map(b => b.date)).toEqual(['2023-03-01']);
  });
});
