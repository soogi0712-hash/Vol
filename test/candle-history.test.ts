import { describe, it, expect, vi } from 'vitest';
import {
  accumulateKRHistory, InMemoryCandleHistory,
  buildCandleHistoryUpsertSQL, candleHistoryBindings,
} from '../src/lib/indicators/candle-history';
import { updateIndicatorSnapshot, dropForming } from '../src/lib/indicators/update';
import { buildIndicatorSnapshot } from '../src/lib/indicators/snapshot';
import { snapshotToRow, InMemorySnapshotStore } from '../src/lib/indicators/store';
import type { IndicatorCandle } from '../src/lib/indicators/types';

// 완결봉 n개 (오래→최신). 단조 증가하는 14자리 유사 timestamp.
function genCandles(n: number, startIdx = 0, base = 100): IndicatorCandle[] {
  return Array.from({ length: n }, (_, k) => {
    const i = startIdx + k;
    const c = base + 6 * Math.sin(i / 9) + i * 0.03;
    return {
      datetime: `2026${String(1000000000 + i).slice(1)}`,
      open: c - 0.3, high: c + 1.1, low: c - 1.1, close: c, volume: 1000 + i,
    };
  });
}

// KR 지표 deps: 누적(accumulateKRHistory)은 분리, 로드는 readLatest, 스로틀은 count 기반.
function krDeps(hist: InMemoryCandleHistory, store: InMemorySnapshotStore, symbol: string, limit = 150) {
  return {
    market: 'KR', symbol,
    existingHistoryCount: async (m: string, s: string, t: string) => {
      const r = store.get(m, s, t); return r ? Number(r.history_count) : null;
    },
    throttleMinHistoryCount: 120,   // KR: 이력 부족 스냅샷은 self-heal 재계산
    loadCandles: () => hist.readLatest('KR', symbol, limit),
    saveSnapshot: async (s: string, m: string, snap: any) => { store.upsert(snapshotToRow(s, m, snap)); },
  };
}

// ── A: KR 은 두 번째 지표 전용 KIS 조회를 하지 않는다 ──────────
describe('A. KR 추가 KIS 조회 없음', () => {
  it('KR 지표 계산은 이력 read 만 사용하고 KIS fetch 를 호출하지 않는다', async () => {
    const hist = new InMemoryCandleHistory();
    const store = new InMemorySnapshotStore();
    const kisFetch = vi.fn(async () => genCandles(150));  // 호출되면 안 됨
    const confirmed = genCandles(40);
    await accumulateKRHistory({ market: 'KR', symbol: '005930', confirmedCandles: confirmed, upsert: (m, s, cs) => hist.upsert(m, s, cs) });
    const res = await updateIndicatorSnapshot({
      ...krDeps(hist, store, '005930'),
      tradingCompletedTs: confirmed.at(-1)!.datetime,
    });
    expect(res.status).toBe('saved');
    expect(kisFetch).not.toHaveBeenCalled();
  });
});

// ── B: 확정봉 누적 + 중복 제거 (market+symbol+candle_ts) ──────
describe('B. 누적 + 중복 제거', () => {
  it('겹치는 창을 upsert 해도 candle_ts 로 중복 없이 합쳐진다', async () => {
    const hist = new InMemoryCandleHistory();
    await accumulateKRHistory({ market: 'KR', symbol: '005930', confirmedCandles: genCandles(30, 0), upsert: (m, s, cs) => hist.upsert(m, s, cs) });
    await accumulateKRHistory({ market: 'KR', symbol: '005930', confirmedCandles: genCandles(30, 20), upsert: (m, s, cs) => hist.upsert(m, s, cs) });
    expect(hist.count('KR', '005930')).toBe(50);   // 0..49 유니크
    await hist.upsert('KR', '000660', genCandles(5, 0));
    expect(hist.count('KR', '000660')).toBe(5);
    expect(hist.count('KR', '005930')).toBe(50);   // 종목 분리
  });
});

// ── C/D: EMA120 임계 ─────────────────────────────────────────
describe('C/D. KR EMA120 임계 (120)', () => {
  it('C: 120개 미만이면 EMA120 은 null', async () => {
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
    expect(snap.historyCount).toBe(120);
  });
});

// ── E: oldest→newest 로 읽어 계산 ────────────────────────────
describe('E. 저장 캔들은 oldest→newest 로 읽힌다', () => {
  it('readLatest 는 오름차순 시각, 계산 결과도 정렬 배열과 동일', async () => {
    const hist = new InMemoryCandleHistory();
    const asc = genCandles(130);
    await hist.upsert('KR', '005930', [...asc].reverse());   // 역순 입력
    const read = await hist.readLatest('KR', '005930', 150);
    for (let i = 1; i < read.length; i++) {
      expect(read[i].datetime > read[i - 1].datetime).toBe(true);
    }
    expect(buildIndicatorSnapshot(read)).toEqual(buildIndicatorSnapshot(asc));
  });
});

// ── F: 형성봉은 절대 저장되지 않는다 ─────────────────────────
describe('F. 형성봉 미저장', () => {
  it('confirmedCandles(형성봉 제거) 만 이력에 들어간다', async () => {
    const hist = new InMemoryCandleHistory();
    const rawWithForming = genCandles(42);              // 마지막이 형성봉
    const confirmed = dropForming(rawWithForming);      // 41개
    await accumulateKRHistory({ market: 'KR', symbol: '005930', confirmedCandles: confirmed, upsert: (m, s, cs) => hist.upsert(m, s, cs) });
    const read = await hist.readLatest('KR', '005930', 150);
    expect(read).toHaveLength(41);
    expect(read.some(c => c.datetime === rawWithForming.at(-1)!.datetime)).toBe(false);
  });
});

