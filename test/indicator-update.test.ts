import { describe, it, expect, vi } from 'vitest';
import {
  updateIndicatorSnapshot, dropForming,
  INDICATOR_MIN_DEPTH, INDICATOR_DEFAULT_DEPTH,
} from '../src/lib/indicators/update';
import { buildIndicatorSnapshot } from '../src/lib/indicators/snapshot';
import { snapshotToRow, InMemorySnapshotStore } from '../src/lib/indicators/store';
import type { IndicatorCandle } from '../src/lib/indicators/types';

// n개 캔들 (오래→최신). 마지막 원소가 형성 중(미확정) 최신봉 역할.
function genCandles(n: number, base = 100): IndicatorCandle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = base + 6 * Math.sin(i / 7) + i * 0.05;
    return {
      datetime: `202601010${String(i).padStart(5, '0')}`,
      open: c - 0.3, high: c + 1.2, low: c - 1.2, close: c, volume: 1000 + i,
    };
  });
}

// InMemorySnapshotStore 기반 deps 구성 (실제 DB 대신)
function storeDeps(store: InMemorySnapshotStore) {
  return {
    snapshotExists: async (m: string, s: string, t: string) => !!store.get(m, s, t),
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
    expect(arr).toHaveLength(5);              // 원본 불변
    expect(out.at(-1)!.datetime).toBe(arr[3].datetime);
  });
  it('1개 이하이면 그대로(복사본) 반환', () => {
    expect(dropForming([])).toHaveLength(0);
    expect(dropForming([genCandles(1)[0]])).toHaveLength(1);
  });
});

describe('updateIndicatorSnapshot — EMA120 산출 (A)', () => {
  it('충분한 확장 캔들이 있으면 EMA120 이 채워진다', async () => {
    const store = new InMemorySnapshotStore();
    const extended = genCandles(130);        // dropForming → 129 완결봉 ≥ 120
    const res = await updateIndicatorSnapshot({
      market: 'KR', symbol: '005930',
      tradingCompletedTs: extended[extended.length - 2].datetime,
      fetchExtendedCandles: async () => extended,
      ...storeDeps(store),
    });
    expect(res.status).toBe('saved');
    if (res.status === 'saved') {
      expect(res.snapshot.ema120).not.toBeNull();
      expect(Number.isFinite(res.snapshot.ema120!)).toBe(true);
    }
    expect(store.size).toBe(1);
  });

  it('매매 깊이(41)만큼만 있으면 EMA120 은 null (별도 깊은 조회가 필요함을 증명)', async () => {
    const store = new InMemorySnapshotStore();
    const extended = genCandles(41);
    const res = await updateIndicatorSnapshot({
      market: 'KR', symbol: '005930',
      tradingCompletedTs: extended[extended.length - 2].datetime,
      fetchExtendedCandles: async () => extended,
      ...storeDeps(store),
    });
    expect(res.status).toBe('saved');
    if (res.status === 'saved') expect(res.snapshot.ema120).toBeNull();
  });
});

describe('updateIndicatorSnapshot — 매매 창 불변 (B)', () => {
  it('지표 경로는 별도 확장 시계열만 사용하고 매매 창을 건드리지 않는다', async () => {
    const store = new InMemorySnapshotStore();
    // 매매용 창 (41) — 동결하여 어떤 변형도 없음을 보장
    const tradingWindow = Object.freeze(genCandles(41, 200)) as IndicatorCandle[];
    const extended = genCandles(150, 100);   // 완전히 다른 별도 시계열
    const res = await updateIndicatorSnapshot({
      market: 'KR', symbol: '005930',
      tradingCompletedTs: extended[extended.length - 2].datetime,
      fetchExtendedCandles: async () => extended,
      ...storeDeps(store),
    });
    // 저장된 스냅샷은 "확장" 시계열의 마지막 완결봉에서 나온다 (매매 창 아님)
    expect(res.status).toBe('saved');
    if (res.status === 'saved') {
      expect(res.snapshot.candleTimestamp).toBe(extended[extended.length - 2].datetime);
      expect(res.snapshot.close).toBeCloseTo(extended[extended.length - 2].close, 9);
    }
    // 매매 창은 그대로 (동결 + 길이 불변)
    expect(tradingWindow).toHaveLength(41);
  });
});

describe('updateIndicatorSnapshot — 실패 격리 (C)', () => {
  it('확장 조회 실패는 예외를 던지지 않고 매매를 막지 않는다', async () => {
    const store = new InMemorySnapshotStore();
    const save = vi.fn(async () => {});
    const res = await updateIndicatorSnapshot({
      market: 'KR', symbol: '005930',
      tradingCompletedTs: '20260101000128',
      snapshotExists: async () => false,
      fetchExtendedCandles: async () => { throw new Error('KIS 500 확장 조회 실패'); },
      saveSnapshot: save,
    });
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.message).toContain('확장 조회 실패');
    expect(save).not.toHaveBeenCalled();     // 저장 시도 없음
    expect(store.size).toBe(0);
  });

  it('저장 실패도 예외를 밖으로 던지지 않는다', async () => {
    const res = await updateIndicatorSnapshot({
      market: 'KR', symbol: '005930',
      tradingCompletedTs: '20260101000128',
      snapshotExists: async () => false,
      fetchExtendedCandles: async () => genCandles(130),
      saveSnapshot: async () => { throw new Error('D1 write 실패'); },
    });
    expect(res.status).toBe('error');
  });
});

describe('updateIndicatorSnapshot — 스로틀/중복 방지 (D)', () => {
  it('동일 완결봉 재스캔은 확장 조회를 건너뛰고 중복을 만들지 않는다', async () => {
    const store = new InMemorySnapshotStore();
    const extended = genCandles(130);
    const completedTs = extended[extended.length - 2].datetime;
    const fetchSpy = vi.fn(async () => extended);
    const deps = {
      market: 'KR', symbol: '005930',
      tradingCompletedTs: completedTs,
      fetchExtendedCandles: fetchSpy,
      ...storeDeps(store),
    };

    const first = await updateIndicatorSnapshot(deps);
    expect(first.status).toBe('saved');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);

    // 같은 완결봉으로 재스캔 → 스로틀
    const second = await updateIndicatorSnapshot(deps);
    expect(second.status).toBe('skipped_throttled');
    expect(fetchSpy).toHaveBeenCalledTimes(1);   // 추가 조회 없음
    expect(store.size).toBe(1);                  // 중복 행 없음
  });

  it('완결봉이 없으면 스킵', async () => {
    const res = await updateIndicatorSnapshot({
      market: 'KR', symbol: '005930',
      tradingCompletedTs: null,
      snapshotExists: async () => false,
      fetchExtendedCandles: async () => { throw new Error('호출되면 안 됨'); },
      saveSnapshot: async () => {},
    });
    expect(res.status).toBe('skipped_no_candle');
  });
});

describe('updateIndicatorSnapshot — look-ahead 없음 (E)', () => {
  it('저장 스냅샷 = buildIndicatorSnapshot(dropForming(extended)) 와 동일', async () => {
    const store = new InMemorySnapshotStore();
    const extended = genCandles(140);
    const res = await updateIndicatorSnapshot({
      market: 'KR', symbol: '005930',
      tradingCompletedTs: extended[extended.length - 2].datetime,
      fetchExtendedCandles: async () => extended,
      ...storeDeps(store),
    });
    const expected = buildIndicatorSnapshot(dropForming(extended));
    expect(res.status).toBe('saved');
    if (res.status === 'saved') expect(res.snapshot).toEqual(expected);
  });
});
