// 기술적 지표 모니터링 API 라우트 (관찰/저장 전용, 매매와 무관)
import { Hono } from 'hono';

type Bindings = {
  DB: D1Database; KV: KVNamespace;
  KIS_APP_KEY: string; KIS_APP_SECRET: string;
  KIS_ACCOUNT_NO: string; KIS_ACCOUNT_SUFFIX: string;
};

const indicators = new Hono<{ Bindings: Bindings }>();

// ─── 종목별 최신 지표 스냅샷 ─────────────────────────────────
// 각 (market, symbol) 의 candle_ts 최대 행 = 최신 스냅샷
indicators.get('/latest', async (c) => {
  const market = c.req.query('market');           // 선택: KR | US
  const symbol = c.req.query('symbol');           // 선택: 단일 종목
  const limit  = Math.min(parseInt(c.req.query('limit') || '200'), 1000);

  try {
    const cond: string[] = [];
    const params: unknown[] = [];
    if (market) { cond.push('s.market = ?'); params.push(market); }
    if (symbol) { cond.push('s.symbol = ?'); params.push(symbol); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';

    const sql =
      `SELECT s.* FROM indicator_snapshots s
       JOIN (
         SELECT market, symbol, MAX(candle_ts) AS mts
         FROM indicator_snapshots
         GROUP BY market, symbol
       ) l ON s.market = l.market AND s.symbol = l.symbol AND s.candle_ts = l.mts
       ${where}
       ORDER BY s.symbol
       LIMIT ?`;
    params.push(limit);

    const rows = await c.env.DB.prepare(sql).bind(...params).all();
    return c.json({ success: true, data: rows.results || [] });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// ─── 단일 종목 지표 이력 (과거 스냅샷) ───────────────────────
indicators.get('/history/:market/:symbol', async (c) => {
  const market = c.req.param('market').toUpperCase();
  const symbol = c.req.param('symbol').toUpperCase();
  const limit  = Math.min(parseInt(c.req.query('limit') || '100'), 1000);
  try {
    const rows = await c.env.DB.prepare(
      `SELECT * FROM indicator_snapshots
       WHERE market = ? AND symbol = ?
       ORDER BY candle_ts DESC
       LIMIT ?`
    ).bind(market, symbol, limit).all();
    return c.json({ success: true, data: rows.results || [] });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

export default indicators;
