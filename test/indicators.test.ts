import { describe, it, expect } from 'vitest';
import { emaSeries, emaValue, sma } from '../src/lib/indicators/ema';
import { computeMACD } from '../src/lib/indicators/macd';
import { detectPatterns } from '../src/lib/indicators/candlestick';
import { computeVolume } from '../src/lib/indicators/volume';
import { computeATR } from '../src/lib/indicators/atr';
import { computeADX } from '../src/lib/indicators/adx';
import { computeBollingerBandwidth } from '../src/lib/indicators/bollinger-bandwidth';
import { buildIndicatorSnapshot, computeSnapshotSeries } from '../src/lib/indicators/snapshot';
import { snapshotToRow, InMemorySnapshotStore } from '../src/lib/indicators/store';
import type { IndicatorCandle } from '../src/lib/indicators/types';

// ── 헬퍼 ─────────────────────────────────────────────────────
function C(open: number, high: number, low: number, close: number, volume = 1000): IndicatorCandle {
  return { datetime: '20260101000000', open, high, low, close, volume };
}
function ts(i: number): string {
  return `2026010100${String(i).padStart(4, '0')}`;
}
// 종가 배열 → 캔들 배열 (관측용, high/low 를 close 주변으로 생성)
function candlesFromCloses(closes: number[], volume = 1000): IndicatorCandle[] {
  return closes.map((c, i) => ({
    datetime: ts(i), open: c, high: c + 1, low: c - 1, close: c, volume,
  }));
}
// 모든 숫자 리프가 유한하거나 null 인지 (NaN/Infinity 금지)
function assertNoNaNInfinity(obj: unknown): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'number') { expect(Number.isFinite(obj)).toBe(true); return; }
  if (typeof obj === 'object') for (const v of Object.values(obj)) assertNoNaNInfinity(v);
}

// ── EMA ──────────────────────────────────────────────────────
describe('EMA', () => {
  it('SMA-시드 EMA 를 결정적으로 계산한다', () => {
    // [1,2,3,4,5], period 3 → seed=2, k=0.5 → 2,3,4
    expect(emaValue([1, 2, 3, 4, 5], 3)).toBeCloseTo(4, 10);
    const series = emaSeries([1, 2, 3, 4, 5], 3)!;
    expect(series[0]).toBeNull();
    expect(series[1]).toBeNull();
    expect(series[2]).toBeCloseTo(2, 10);
    expect(series[4]).toBeCloseTo(4, 10);
  });

  it('상수 시계열에서 EMA 20/30/60/120 모두 상수와 같다', () => {
    const closes = new Array(130).fill(100);
    expect(emaValue(closes, 20)).toBeCloseTo(100, 9);
    expect(emaValue(closes, 30)).toBeCloseTo(100, 9);
    expect(emaValue(closes, 60)).toBeCloseTo(100, 9);
    expect(emaValue(closes, 120)).toBeCloseTo(100, 9);
  });

  it('데이터 부족 시 null', () => {
    expect(emaValue([1, 2], 3)).toBeNull();
    expect(emaSeries([1, 2], 3)).toBeNull();
    expect(sma([1, 2], 3)).toBeNull();
    expect(emaValue(new Array(119).fill(1), 120)).toBeNull();
  });
});

