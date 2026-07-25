import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Candle } from '../src/lib/kis-api';

// loadKRTradeCandles 가 내부에서 쓰는 fetchKR1MinPage 만 모킹
const kis = vi.hoisted(() => ({ fetchKR1MinPage: vi.fn() }));
vi.mock('../src/lib/kis-api', () => ({ fetchKR1MinPage: kis.fetchKR1MinPage }));

import { loadKRTradeCandles } from '../src/lib/kr-trade-source';

// ── 인메모리 candle_history 를 흉내내는 초경량 D1 ───────────────
// loadKRTradeCandles 가 던지는 SQL(4종)을 substring 으로 분기한다.
function makeDB() {
  const store = new Map<string, { open: number; high: number; low: number; close: number; volume: number }>();
  const mk = (sql: string, args: any[] = []): any => ({
    bind: (...a: any[]) => mk(sql, a),
    first: async () => {
      if (/ORDER BY candle_ts DESC LIMIT 1/.test(sql)) {
        const keys = [...store.keys()].sort();
        return keys.length ? { candle_ts: keys[keys.length - 1] } : null;
      }
      return null;
    },
    all: async () => {
      if (/SELECT candle_ts, open/.test(sql)) {
        // 최종 조회: DESC LIMIT ?  (args = [ticker, count])
        const limit = args[1] ?? 9999;
        const keys = [...store.keys()].sort().reverse().slice(0, limit);
        return { results: keys.map(ts => ({ candle_ts: ts, ...store.get(ts)! })) };
      }
      // upsert 전 기존 candle_ts 집합
      return { results: [...store.keys()].map(candle_ts => ({ candle_ts })) };
    },
    run: async () => ({}),
  });
  const DB: any = {
    prepare: (sql: string) => mk(sql),
    batch: async (stmts: any[]) => {
      for (const s of stmts) {
        const a = s.__args as any[];
        // [market, symbol, timeframe, datetime, open, high, low, close, volume]
        store.set(a[3], { open: a[4], high: a[5], low: a[6], close: a[7], volume: a[8] });
      }
      return [];
    },
  };
  // batch 용: bind 가 인자를 __args 로 보관하도록 mk 확장
  const origPrepare = DB.prepare;
  DB.prepare = (sql: string) => {
    const stmt = origPrepare(sql);
    const origBind = stmt.bind;
    stmt.bind = (...a: any[]) => { const s = origBind(...a); s.__args = a; return s; };
    return stmt;
  };
  return { DB, store };
}

const cfg = { appKey: 'k', appSecret: 's', accountNo: 'n', accountSuffix: '01' };
const limiter: any = { run: (fn: () => any) => fn() };   // 무지연 스텁
const kstMs = (h: number, m: number) => Date.UTC(2026, 0, 5, h - 9, m);

// 20260105 09:00~ n분간 1분봉 (close 구분값)
function oneMin(startMin: number, count: number): Candle[] {
  const bars: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const total = 9 * 60 + startMin + i, hh = Math.floor(total / 60), mm = total % 60;
    const ts = `20260105${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}00`;
    const v = 100 + startMin + i;
    bars.push({ ticker: '005930', market: 'KR', datetime: ts, open: v, high: v + 0.5, low: v - 0.5, close: v, volume: 10 });
  }
  return bars;
}

beforeEach(() => { kis.fetchKR1MinPage.mockReset(); });

describe('loadKRTradeCandles (Phase 3 KR 매매 소스)', () => {
  it('부트스트랩: 1분봉 → 완성 15분봉만 candle_history 저장 후 oldest→newest 반환', async () => {
    const all = oneMin(0, 60);   // 09:00~09:59
    kis.fetchKR1MinPage.mockImplementation(async (_c: any, _t: any, _tk: any, end: string) => {
      const endTs = '20260105' + end;
      return all.filter(b => b.datetime <= endTs).sort((a, b) => a.datetime.localeCompare(b.datetime)).slice(-30);
    });
    const { DB, store } = makeDB();
    const r = await loadKRTradeCandles({
      db: DB, cfg, token: 'tok', ticker: '005930', count: 41, nowMs: kstMs(10, 5), limiter,
    });
    expect(r.mode).toBe('bootstrap');
    // 10:05 기준 09:00/09:15/09:30/09:45 완성 (4개)
    expect(r.candles.map(c => c.datetime)).toEqual([
      '20260105090000', '20260105091500', '20260105093000', '20260105094500',
    ]);
    expect(r.inserted).toBe(4);
    expect(store.size).toBe(4);
    // oldest→newest 정렬 확인
    expect(r.candles[0].datetime < r.candles[3].datetime).toBe(true);
    // 완성 15분봉 OHLC: 09:00 버킷 open=첫봉, close=09:14 종가
    expect(r.candles[0].open).toBe(100);
    expect(r.candles[0].close).toBe(114);
  });

  it('증분 재실행: 신규 없음(중복 저장 0)', async () => {
    const all = oneMin(0, 60);
    kis.fetchKR1MinPage.mockImplementation(async (_c: any, _t: any, _tk: any, end: string) => {
      const endTs = '20260105' + end;
      return all.filter(b => b.datetime <= endTs).sort((a, b) => a.datetime.localeCompare(b.datetime)).slice(-30);
    });
    const { DB, store } = makeDB();
    await loadKRTradeCandles({ db: DB, cfg, token: 'tok', ticker: '005930', count: 41, nowMs: kstMs(10, 5), limiter });
    const r2 = await loadKRTradeCandles({ db: DB, cfg, token: 'tok', ticker: '005930', count: 41, nowMs: kstMs(10, 5), limiter });
    expect(r2.mode).toBe('incremental');
    expect(r2.inserted).toBe(0);
    expect(store.size).toBe(4);
    expect(r2.candles).toHaveLength(4);
  });
});
