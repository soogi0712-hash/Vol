// Phase 3: KR 매매용 15분봉 소스
// ─────────────────────────────────────────────────────────────
// 기존 getKR15MinCandles 는 FHKST03010200(당일 1분봉·최대 30개·단건)을 그대로
// 15분봉처럼 사용해, 확정봉 제거 후 29개(<30)로 항상 NO_DATA 였다(잘못된 타임프레임).
// 여기서는 collectKR15Min(1분봉 역페이징 → 09:00 기준 15분 집계 → 완성봉만 저장)으로
// candle_history(timeframe='15m')에 크로스데이 누적하고, 그 15분봉을 읽어 매매에 쓴다.
//
// ★ 물리적 제약: 정상장 하루 완성 15분봉은 최대 26개(09:00~15:30).
//   따라서 최초 종목은 candle_history 가 30개에 도달하기까지 약 1.5 세션이 필요하다.
//   (게이트 30 유지 결정에 따름 — 당일만으로 30개를 만들 수 없다.)
import type { KISConfig, Candle } from './kis-api';
import { fetchKR1MinPage } from './kis-api';
import { collectKR15Min } from './kr-candles';
import type { KisRateLimiter } from './kis-rate-limit';
import { CANDLE_HISTORY_UPSERT_SQL, candleHistoryBindings } from './indicators';

export interface KRTradeSourceDeps {
  db: D1Database;
  cfg: KISConfig;
  token: string;
  ticker: string;
  count: number;        // 매매에 반환할 15분봉 개수 (oldest→newest)
  nowMs: number;
  limiter: KisRateLimiter;
  maxPages?: number;          // 부트스트랩(이력 없음) 페이지 상한
  incrementalPages?: number;  // 증분(이력 있음) 페이지 상한
}

export interface KRTradeSourceResult {
  candles: Candle[];
  mode: 'bootstrap' | 'incremental';
  inserted: number;
  updated: number;
  totalKisCalls: number;
  stopReason: string;
}

/**
 * 증분/부트스트랩 수집으로 candle_history(15m)를 갱신한 뒤, 최근 count개를
 * oldest→newest 로 읽어 반환한다. 반환 캔들은 모두 "완성 15분봉"이므로 호출측은
 * 별도의 확정봉 제거(형성봉 drop)를 하지 않는다(진행봉은 애초에 저장되지 않음).
 */
export async function loadKRTradeCandles(deps: KRTradeSourceDeps): Promise<KRTradeSourceResult> {
  const { db, cfg, token, ticker, count, nowMs, limiter } = deps;

  const report = await collectKR15Min({
    ticker,
    nowMs,
    maxPages: deps.maxPages ?? 15,
    incrementalPages: deps.incrementalPages ?? 2,
    fetchPage: (endTime) => limiter.run(() => fetchKR1MinPage(cfg, token, ticker, endTime)),
    latestStoredTs: async () => {
      const r = await db.prepare(
        `SELECT candle_ts FROM candle_history
         WHERE market='KR' AND symbol=? AND timeframe='15m' ORDER BY candle_ts DESC LIMIT 1`,
      ).bind(ticker).first<{ candle_ts: string }>();
      return r?.candle_ts ?? null;
    },
    upsert15m: async (bars) => {
      if (!bars.length) return { inserted: 0, updated: 0 };
      // 신규/업데이트 구분: upsert 전 기존 candle_ts 집합 조회
      const before = new Set<string>();
      const rows = await db.prepare(
        `SELECT candle_ts FROM candle_history WHERE market='KR' AND symbol=? AND timeframe='15m'`,
      ).bind(ticker).all<{ candle_ts: string }>();
      (rows.results || []).forEach(r => before.add(r.candle_ts));

      const stmt = db.prepare(CANDLE_HISTORY_UPSERT_SQL);
      await db.batch(bars.map(b => stmt.bind(...candleHistoryBindings('KR', ticker, '15m', b))));

      let inserted = 0, updated = 0;
      for (const b of bars) (before.has(b.datetime) ? updated++ : inserted++);
      return { inserted, updated };
    },
  });

  // candle_history(15m)에서 최근 count개 (DESC 조회 → oldest→newest 재정렬)
  const rows = await db.prepare(
    `SELECT candle_ts, open, high, low, close, volume FROM candle_history
     WHERE market='KR' AND symbol=? AND timeframe='15m' ORDER BY candle_ts DESC LIMIT ?`,
  ).bind(ticker, count).all<{
    candle_ts: string; open: number; high: number; low: number; close: number; volume: number;
  }>();

  const candles: Candle[] = (rows.results || [])
    .map(r => ({
      ticker, market: 'KR' as const, datetime: r.candle_ts,
      open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
    }))
    .reverse();

  return {
    candles,
    mode: report.mode,
    inserted: report.stored.inserted,
    updated: report.stored.updated,
    totalKisCalls: report.totalKisCalls,
    stopReason: report.stopReason,
  };
}
