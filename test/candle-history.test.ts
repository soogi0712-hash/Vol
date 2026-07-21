import { describe, it, expect, vi } from 'vitest';
import {
  accumulateAndLoadKRCandles, InMemoryCandleHistory,
  buildCandleHistoryUpsertSQL, candleHistoryBindings,
} from '../src/lib/indicators/candle-history';
import { updateIndicatorSnapshot, dropForming } from '../src/lib/indicators/update';
import { buildIndicatorSnapshot } from '../src/lib/indicators/snapshot';
import { snapshotToRow, InMemorySnapshotStore } from '../src/lib/indicators/store';
import type { IndicatorCandle } from '../src/lib/indicators/types';

// 완결봉 n개 (오래→최신). startIdx 로 시각을 이어붙여 세션 누적을 흉내낸다.
function genCandles(n: number, startIdx = 0, base = 100): IndicatorCandle[] {
  return Array.from({ length: n }, (_, k) => {
    const i = startIdx + k;
    const c = base + 6 * Math.sin(i / 9) + i * 0.03;
    return {
      datetime: `2026${String(1000000000 + i).slice(1)}`,  // 단조 증가하는 14자리 유사 timestamp
      open: c - 0.3, high: c + 1.1, low: c - 1.1, close: c, volume: 1000 + i,
    };
  });
}

// KR 로더 헬퍼: 인메모리 이력 사용, 절대 KIS fetch 를 쓰지 않음
function krLoader(hist: InMemoryCandleHistory, symbol: string, confirmed: IndicatorCandle[], limit: number) {
  return () => accumulateAndLoadKRCandles({
    market: 'KR', symbol, confirmedCandles: confirmed,
    upsert: (m, s, cs) => hist.upsert(m, s, cs),
    readLatest: (m, s, l) => hist.readLatest(m, s, l),
    limit,
  });
}

// ── A: KR 은 두 번째 지표 전용 KIS 조회를 하지 않는다 ──────────
describe('A. KR 추가 KIS 조회 없음', () => {
  it('KR 지표 계산은 이력 upsert/read 만 사용하고 KIS fetch 를 호출하지 않는다', async () => {
    const hist = new InMemoryCandleHistory();
    const store = new InMemorySnapshotStore();
    const kisFetch = vi.fn(async () => genCandles(150));  // 호출되면 안 됨
    const confirmed = genCandles(40);
    const res = await updateIndicatorSnapshot({
      market: 'KR', symbol: '005930',
      tradingCompletedTs: confirmed.at(-1)!.datetime,
      snapshotExists: async (m, s, t) => !!store.get(m, s, t),
      loadCandles: krLoader(hist, '005930', confirmed, 150),  // KIS fetch 미사용
      saveSnapshot: async (s, m, snap) => { store.upsert(snapshotToRow(s, m, snap)); },
    });
    expect(res.status).toBe('saved');
    expect(kisFetch).not.toHaveBeenCalled();
  });
});

// ── B: 확정봉 누적 + 중복 제거 (market+symbol+candle_ts) ──────
describe('B. 누적 + 중복 제거', () => {
  it('겹치는 창을 upsert 해도 candle_ts 로 중복 없이 합쳐진다', async () => {
    const hist = new InMemoryCandleHistory();
    await hist.upsert('KR', '005930', genCandles(30, 0));    // 0..29
    await hist.upsert('KR', '005930', genCandles(30, 20));   // 20..49 (10개 겹침)
    expect(hist.count('KR', '005930')).toBe(50);             // 0..49 유니크
    // 종목/시장 분리
    await hist.upsert('KR', '000660', genCandles(5, 0));
    expect(hist.count('KR', '000660')).toBe(5);
    expect(hist.count('KR', '005930')).toBe(50);
  });
});

// ── C/D: EMA120 임계 ─────────────────────────────────────────
describe('C/D. KR EMA120 임계 (120)', () => {
  it('C: 119개 미만이면 EMA120 은 null', async () => {
    const hist = new InMemoryCandleHistory();
    await hist.upsert('KR', '005930', genCandles(119));
    const candles = await hist.readLatest('KR', '005930', 150);
    expect(candles).toHaveLength(119);
    expect(buildIndicatorSnapshot(candles)!.ema120).toBeNull();
  });
  it('D: 120개 이상이면 EMA120 이 채워진다', async () => {
    const hist = new InMemoryCandleHistory();
    await hist.upsert('KR', '005930', genCandles(120));
    const candles = await hist.readLatest('KR', '005930', 150);
    expect(candles).toHaveLength(120);
    const snap = buildIndicatorSnapshot(candles)!;
    expect(snap.ema120).not.toBeNull();
    expect(Number.isFinite(snap.ema120!)).toBe(true);
    expect(snap.historyCount).toBe(120);
  });
});

// ── E: oldest→newest 로 읽어 계산 ────────────────────────────
describe('E. 저장 캔들은 oldest→newest 로 읽힌다', () => {
  it('readLatest 는 오름차순 시각, 계산 결과도 정렬 배열과 동일', async () => {
    const hist = new InMemoryCandleHistory();
    // 일부러 역순으로 upsert
    const asc = genCandles(130);
    await hist.upsert('KR', '005930', [...asc].reverse());
    const read = await hist.readLatest('KR', '005930', 150);
    for (let i = 1; i < read.length; i++) {
      expect(read[i].datetime > read[i - 1].datetime).toBe(true);   // 오름차순
    }
    expect(buildIndicatorSnapshot(read)).toEqual(buildIndicatorSnapshot(asc));
  });
});

