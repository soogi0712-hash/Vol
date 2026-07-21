import { describe, it, expect, vi } from 'vitest';
import {
  updateIndicatorSnapshot, dropForming,
  INDICATOR_MIN_DEPTH, INDICATOR_DEFAULT_DEPTH,
} from '../src/lib/indicators/update';
import { buildIndicatorSnapshot } from '../src/lib/indicators/snapshot';
import { snapshotToRow, InMemorySnapshotStore } from '../src/lib/indicators/store';
import type { IndicatorCandle } from '../src/lib/indicators/types';

// n개 완결봉 (오래→최신).
function genCandles(n: number, base = 100): IndicatorCandle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = base + 6 * Math.sin(i / 7) + i * 0.05;
    return {
      datetime: `202601010${String(i).padStart(5, '0')}`,
      open: c - 0.3, high: c + 1.2, low: c - 1.2, close: c, volume: 1000 + i,
    };
  });
}
function storeDeps(store: InMemorySnapshotStore, throttleMinHistoryCount = 120) {
  return {
    throttleMinHistoryCount,
    existingHistoryCount: async (m: string, s: string, t: string) => {
      const r = store.get(m, s, t);
      return r ? Number(r.history_count) : null;
    },
    saveSnapshot: async (s: string, m: string, snap: any) => { store.upsert(snapshotToRow(s, m, snap)); },
  };
}

describe('확장 조회 깊이 상수', () => {
  it('EMA120 을 위해 최소 121, 기본 버퍼는 121~200 범위', () => {
    expect(INDICATOR_MIN_DEPTH).toBeGreaterThanOrEqual(121);
    expect(INDICATOR_DEFAULT_DEPTH).toBeGreaterThanOrEqual(INDICATOR_MIN_DEPTH);
    expect(INDICATOR_DEFAULT_DEPTH).toBeLessThanOrEqual(200);
  });
});

describe('dropForming', () => {
  it('마지막(형성 중) 봉을 제거하고 입력을 변형하지 않는다', () => {
    const arr = Object.freeze(genCandles(5)) as IndicatorCandle[];
    const out = dropForming(arr);
    expect(out).toHaveLength(4);
    expect(arr).toHaveLength(5);
    expect(out.at(-1)!.datetime).toBe(arr[3].datetime);
  });
});

describe('updateIndicatorSnapshot — 제너릭 오케스트레이션', () => {
  it('충분한 완결봉이면 EMA120 이 채워지고 저장된다', async () => {
    const store = new InMemorySnapshotStore();
    const candles = genCandles(130);
    const res = await updateIndicatorSnapshot({
      market: 'US', symbol: 'AAPL',
      tradingCompletedTs: candles.at(-1)!.datetime,
      loadCandles: async () => candles,
      ...storeDeps(store),
    });
    expect(res.status).toBe('saved');
    if (res.status === 'saved') {
      expect(res.snapshot.ema120).not.toBeNull();
      expect(res.snapshot.historyCount).toBe(130);
    }
    expect(store.size).toBe(1);
  });

  it('매매 깊이(41)만큼만 로드되면 EMA120 은 null', async () => {
    const store = new InMemorySnapshotStore();
    const candles = genCandles(41);
    const res = await updateIndicatorSnapshot({
      market: 'US', symbol: 'AAPL',
      tradingCompletedTs: candles.at(-1)!.datetime,
      loadCandles: async () => candles,
      ...storeDeps(store),
    });
    expect(res.status).toBe('saved');
    if (res.status === 'saved') {
      expect(res.snapshot.ema120).toBeNull();
      expect(res.snapshot.historyCount).toBe(41);
    }
  });

  it('로드 실패는 stage=load 로 격리되고 예외를 던지지 않는다', async () => {
    const save = vi.fn(async () => {});
    const res = await updateIndicatorSnapshot({
      market: 'US', symbol: 'AAPL',
      tradingCompletedTs: '20260101000129',
      throttleMinHistoryCount: 120,
      existingHistoryCount: async () => null,
      loadCandles: async () => { throw new Error('조회 실패'); },
      saveSnapshot: save,
    });
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.stage).toBe('load');
    expect(save).not.toHaveBeenCalled();
  });

  it('저장 실패는 stage=save 로 격리된다', async () => {
    const res = await updateIndicatorSnapshot({
      market: 'US', symbol: 'AAPL',
      tradingCompletedTs: '20260101000129',
      throttleMinHistoryCount: 120,
      existingHistoryCount: async () => null,
      loadCandles: async () => genCandles(130),
      saveSnapshot: async () => { throw new Error('D1 write 실패'); },
    });
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.stage).toBe('save');
  });

  it('동일 완결봉 재스캔은 스로틀 — 로드조차 하지 않는다', async () => {
    const store = new InMemorySnapshotStore();
    const candles = genCandles(130);
    const loadSpy = vi.fn(async () => candles);
    const deps = {
      market: 'US', symbol: 'AAPL',
      tradingCompletedTs: candles.at(-1)!.datetime,
      loadCandles: loadSpy,
      ...storeDeps(store),
    };
    expect((await updateIndicatorSnapshot(deps)).status).toBe('saved');
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect((await updateIndicatorSnapshot(deps)).status).toBe('skipped_throttled');
    expect(loadSpy).toHaveBeenCalledTimes(1);   // 재로드 없음
    expect(store.size).toBe(1);
  });

  it('완결봉 시각이 없으면 스킵', async () => {
    const res = await updateIndicatorSnapshot({
      market: 'US', symbol: 'AAPL',
      tradingCompletedTs: null,
      throttleMinHistoryCount: 120,
      existingHistoryCount: async () => null,
      loadCandles: async () => { throw new Error('호출되면 안 됨'); },
      saveSnapshot: async () => {},
    });
    expect(res.status).toBe('skipped_no_candle');
  });

  it('look-ahead 없음: 저장 스냅샷 = build(로드된 완결봉)', async () => {
    const store = new InMemorySnapshotStore();
    const candles = genCandles(140);
    const res = await updateIndicatorSnapshot({
      market: 'US', symbol: 'AAPL',
      tradingCompletedTs: candles.at(-1)!.datetime,
      loadCandles: async () => candles,
      ...storeDeps(store),
    });
    expect(res.status).toBe('saved');
    if (res.status === 'saved') expect(res.snapshot).toEqual(buildIndicatorSnapshot(candles));
  });
});

// ── US 확장 조회 경로 유지 (I) ────────────────────────────────
describe('US 확장 조회 경로 (dropForming 유지)', () => {
  it('NREC 조회(형성봉 포함)를 dropForming 후 EMA120 산출', async () => {
    const store = new InMemorySnapshotStore();
    const raw = genCandles(151);                 // 형성봉 포함 raw
    const usLoad = async () => dropForming(raw); // US 로더 형태
    const res = await updateIndicatorSnapshot({
      market: 'US', symbol: 'AAPL',
      tradingCompletedTs: raw[raw.length - 2].datetime,   // 완결봉 = 마지막-1
      loadCandles: usLoad,
      ...storeDeps(store),
    });
    expect(res.status).toBe('saved');
    if (res.status === 'saved') {
      expect(res.snapshot.candleTimestamp).toBe(raw[raw.length - 2].datetime);
      expect(res.snapshot.ema120).not.toBeNull();
      expect(res.snapshot.historyCount).toBe(150);
    }
  });
});
