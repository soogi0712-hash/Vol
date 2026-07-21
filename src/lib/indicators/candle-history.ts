/**
 * 확정 캔들 이력 (관찰 전용) — 누적 저장 + 최근 N개 조회
 * ─────────────────────────────────────────────────────────────
 * KR 국내 15분봉은 추가 KIS 요청으로 장기 이력을 얻을 수 없으므로, 매매 스캔이
 * 이미 가져온 확정봉을 D1(candle_history)에 누적하고 지표 계산 시 최근 N개를
 * 읽어 사용한다. 형성 중(미확정) 최신봉은 저장하지 않는다(호출 측이 제거).
 *
 * 유니크 키 (market, symbol, candle_ts) — 반복 스캔은 UPSERT, 다른 봉은 이력 보존.
 */
import type { IndicatorCandle } from './types';

export const CANDLE_HISTORY_TABLE = 'candle_history';

export const CANDLE_HISTORY_COLUMNS = [
  'market', 'symbol', 'candle_ts', 'open', 'high', 'low', 'close', 'volume',
] as const;

/** (market,symbol,candle_ts) 기준 UPSERT SQL. */
export function buildCandleHistoryUpsertSQL(): string {
  const cols = CANDLE_HISTORY_COLUMNS.join(', ');
  const ph = CANDLE_HISTORY_COLUMNS.map(() => '?').join(', ');
  const upd = ['open', 'high', 'low', 'close', 'volume']
    .map(c => `${c}=excluded.${c}`).join(', ');
  return (
    `INSERT INTO ${CANDLE_HISTORY_TABLE} (${cols}) VALUES (${ph}) ` +
    `ON CONFLICT(market, symbol, candle_ts) DO UPDATE SET ${upd}, updated_at=CURRENT_TIMESTAMP`
  );
}

export const CANDLE_HISTORY_UPSERT_SQL = buildCandleHistoryUpsertSQL();

/** 한 캔들의 바인딩 값 (CANDLE_HISTORY_COLUMNS 순서). */
export function candleHistoryBindings(
  market: string, symbol: string, c: IndicatorCandle,
): (string | number)[] {
  return [market, symbol, c.datetime, c.open, c.high, c.low, c.close, c.volume];
}

export interface KRCandleAccumulateDeps {
  market: string;
  symbol: string;
  /** 매매 확정봉 (형성봉 제외됨). 이력에 누적 저장할 대상. */
  confirmedCandles: readonly IndicatorCandle[];
  /** 이력 UPSERT */
  upsert: (market: string, symbol: string, candles: readonly IndicatorCandle[]) => Promise<void>;
  /** 최근 limit 개를 oldest→newest 로 조회 */
  readLatest: (market: string, symbol: string, limit: number) => Promise<IndicatorCandle[]>;
  limit: number;
}

/**
 * KR 지표용 캔들 로더 — 확정봉을 이력에 누적한 뒤 최근 limit 개를 읽어 반환한다.
 * 추가 KIS 요청을 하지 않는다. 단계별로 실패 원인을 태깅해 던진다(호출 측 격리).
 */
export async function accumulateAndLoadKRCandles(
  deps: KRCandleAccumulateDeps,
): Promise<IndicatorCandle[]> {
  try {
    await deps.upsert(deps.market, deps.symbol, deps.confirmedCandles);
  } catch (e) {
    throw new Error(`candle_history upsert: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return await deps.readLatest(deps.market, deps.symbol, deps.limit);
  } catch (e) {
    throw new Error(`candle_history read: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 인메모리 캔들 이력 — 실제 D1 UPSERT/조회와 동일한 키/정렬 의미를 재현(테스트용).
 */
export class InMemoryCandleHistory {
  private m = new Map<string, IndicatorCandle & { market: string; symbol: string }>();
  private key(market: string, symbol: string, ts: string): string {
    return `${market}|${symbol}|${ts}`;
  }

  async upsert(market: string, symbol: string, candles: readonly IndicatorCandle[]): Promise<void> {
    for (const c of candles) {
      this.m.set(this.key(market, symbol, c.datetime), { market, symbol, ...c });
    }
  }

  /** 최근 limit 개를 oldest→newest 로 반환 */
  async readLatest(market: string, symbol: string, limit: number): Promise<IndicatorCandle[]> {
    const rows = [...this.m.values()]
      .filter(r => r.market === market && r.symbol === symbol)
      .sort((a, b) => a.datetime.localeCompare(b.datetime));
    return rows.slice(-limit).map(r => ({
      datetime: r.datetime, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
    }));
  }

  count(market: string, symbol: string): number {
    return [...this.m.values()].filter(r => r.market === market && r.symbol === symbol).length;
  }

  get size(): number {
    return this.m.size;
  }
}