// ── MACD ─────────────────────────────────────────────────────
describe('MACD', () => {
  it('상수 시계열 → macd/signal/histogram 0, 크로스 없음', () => {
    const r = computeMACD(new Array(40).fill(100))!;
    expect(r.macd).toBeCloseTo(0, 9);
    expect(r.signal).toBeCloseTo(0, 9);
    expect(r.histogram).toBeCloseTo(0, 9);
    expect(r.goldenCross).toBe(false);
    expect(r.deadCross).toBe(false);
    expect(r.histogramPositive).toBe(false);
  });

  it('34개 미만이면 null', () => {
    expect(computeMACD(new Array(33).fill(100))).toBeNull();
    expect(computeMACD(new Array(34).fill(100))).not.toBeNull();
  });

  it('골든/데드 크로스가 히스토그램 부호 전환과 일치한다 (N, N-1 만 사용)', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + 10 * Math.sin(i / 3));
    let golden = 0, dead = 0;
    for (let n = 35; n <= closes.length; n++) {
      const prev = computeMACD(closes.slice(0, n - 1));
      const cur = computeMACD(closes.slice(0, n));
      if (!prev || !cur) continue;
      if (cur.goldenCross) {
        golden++;
        expect(cur.histogram).toBeGreaterThan(0);
        expect(prev.histogram).toBeLessThanOrEqual(0);
      }
      if (cur.deadCross) {
        dead++;
        expect(cur.histogram).toBeLessThan(0);
        expect(prev.histogram).toBeGreaterThanOrEqual(0);
      }
      // 골든/데드는 상호 배타
      expect(cur.goldenCross && cur.deadCross).toBe(false);
    }
    expect(golden).toBeGreaterThan(0);
    expect(dead).toBeGreaterThan(0);
  });
});

// ── 캔들 패턴 ────────────────────────────────────────────────
describe('캔들스틱 패턴', () => {
  it('표준 도지', () => {
    const f = detectPatterns(C(100, 100.2, 99.5, 100.0));
    expect(f.doji).toBe(true);
    expect(f.longLeggedDoji).toBe(false);
    expect(f.dragonflyDoji).toBe(false);
    expect(f.gravestoneDoji).toBe(false);
  });
  it('롱레그 도지', () => {
    const f = detectPatterns(C(100, 105, 95, 100));
    expect(f.doji).toBe(true);
    expect(f.longLeggedDoji).toBe(true);
    expect(f.dragonflyDoji).toBe(false);
    expect(f.gravestoneDoji).toBe(false);
  });
  it('잠자리 도지 (dragonfly)', () => {
    const f = detectPatterns(C(100, 100.1, 95, 100));
    expect(f.doji).toBe(true);
    expect(f.dragonflyDoji).toBe(true);
    expect(f.gravestoneDoji).toBe(false);
    expect(f.longLeggedDoji).toBe(false);
  });
  it('비석 도지 (gravestone)', () => {
    const f = detectPatterns(C(100, 105, 99.9, 100));
    expect(f.doji).toBe(true);
    expect(f.gravestoneDoji).toBe(true);
    expect(f.dragonflyDoji).toBe(false);
  });
  it('해머', () => {
    const f = detectPatterns(C(100, 101.2, 95, 101));
    expect(f.hammer).toBe(true);
    expect(f.invertedHammer).toBe(false);
    expect(f.shootingStar).toBe(false);
  });
  it('역해머 (양봉)', () => {
    const f = detectPatterns(C(100, 107, 99.8, 101));
    expect(f.invertedHammer).toBe(true);
    expect(f.shootingStar).toBe(false);
    expect(f.hammer).toBe(false);
  });
  it('유성 (음봉)', () => {
    const f = detectPatterns(C(101, 107, 99.8, 100));
    expect(f.shootingStar).toBe(true);
    expect(f.invertedHammer).toBe(false);
  });
  it('상승 장악형', () => {
    const prev = C(100, 100.5, 98.5, 99);
    const f = detectPatterns(C(98.5, 101.5, 98, 101), prev);
    expect(f.bullishEngulfing).toBe(true);
    expect(f.bearishEngulfing).toBe(false);
    // prev 없으면 false
    expect(detectPatterns(C(98.5, 101.5, 98, 101)).bullishEngulfing).toBe(false);
  });
  it('하락 장악형', () => {
    const prev = C(99, 100.5, 98.5, 100);
    const f = detectPatterns(C(101, 101.5, 98, 98.5), prev);
    expect(f.bearishEngulfing).toBe(true);
    expect(f.bullishEngulfing).toBe(false);
  });
  it('상승 잉태형', () => {
    const prev = C(105, 105.5, 99.5, 100);
    const f = detectPatterns(C(101, 102.5, 100.5, 102), prev);
    expect(f.bullishHarami).toBe(true);
    expect(f.bearishHarami).toBe(false);
  });
  it('하락 잉태형', () => {
    const prev = C(100, 105.5, 99.5, 105);
    const f = detectPatterns(C(103, 103.5, 101.5, 102), prev);
    expect(f.bearishHarami).toBe(true);
    expect(f.bullishHarami).toBe(false);
  });
  it('range=0 이면 모든 패턴 false', () => {
    const f = detectPatterns(C(100, 100, 100, 100));
    expect(Object.values(f).every(v => v === false)).toBe(true);
  });
});

