/**
 * 지표 스냅샷 영속화 — 순수 행 매핑 + UPSERT SQL + 인메모리 스토어(테스트용)
 * ─────────────────────────────────────────────────────────────
 * DB 규약: boolean 은 INTEGER(0/1), boolean|null 은 0/1/null.
 * 유니크 키: (market, symbol, candle_ts). 반복 스캔은 UPSERT(갱신),
 * 서로 다른 candle_ts 는 별도 행으로 보존(과거 이력 유지).
 *
 * 실제 D1 저장은 INDICATOR_UPSERT_SQL + rowToBindings 를 사용하고,
 * 테스트는 동일한 키/UPSERT 의미를 InMemorySnapshotStore 로 검증한다.
 */
import type { IndicatorSnapshot } from './types';

export const INDICATOR_TABLE = 'indicator_snapshots';

// INSERT 컬럼 순서 (마이그레이션의 컬럼과 일치)
export const SNAPSHOT_COLUMNS = [
  'symbol', 'market', 'candle_ts', 'close',
  'ema20', 'ema30', 'ema60', 'ema120',
  'macd', 'macd_signal', 'macd_histogram',
  'macd_golden_cross', 'macd_dead_cross', 'macd_histogram_positive',
  'doji', 'long_legged_doji', 'dragonfly_doji', 'gravestone_doji',
  'hammer', 'inverted_hammer', 'shooting_star',
  'bullish_engulfing', 'bearish_engulfing', 'bullish_harami', 'bearish_harami',
  'current_volume', 'volume_sma20', 'volume_ratio', 'volume_surge',
  'atr14', 'adx14', 'bollinger_bandwidth',
  'ema_bullish_alignment', 'ema_bearish_alignment',
  'price_above_ema20', 'price_above_ema30', 'price_above_ema60', 'price_above_ema120',
  'ema30_pullback_candidate',
] as const;

export type SnapshotColumn = (typeof SNAPSHOT_COLUMNS)[number];
export const SNAPSHOT_KEY_COLUMNS: SnapshotColumn[] = ['market', 'symbol', 'candle_ts'];

export type SnapshotRow = Record<SnapshotColumn, string | number | null>;

const b = (v: boolean): 0 | 1 => (v ? 1 : 0);
const bn = (v: boolean | null): 0 | 1 | null => (v === null ? null : v ? 1 : 0);

/** 스냅샷 + 식별자를 DB 행(boolean→0/1)으로 매핑한다. 순수 함수. */
export function snapshotToRow(
  symbol: string,
  market: string,
  s: IndicatorSnapshot,
): SnapshotRow {
  return {
    symbol,
    market,
    candle_ts: s.candleTimestamp,
    close: s.close,
    ema20: s.ema20, ema30: s.ema30, ema60: s.ema60, ema120: s.ema120,
    macd: s.macd, macd_signal: s.macdSignal, macd_histogram: s.macdHistogram,
    macd_golden_cross: b(s.macdGoldenCross),
    macd_dead_cross: b(s.macdDeadCross),
    macd_histogram_positive: b(s.macdHistogramPositive),
    doji: b(s.patterns.doji),
    long_legged_doji: b(s.patterns.longLeggedDoji),
    dragonfly_doji: b(s.patterns.dragonflyDoji),
    gravestone_doji: b(s.patterns.gravestoneDoji),
    hammer: b(s.patterns.hammer),
    inverted_hammer: b(s.patterns.invertedHammer),
    shooting_star: b(s.patterns.shootingStar),
    bullish_engulfing: b(s.patterns.bullishEngulfing),
    bearish_engulfing: b(s.patterns.bearishEngulfing),
    bullish_harami: b(s.patterns.bullishHarami),
    bearish_harami: b(s.patterns.bearishHarami),
    current_volume: s.currentVolume,
    volume_sma20: s.volumeSMA20,
    volume_ratio: s.volumeRatio,
    volume_surge: b(s.volumeSurge),
    atr14: s.atr14,
    adx14: s.adx14,
    bollinger_bandwidth: s.bollingerBandwidth,
    ema_bullish_alignment: b(s.emaBullishAlignment),
    ema_bearish_alignment: b(s.emaBearishAlignment),
    price_above_ema20: bn(s.priceAboveEma20),
    price_above_ema30: bn(s.priceAboveEma30),
    price_above_ema60: bn(s.priceAboveEma60),
    price_above_ema120: bn(s.priceAboveEma120),
    ema30_pullback_candidate: b(s.ema30PullbackCandidate),
  };
}

/** SNAPSHOT_COLUMNS 순서대로 바인딩 값 배열을 만든다. */
export function rowToBindings(row: SnapshotRow): (string | number | null)[] {
  return SNAPSHOT_COLUMNS.map(col => row[col]);
}

/** (market, symbol, candle_ts) 기준 UPSERT SQL. 반복 스캔 시 값 갱신. */
export function buildUpsertSQL(): string {
  const cols = SNAPSHOT_COLUMNS.join(', ');
  const placeholders = SNAPSHOT_COLUMNS.map(() => '?').join(', ');
  const updates = SNAPSHOT_COLUMNS
    .filter(c => !SNAPSHOT_KEY_COLUMNS.includes(c))
    .map(c => `${c}=excluded.${c}`)
    .join(', ');
  return (
    `INSERT INTO ${INDICATOR_TABLE} (${cols}) VALUES (${placeholders}) ` +
    `ON CONFLICT(market, symbol, candle_ts) DO UPDATE SET ${updates}, updated_at=CURRENT_TIMESTAMP`
  );
}

export const INDICATOR_UPSERT_SQL = buildUpsertSQL();

/** 유니크 키 문자열 */
export function snapshotKey(row: Pick<SnapshotRow, 'market' | 'symbol' | 'candle_ts'>): string {
  return `${row.market}|${row.symbol}|${row.candle_ts}`;
}

/**
 * 인메모리 스냅샷 스토어 — 실제 D1 UPSERT 와 동일한 키/갱신 의미를 재현한다.
 * 테스트에서 upsert(갱신), 중복 방지, 과거 행 보존을 검증하는 데 사용한다.
 */
export class InMemorySnapshotStore {
  private map = new Map<string, SnapshotRow>();

  upsert(row: SnapshotRow): void {
    // 동일 키 → 덮어쓰기(갱신). 다른 candle_ts → 새 행 추가(이력 보존).
    this.map.set(snapshotKey(row), { ...row });
  }

  get(market: string, symbol: string, candle_ts: string): SnapshotRow | undefined {
    return this.map.get(snapshotKey({ market, symbol, candle_ts }));
  }

  get size(): number {
    return this.map.size;
  }

  all(): SnapshotRow[] {
    return [...this.map.values()];
  }

  /** 종목별 최신(candle_ts 최대) 행 */
  latestBySymbol(): SnapshotRow[] {
    const latest = new Map<string, SnapshotRow>();
    for (const row of this.map.values()) {
      const k = `${row.market}|${row.symbol}`;
      const cur = latest.get(k);
      if (!cur || String(row.candle_ts) > String(cur.candle_ts)) latest.set(k, row);
    }
    return [...latest.values()];
  }
}
