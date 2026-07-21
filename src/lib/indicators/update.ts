/**
 * 지표 스냅샷 갱신 오케스트레이션 (관찰/저장 전용)
 * ─────────────────────────────────────────────────────────────
 * 매매 경로와 완전히 분리된, 의존성 주입식 순수 조립 함수.
 * 캔들 소스(loadCandles)는 시장별로 다르게 주입된다:
 *   - KR: 매매 확정봉을 candle_history 에 누적 후 최근 N개를 읽어 반환 (KIS 추가요청 0)
 *   - US: NREC 최대 200 확장 조회 후 형성봉 제거 (기존 유지)
 * loadCandles 는 항상 "완결봉, oldest→newest" 를 반환한다.
 *
 * 핵심 규칙:
 *  - 매매용 캔들/신호에는 절대 관여하지 않는다.
 *  - 스로틀: 동일 완결봉(candle_ts) 스냅샷이 이미 있으면 로드/계산/저장을 건너뛴다
 *    → 분당 스캔이 반복돼도 15분봉당 로드는 1회. (KR: 추가 KIS 요청 없음)
 *  - 실패 격리: 어떤 예외도 밖으로 던지지 않는다. status/stage 로 보고한다.
 *  - EMA120 등은 완결봉이 충분할 때만 채워지고 부족하면 null (오해 소지 없음).
 */
import { buildIndicatorSnapshot, type SnapshotOptions } from './snapshot';
import type { IndicatorCandle, IndicatorSnapshot } from './types';

// 지표 조회/누적 기본 깊이. EMA120 은 완결봉 120개가 필요 → 여유 버퍼 150
// (KIS 해외 NREC 최대 200 이내). KR 은 이 값만큼 이력에서 읽는다.
export const INDICATOR_DEFAULT_DEPTH = 150;
export const INDICATOR_MIN_DEPTH = 121;

// 스냅샷이 "충분히 누적됨"으로 간주되는 완결봉 수 (EMA120 요구치).
// 이 수 미만으로 저장된 스냅샷은 스로틀하지 않고 재계산해 self-heal 한다.
export const SNAPSHOT_COMPLETE_HISTORY = 120;

/** 형성 중(미확정) 최신봉 1개를 제거해 완결봉만 남긴다 (오래→최신 유지). */
export function dropForming<T>(candles: readonly T[]): T[] {
  return candles.length > 1 ? candles.slice(0, -1) : candles.slice();
}

export type IndicatorUpdateStage = 'throttle' | 'load' | 'calc' | 'save';

export interface IndicatorUpdateDeps {
  market: string;
  symbol: string;
  /** 매매 확정봉의 시각 — 스로틀 키. null 이면 스킵. */
  tradingCompletedTs: string | null;
  /**
   * 기존 스냅샷의 history_count 를 반환한다 (없으면 null).
   * 스로틀은 "충분히 누적된" 스냅샷만 건너뛰도록 이 값을 사용한다.
   */
  existingHistoryCount: (market: string, symbol: string, candleTs: string) => Promise<number | null>;
  /**
   * 이 값 이상으로 누적된 스냅샷이 이미 있으면 재계산을 건너뛴다(스로틀).
   * KR=120(EMA120 요구치) → 이력 부족 스냅샷은 이후 self-heal 재계산.
   * US=0 → 스냅샷이 있으면 항상 스로틀(불필요한 재조회 방지).
   */
  throttleMinHistoryCount: number;
  /** 완결봉(oldest→newest) 로드 — 시장별 소스 주입 */
  loadCandles: () => Promise<IndicatorCandle[]>;
  /** 스냅샷 저장 (UPSERT) */
  saveSnapshot: (symbol: string, market: string, snap: IndicatorSnapshot) => Promise<void>;
  options?: SnapshotOptions;
}

export type IndicatorUpdateResult =
  | { status: 'skipped_no_candle' }
  | { status: 'skipped_throttled' }
  | { status: 'saved'; snapshot: IndicatorSnapshot }
  | { status: 'error'; stage: IndicatorUpdateStage; message: string };

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 지표 스냅샷을 (필요 시) 로드·계산·저장한다. 절대 예외를 던지지 않는다.
 * 반환 status/stage 로 호출 측이 로깅/계속을 판단한다 → 매매를 막지 않는다.
 */
export async function updateIndicatorSnapshot(
  deps: IndicatorUpdateDeps,
): Promise<IndicatorUpdateResult> {
  if (!deps.tradingCompletedTs) return { status: 'skipped_no_candle' };

  // 스로틀: 같은 완결봉의 스냅샷이 "충분히 누적된" 상태로 이미 있을 때만 건너뛴다.
  // 이력 부족(history_count < throttleMinHistoryCount)으로 저장된 스냅샷은
  // 스로틀하지 않고 재계산 → 이후 이력이 쌓이면 self-heal 된다.
  try {
    const existing = await deps.existingHistoryCount(deps.market, deps.symbol, deps.tradingCompletedTs);
    if (existing !== null && existing >= deps.throttleMinHistoryCount) {
      return { status: 'skipped_throttled' };
    }
  } catch (e) {
    return { status: 'error', stage: 'throttle', message: msg(e) };
  }

  let candles: IndicatorCandle[];
  try {
    candles = await deps.loadCandles();          // 완결봉, oldest→newest
  } catch (e) {
    return { status: 'error', stage: 'load', message: msg(e) };
  }

  let snap: IndicatorSnapshot | null;
  try {
    snap = buildIndicatorSnapshot(candles, deps.options);
  } catch (e) {
    return { status: 'error', stage: 'calc', message: msg(e) };
  }
  if (!snap) return { status: 'skipped_no_candle' };

  try {
    await deps.saveSnapshot(deps.symbol, deps.market, snap);
  } catch (e) {
    return { status: 'error', stage: 'save', message: msg(e) };
  }
  return { status: 'saved', snapshot: snap };
}
