// Phase 1 진단 라우트 — KR 1분봉 수집 → 15분봉 집계 → candle_history(15m) 저장
// 관찰 전용: 이 경로는 주문 함수(buyKR/sellKR/buyUS/sellUS)를 절대 호출하지 않는다.
import { Hono } from 'hono';
import { getAccessToken, fetchKR1MinPage } from '../lib/kis-api';
import { collectKR15Min } from '../lib/kr-candles';
import { makeKisRateLimiter } from '../lib/kis-rate-limit';
import { CANDLE_HISTORY_UPSERT_SQL, candleHistoryBindings } from '../lib/indicators';

type Bindings = {
  DB: D1Database; KV: KVNamespace;
  KIS_APP_KEY: string; KIS_APP_SECRET: string;
  KIS_ACCOUNT_NO: string; KIS_ACCOUNT_SUFFIX: string;
};

const diag = new Hono<{ Bindings: Bindings }>();

// GET /api/diag/kr-candles/:ticker  — 지정 1개 종목만
diag.get('/kr-candles/:ticker', async (c) => {
  const ticker = c.req.param('ticker').toUpperCase();
  const maxPages = Math.min(parseInt(c.req.query('maxPages') || '15'), 15);
  if (!c.env.KIS_APP_KEY) return c.json({ success: false, message: 'API 키 미설정' }, 400);

  try {
    const cfg = {
      appKey: c.env.KIS_APP_KEY, appSecret: c.env.KIS_APP_SECRET,
      accountNo: c.env.KIS_ACCOUNT_NO, accountSuffix: c.env.KIS_ACCOUNT_SUFFIX || '01',
    };
    const token = await getAccessToken(cfg, c.env.KV);
    // 보수적: 최소 간격 150ms (~6.6/s), 20/s 상한의 1/3 수준
    const limiter = makeKisRateLimiter({ minIntervalMs: 150, maxRetries: 3, baseBackoffMs: 300 });

    const report = await collectKR15Min({
      ticker,
      nowMs: Date.now(),
      maxPages,
      fetchPage: (endTime) => limiter.run(() => fetchKR1MinPage(cfg, token, ticker, endTime)),
      latestStoredTs: async () => {
        const r = await c.env.DB.prepare(
          `SELECT candle_ts FROM candle_history WHERE market='KR' AND symbol=? AND timeframe='15m' ORDER BY candle_ts DESC LIMIT 1`,
        ).bind(ticker).first<{ candle_ts: string }>();
        return r?.candle_ts ?? null;
      },
      upsert15m: async (bars) => {
        if (!bars.length) return { inserted: 0, updated: 0 };
        // 신규/업데이트/중복 구분: upsert 전 기존 candle_ts 집합 조회
        const before = new Set<string>();
        const rows = await c.env.DB.prepare(
          `SELECT candle_ts FROM candle_history WHERE market='KR' AND symbol=? AND timeframe='15m'`,
        ).bind(ticker).all<{ candle_ts: string }>();
        (rows.results || []).forEach(r => before.add(r.candle_ts));

        const stmt = c.env.DB.prepare(CANDLE_HISTORY_UPSERT_SQL);
        await c.env.DB.batch(bars.map(b => stmt.bind(...candleHistoryBindings('KR', ticker, '15m', b))));

        let inserted = 0, updated = 0;
        for (const b of bars) (before.has(b.datetime) ? updated++ : inserted++);
        return { inserted, updated };
      },
    });

    // 저장 후 D1 총 15분봉 개수
    const total = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM candle_history WHERE market='KR' AND symbol=? AND timeframe='15m'`,
    ).bind(ticker).first<{ n: number }>();

    return c.json({
      success: true,
      observe_only: true,       // 이 경로는 주문 함수를 호출하지 않음
      orders_submitted: 0,
      d1_total_15m: total?.n ?? 0,
      diag: report,
    });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

export default diag;
