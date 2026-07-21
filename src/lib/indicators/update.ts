/**
 * 지표 스냅샷 갱신 오케스트레이션 (관찰/저장 전용)
 * ─────────────────────────────────────────────────────────────
 * 매매 경로와 완전히 분리된, 의존성 주입식 순수 조립 함수.
 * 트레이딩 코드는 실제 DB/KIS 의존성을 주입하고, 테스트는 가짜 의존성으로
 * 스로틀·실패격리·EMA120 산출을 결정적으로 검증한다.
 *
 * 핵심 규칙:
 *  - 매매용 캔들/신호에는 절대 관여하지 않는다 (별도 확장 조회를 사용).
 *  - 스로틀: 동일 완결봉(candle_ts)에 대한 스냅샷이 이미 있으면 재조회/재계산하지
 *    않는다 → 분당 스캔이 반복돼도 15분봉당 확장 조회는 1회.
 *  - 실패 격리: 확장 조회/계산/저장 중 어떤 예외도 밖으로 던지지 않는다.
 *    호출 측(매매 스캔)은 결과 status 만 보고 로깅 후 계속 진행한다.
 *  - EMA120 등은 데이터가 충분할 때만 값이 채워지고, 부족하면 null (오해 소지 없음).
 */
import { buildIndicatorSnapshot, type SnapshotOptions } from './snapshot';
import type { IndicatorCandle, IndicatorSnapshot } from './types';

// 지표 확장 조회 기본 깊이. EMA120 는 완결봉 120개가 필요하고, 형성 중 최신봉
// 1개를 버리므로 raw 최소 121개가 필요 → 여유 버퍼 150 (KIS US NREC 최대 200 이내).
export const INDICATOR_DEFAULT_DEPTH = 150;
export const INDICATOR_MIN_DEPTH = 121;

/** 형성 중(미확정) 최신봉 1개를 제거해 완결봉만 남긴다 (오래→최신 유지). */
export function dropForming<T>(candles: readonly T[]): T[] {
  return candles.length > 1 ? candles.slice(0, -1) : candles.slice();
}

export interface IndicatorUpdateDeps {
  market: string;
  symbol: string;
  /** 매매 확정봉의 시각 — 스로틀 키. null 이면 스킵. */
  tradingCompletedTs: string | null;
  /** (market,symbol,candle_ts) 스냅샷 존재 여부 */
  snapshotExists: (market: string, symbol: string, candleTs: string) => Promise<boolean>;
  /** 확장(관측용) 캔들 조회 — 오래→최신, 형성 중 최신봉 포함 가능 */
  fetchExtendedCandles: () => Promise<IndicatorCandle[]>;
  /** 스냅샷 저장 (UPSERT) */
  saveSnapshot: (symbol: string, market: string, snap: IndicatorSnapshot) => Promise<void>;
  options?: SnapshotOptions;
}

export type IndicatorUpdateResult =
  | { status: 'skipped_no_candle' }
  | { status: 'skipped_throttled' }
  | { status: 'saved'; snapshot: IndicatorSnapshot }
  | { status: 'error'; message: string };

/**
 * 지표 스냅샷을 (필요 시) 조회·계산·저장한다. 절대 예외를 던지지 않는다.
 * 반환 status 로 호출 측이 로깅/계속을 판단한다 → 매매를 막지 않는다.
 */
export async function updateIndicatorSnapshot(
  deps: IndicatorUpdateDeps,
): Promise<IndicatorUpdateResult> {
  try {
    if (!deps.tradingCompletedTs) return { status: 'skipped_no_candle' };

    // 스로틀: 같은 완결봉이면 확장 조회조차 하지 않는다 (rate-limit 안전)
    if (await deps.snapshotExists(deps.market, deps.symbol, deps.tradingCompletedTs)) {
      return { status: 'skipped_throttled' };
    }

    const extended = await deps.fetchExtendedCandles();
    const confirmed = dropForming(extended);          // 완결봉만
    const snap = buildIndicatorSnapshot(confirmed, deps.options);
    if (!snap) return { status: 'skipped_no_candle' };

    await deps.saveSnapshot(deps.symbol, deps.market, snap);
    return { status: 'saved', snapshot: snap };
  } catch (e) {
    // 실패 격리 — 매매는 이미 원본 캔들로 진행됐거나 진행될 것이며 영향받지 않는다.
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