// ── 거래량 ───────────────────────────────────────────────────
describe('거래량', () => {
  it('SMA20, 비율, 급증 플래그', () => {
    const vols = new Array(19).fill(100).concat([300]);
    const candles = vols.map((v, i) => ({ datetime: ts(i), open: 1, high: 1, low: 1, close: 1, volume: v }));
    const r = computeVolume(candles, 20, 2)!;
    expect(r.currentVolume).toBe(300);
    expect(r.volumeSMA20).toBeCloseTo(110, 9);      // (19*100+300)/20
    expect(r.volumeRatio).toBeCloseTo(300 / 110, 9);
    expect(r.volumeSurge).toBe(true);
  });
  it('데이터 부족 / 평균 0 → null', () => {
    expect(computeVolume(candlesFromCloses([1, 2, 3]), 20)).toBeNull();
    const zeros = new Array(20).fill(0).map((_, i) => ({ datetime: ts(i), open: 1, high: 1, low: 1, close: 1, volume: 0 }));
    expect(computeVolume(zeros, 20)).toBeNull();
  });
});

// ── ATR ──────────────────────────────────────────────────────
describe('ATR', () => {
  it('TR 이 상수면 ATR 도 그 상수', () => {
    const candles = new Array(20).fill(0).map((_, i) => C(100, 101, 99, 100));
    expect(computeATR(candles, 14)).toBeCloseTo(2, 9);
  });
  it('데이터 부족 시 null', () => {
    expect(computeATR(new Array(14).fill(0).map(() => C(100, 101, 99, 100)), 14)).toBeNull();
  });
});

// ── ADX ──────────────────────────────────────────────────────
describe('ADX', () => {
  it('추세 없음(평탄) → ADX 0', () => {
    const candles = new Array(40).fill(0).map(() => C(100, 101, 99, 100));
    expect(computeADX(candles, 14)).toBeCloseTo(0, 9);
  });
  it('강한 상승추세 → ADX 100 근처', () => {
    const candles = Array.from({ length: 40 }, (_, i) => C(100 + i, 102 + i, 100 + i, 101 + i));
    const adx = computeADX(candles, 14)!;
    expect(adx).toBeGreaterThan(90);
    expect(Number.isFinite(adx)).toBe(true);
  });
  it('데이터 부족 시 null', () => {
    expect(computeADX(new Array(20).fill(0).map(() => C(100, 101, 99, 100)), 14)).toBeNull();
  });
});

// ── 볼린저 밴드폭 ────────────────────────────────────────────
describe('볼린저 밴드폭', () => {
  it('상수 종가 → 밴드폭 0', () => {
    expect(computeBollingerBandwidth(new Array(20).fill(100), 20, 2)).toBeCloseTo(0, 9);
  });
  it('알려진 분산 → (2*mult*std)/mean', () => {
    // 10개 98, 10개 102 → mean 100, var=4, std=2, bandwidth=(2*2*2)/100=0.08
    const closes = new Array(10).fill(98).concat(new Array(10).fill(102));
    expect(computeBollingerBandwidth(closes, 20, 2)).toBeCloseTo(0.08, 9);
  });
  it('데이터 부족 시 null', () => {
    expect(computeBollingerBandwidth(new Array(19).fill(100), 20, 2)).toBeNull();
  });
});