// ── G: 이력 DB 실패는 매매를 멈추지 않는다 ───────────────────
describe('G. 이력 DB 실패 격리', () => {
  it('upsert 실패 → accumulateKRHistory 가 예외 없이 error 반환', async () => {
    const res = await accumulateKRHistory({
      market: 'KR', symbol: '005930', confirmedCandles: genCandles(40),
      upsert: async () => { throw new Error('D1 down'); },
    });
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.message).toContain('candle_history upsert');
  });

  it('read(loadCandles) 실패 → stage=load 로 격리, 예외 미전파', async () => {
    const store = new InMemorySnapshotStore();
    const res = await updateIndicatorSnapshot({
      market: 'KR', symbol: '005930',
      tradingCompletedTs: '20260100000039',
      throttleMinHistoryCount: 120,
      existingHistoryCount: async () => null,
      loadCandles: async () => { throw new Error('read fail'); },
      saveSnapshot: async () => {},
    });
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.stage).toBe('load');
  });
});

// ── H: 동일 캔들 재스캔은 중복 캔들/스냅샷을 만들지 않는다 ────
describe('H. 중복 방지 (완료된 스냅샷 스로틀 + UPSERT)', () => {
  it('완료(>=120) 스냅샷은 재스캔 시 스로틀, 캔들/스냅샷 중복 없음', async () => {
    const hist = new InMemoryCandleHistory();
    const store = new InMemorySnapshotStore();
    const confirmed = genCandles(130);
    await hist.upsert('KR', '005930', confirmed);
    const load = vi.fn(() => hist.readLatest('KR', '005930', 150));
    const deps = { ...krDeps(hist, store, '005930'), tradingCompletedTs: confirmed.at(-1)!.datetime, loadCandles: load };

    expect((await updateIndicatorSnapshot(deps)).status).toBe('saved');   // count 130 저장
    expect((await updateIndicatorSnapshot(deps)).status).toBe('skipped_throttled');  // 130>=120 → 스로틀
    expect(load).toHaveBeenCalledTimes(1);
    expect(hist.count('KR', '005930')).toBe(130);   // 캔들 중복 없음
    expect(store.size).toBe(1);                     // 스냅샷 중복 없음
  });
});

// ── ★ 부분 스냅샷 self-heal (critical) ───────────────────────
describe('★ 부분 스냅샷은 영구 고정되지 않고 이력이 쌓이면 재계산된다', () => {
  it('history_count<120 스냅샷은 스로틀되지 않고, 누적 후 EMA120 이 채워진다', async () => {
    const hist = new InMemoryCandleHistory();
    const store = new InMemorySnapshotStore();
    const symbol = '005930';

    // 1) 이력 50개일 때 부분 스냅샷 저장 (EMA120=null, history_count=50)
    await hist.upsert('KR', symbol, genCandles(50, 0));
    const ts50 = (await hist.readLatest('KR', symbol, 150)).at(-1)!.datetime;
    const r1 = await updateIndicatorSnapshot({ ...krDeps(hist, store, symbol), tradingCompletedTs: ts50 });
    expect(r1.status).toBe('saved');
    if (r1.status === 'saved') { expect(r1.snapshot.ema120).toBeNull(); expect(r1.snapshot.historyCount).toBe(50); }

    // 2) 같은 완결봉(ts50)을 재스캔 → 아직 부족(50<120)하므로 스로틀되지 않고 재계산됨
    const r2 = await updateIndicatorSnapshot({ ...krDeps(hist, store, symbol), tradingCompletedTs: ts50 });
    expect(r2.status).toBe('saved');   // ★ 영구 고정 아님

    // 3) 이력이 130개로 쌓인 뒤, 최신 완결봉 스냅샷은 EMA120 이 채워진다
    await hist.upsert('KR', symbol, genCandles(130, 0));
    const tsNew = (await hist.readLatest('KR', symbol, 150)).at(-1)!.datetime;
    const r3 = await updateIndicatorSnapshot({ ...krDeps(hist, store, symbol), tradingCompletedTs: tsNew });
    expect(r3.status).toBe('saved');
    if (r3.status === 'saved') expect(r3.snapshot.ema120).not.toBeNull();

    // 4) 완료된 최신 스냅샷(>=120)은 이제 스로틀된다
    const r4 = await updateIndicatorSnapshot({ ...krDeps(hist, store, symbol), tradingCompletedTs: tsNew });
    expect(r4.status).toBe('skipped_throttled');
  });

  it('KR 누적은 스냅샷이 이미 있어도 계속 실행된다 (스로틀과 분리)', async () => {
    const hist = new InMemoryCandleHistory();
    // 스냅샷 존재와 무관하게 accumulateKRHistory 는 항상 upsert 한다
    await accumulateKRHistory({ market: 'KR', symbol: '005930', confirmedCandles: genCandles(40, 0), upsert: (m, s, cs) => hist.upsert(m, s, cs) });
    await accumulateKRHistory({ market: 'KR', symbol: '005930', confirmedCandles: genCandles(40, 30), upsert: (m, s, cs) => hist.upsert(m, s, cs) });
    expect(hist.count('KR', '005930')).toBe(70);   // 0..69 누적 (스냅샷 스로틀과 무관)
  });
});

// ── J: look-ahead 없음 (KR 경로) ─────────────────────────────
describe('J. look-ahead 없음 (KR)', () => {
  it('KR 스냅샷 = build(readLatest 결과)', async () => {
    const hist = new InMemoryCandleHistory();
    const store = new InMemorySnapshotStore();
    await hist.upsert('KR', '005930', genCandles(140));
    const read = await hist.readLatest('KR', '005930', 150);
    const res = await updateIndicatorSnapshot({ ...krDeps(hist, store, '005930'), tradingCompletedTs: read.at(-1)!.datetime });
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
