/**
 * 기술적 지표 모듈 배럴 — 관찰/저장 전용.
 * 이 모듈들은 매매 판단(getBBSignal), 주문 실행/수량/손익 로직에 관여하지 않는다.
 */
export * from './types';
export { sma, emaSeries, emaValue } from './ema';
export { computeMACD } from './macd';
export { detectPatterns } from './candlestick';
export { computeVolume } from './volume';
export { computeATR } from './atr';
export { computeADX } from './adx';
export { computeBollingerBandwidth } from './bollinger-bandwidth';
export { buildIndicatorSnapshot, computeSnapshotSeries, type SnapshotOptions } from './snapshot';
export {
  updateIndicatorSnapshot, dropForming,
  INDICATOR_DEFAULT_DEPTH, INDICATOR_MIN_DEPTH,
  type IndicatorUpdateDeps, type IndicatorUpdateResult, type IndicatorUpdateStage,
} from './update';
export {
  CANDLE_HISTORY_TABLE, CANDLE_HISTORY_COLUMNS, CANDLE_HISTORY_UPSERT_SQL,
  buildCandleHistoryUpsertSQL, candleHistoryBindings, accumulateAndLoadKRCandles,
  InMemoryCandleHistory, type KRCandleAccumulateDeps,
} from './candle-history';
export {
  INDICATOR_TABLE, SNAPSHOT_COLUMNS, SNAPSHOT_KEY_COLUMNS,
  INDICATOR_UPSERT_SQL, buildUpsertSQL, snapshotToRow, rowToBindings,
  snapshotKey, InMemorySnapshotStore,
  type SnapshotRow, type SnapshotColumn,
} from './store';