// ── 스냅샷: 데이터 부족 & NaN/Infinity 금지 ──────────────────
describe('지표 스냅샷', () => {
  it('데이터가 적어도 NaN/Infinity 없이 null 로 채운다', () => {
    const snap = buildIndicatorSnapshot(candlesFromCloses([100, 101, 102, 101, 100]))!;
    expect(snap).not.toBeNull();
    expect(snap.ema60).toBeNull();
    expect(snap.ema120).toBeNull();
    expect(snap.macd).toBeNull();
    expect(snap.adx14).toBeNull();
    assertNoNaNInfinity(snap);
  });

  it('현실적 40봉 시계열: 모든 수치가 유한 또는 null', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + 5 * Math.sin(i / 4) + i * 0.1);
    const candles = closes.map((c, i) => ({
      datetime: ts(i), open: c - 0.2, high: c + 1.5, low: c - 1.5, close: c, volume: 1000 + i * 10,
    }));
    const snap = buildIndicatorSnapshot(candles)!;
    assertNoNaNInfinity(snap);
    expect(snap.ema20).not.toBeNull();
    expect(snap.macd).not.toBeNull();
    expect(snap.atr14).not.toBeNull();
    expect(snap.adx14).not.toBeNull();
    expect(snap.bollingerBandwidth).not.toBeNull();
  });

  it('빈 입력 → null', () => {
    expect(buildIndicatorSnapshot([])).toBeNull();
  });
});

// ── 저장: UPSERT / 중복 방지 / 이력 보존 ─────────────────────
describe('스냅샷 저장 (UPSERT)', () => {
  const mk = (dt: string) => {
    const candles = candlesFromCloses(new Array(40).fill(100));
    candles[candles.length - 1].datetime = dt;
    return buildIndicatorSnapshot(candles)!;
  };

  it('동일 (market,symbol,candle_ts) 재스캔은 갱신 (중복 행 없음)', () => {
    const store = new InMemorySnapshotStore();
    store.upsert(snapshotToRow('005930', 'KR', mk('20260101090000')));
    store.upsert(snapshotToRow('005930', 'KR', mk('20260101090000'))); // 재스캔
    expect(store.size).toBe(1);
  });

  it('다른 candle_ts 는 새 행으로 이력 보존', () => {
    const store = new InMemorySnapshotStore();
    store.upsert(snapshotToRow('005930', 'KR', mk('20260101090000')));
    store.upsert(snapshotToRow('005930', 'KR', mk('20260101091500')));
    expect(store.size).toBe(2);
    expect(store.latestBySymbol()).toHaveLength(1);
    expect(store.latestBySymbol()[0].candle_ts).toBe('20260101091500');
  });

  it('다른 종목은 별도 행', () => {
    const store = new InMemorySnapshotStore();
    store.upsert(snapshotToRow('005930', 'KR', mk('20260101090000')));
    store.upsert(snapshotToRow('000660', 'KR', mk('20260101090000')));
    expect(store.size).toBe(2);
  });

  it('boolean 은 0/1, EMA 미정의 시 price_above_* 는 null', () => {
    const row = snapshotToRow('005930', 'KR', mk('20260101090000'));
    expect([0, 1]).toContain(row.macd_histogram_positive);
    expect([0, 1]).toContain(row.ema_bullish_alignment);
    // 40봉 상수 → ema120 정의 불가 → price_above_ema120 null
    expect(row.price_above_ema120).toBeNull();
  });
});

// ── look-ahead 없음 ─────────────────────────────────────────
describe('look-ahead 편향 없음', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + 8 * Math.sin(i / 5) + i * 0.05);
  const candles = closes.map((c, i) => ({
    datetime: ts(i), open: c - 0.1, high: c + 1.2, low: c - 1.2, close: c, volume: 1000 + i,
  }));

  it('인덱스 N 스냅샷은 candles[0..N] 만으로 계산된 것과 동일', () => {
    const series = computeSnapshotSeries(candles);
    for (let n = 0; n < candles.length; n++) {
      const fromPrefix = buildIndicatorSnapshot(candles.slice(0, n + 1));
      expect(series[n]).toEqual(fromPrefix);
    }
  });

  it('미래 캔들을 덧붙여도 과거 시점 스냅샷은 변하지 않는다', () => {
    const k = 45;
    const fromPrefix = buildIndicatorSnapshot(candles.slice(0, k));
    const fromFull = computeSnapshotSeries(candles)[k - 1];
    expect(fromFull).toEqual(fromPrefix);
  });
});