// ── F: 형성봉은 절대 저장되지 않는다 ─────────────────────────
describe('F. 형성봉 미저장', () => {
  it('confirmedCandles(형성봉 제거) 만 이력에 들어간다', async () => {
    const hist = new InMemoryCandleHistory();
    const rawWithForming = genCandles(42);                 // 마지막이 형성봉
    const confirmed = dropForming(rawWithForming);         // 41개
    await hist.upsert('KR', '005930', confirmed);
    const read = await hist.readLatest('KR', '005930', 150);
    expect(read).toHaveLength(41);
    const formingTs = rawWithForming.at(-1)!.datetime;
    expect(read.some(c => c.datetime === formingTs)).toBe(false);   // 형성봉 없음
  });
});

// ── G: 이력 DB 실패는 매매를 멈추지 않는다 ───────────────────
describe('G. 이력 DB 실패 격리', () => {
  it('upsert 실패 → stage=load 에러, 예외 미전파, 저장 시도 없음', async () => {
    const store = new InMemorySnapshotStore();
    const save = vi.fn(async (s: string, m: string, snap: any) => { store.upsert(snapshotToRow(s, m, snap)); });
    const confirmed = genCandles(40);
    const res = await updateIndicatorSnapshot({
      market: 'KR', symbol: '005930',
      tradingCompletedTs: confirmed.at(-1)!.datetime,
      snapshotExists: async () => false,
      loadCandles: () => accumulateAndLoadKRCandles({
        market: 'KR', symbol: '005930', confirmedCandles: confirmed,
        upsert: async () => { throw new Error('D1 down'); },
        readLatest: async () => [],
        limit: 150,
      }),
      saveSnapshot: save,
    });
    expect(res.status).toBe('error');
    if (res.status === 'error') {
      expect(res.stage).toBe('load');
      expect(res.message).toContain('candle_history upsert');
    }
    expect(save).not.toHaveBeenCalled();     // 지표 저장 안 됨 → 매매는 별도로 계속
  });

  it('read 실패도 stage=load 로 격리된다', async () => {
    const res = await updateIndicatorSnapshot({
      market: 'KR', symbol: '005930',
      tradingCompletedTs: '20260100000039',
      snapshotExists: async () => false,
      loadCandles: () => accumulateAndLoadKRCandles({
        market: 'KR', symbol: '005930', confirmedCandles: genCandles(40),
        upsert: async () => {},
        readLatest: async () => { throw new Error('read fail'); },
        limit: 150,
      }),
      saveSnapshot: async () => {},
    });
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.message).toContain('candle_history read');
  });
});

// ── H: 동일 캔들 재스캔은 중복 캔들/스냅샷을 만들지 않는다 ────
describe('H. 중복 방지 (스로틀 + UPSERT)', () => {
  it('같은 완결봉 재스캔 → 캔들/스냅샷 중복 없음, KR 재로드 없음', async () => {
    const hist = new InMemoryCandleHistory();
    const store = new InMemorySnapshotStore();
    const confirmed = genCandles(130);
    const load = vi.fn(krLoader(hist, '005930', confirmed, 150));
    const deps = {
      market: 'KR', symbol: '005930',
      tradingCompletedTs: confirmed.at(-1)!.datetime,
      snapshotExists: async (m: string, s: string, t: string) => !!store.get(m, s, t),
      loadCandles: load,
      saveSnapshot: async (s: string, m: string, snap: any) => { store.upsert(snapshotToRow(s, m, snap)); },
    };
    expect((await updateIndicatorSnapshot(deps)).status).toBe('saved');
    expect((await updateIndicatorSnapshot(deps)).status).toBe('skipped_throttled');
    expect(load).toHaveBeenCalledTimes(1);          // 재로드 없음
    expect(hist.count('KR', '005930')).toBe(130);   // 캔들 중복 없음
    expect(store.size).toBe(1);                     // 스냅샷 중복 없음
  });
});

// ── J: look-ahead 없음 (KR 경로) ─────────────────────────────
describe('J. look-ahead 없음 (KR)', () => {
  it('KR 스냅샷 = build(readLatest 결과)', async () => {
    const hist = new InMemoryCandleHistory();
    const store = new InMemorySnapshotStore();
    const confirmed = genCandles(140);
    const res = await updateIndicatorSnapshot({
      market: 'KR', symbol: '005930',
      tradingCompletedTs: confirmed.at(-1)!.datetime,
      snapshotExists: async () => false,
      loadCandles: krLoader(hist, '005930', confirmed, 150),
      saveSnapshot: async (s, m, snap) => { store.upsert(snapshotToRow(s, m, snap)); },
    });
    const read = await hist.readLatest('KR', '005930', 150);
    expect(res.status).toBe('saved');
    if (res.status === 'saved') expect(res.snapshot).toEqual(buildIndicatorSnapshot(read));
  });
});

// ── SQL/바인딩 스모크 ────────────────────────────────────────
describe('candle_history SQL/바인딩', () => {
  it('UPSERT SQL 은 (market,symbol,candle_ts) 충돌에 OHLCV 갱신', () => {
    const sql = buildCandleHistoryUpsertSQL();
    expect(sql).toContain('ON CONFLICT(market, symbol, candle_ts) DO UPDATE');
    expect(sql).toContain('close=excluded.close');
    expect(sql).toContain('updated_at=CURRENT_TIMESTAMP');
  });
  it('바인딩은 컬럼 순서와 일치', () => {
    const c = genCandles(1)[0];
    expect(candleHistoryBindings('KR', '005930', c)).toEqual([
      'KR', '005930', c.datetime, c.open, c.high, c.low, c.close, c.volume,
    ]);
  });
});
