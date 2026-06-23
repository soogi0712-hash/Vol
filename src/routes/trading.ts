// API 라우트 - 트레이딩 데이터 조회
import { Hono } from 'hono';
import { runTradeScan } from '../lib/trade-engine';
import { getAccessToken, getHoldings, getDailyCandles } from '../lib/kis-api';
import { calcBollingerBands, getBollingerSignal } from '../lib/bollinger';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  KIS_APP_KEY: string;
  KIS_APP_SECRET: string;
  KIS_ACCOUNT_NO: string;
  KIS_ACCOUNT_SUFFIX: string;
};

const trading = new Hono<{ Bindings: Bindings }>();

// 대시보드 요약 정보
trading.get('/dashboard', async (c) => {
  const [holdings, totalProfit, recentOrders, config] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM holdings ORDER BY eval_profit_loss DESC').all(),
    c.env.DB.prepare('SELECT SUM(profit_loss) as total, COUNT(*) as count FROM realized_profits').first<{ total: number; count: number }>(),
    c.env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 10').all(),
    c.env.DB.prepare("SELECT key, value FROM system_config").all<{ key: string; value: string }>(),
  ]);

  const configMap: Record<string, string> = {};
  (config.results || []).forEach((r) => { configMap[r.key] = r.value; });

  return c.json({
    success: true,
    data: {
      holdings: holdings.results || [],
      total_eval_profit: (holdings.results || []).reduce((s: number, h: Record<string, unknown>) => s + (h.eval_profit_loss as number || 0), 0),
      realized_profit: totalProfit?.total || 0,
      realized_count: totalProfit?.count || 0,
      recent_orders: recentOrders.results || [],
      auto_trade_enabled: configMap['auto_trade_enabled'] === '1',
      last_scan_at: configMap['last_scan_at'] || null,
    },
  });
});

// 주문 내역
trading.get('/orders', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const ticker = c.req.query('ticker');

  let query = 'SELECT * FROM orders';
  const params: unknown[] = [];

  if (ticker) {
    query += ' WHERE ticker = ?';
    params.push(ticker);
  }
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = await c.env.DB.prepare(query).bind(...params).all();
  const total = await c.env.DB.prepare(
    ticker ? 'SELECT COUNT(*) as cnt FROM orders WHERE ticker = ?' : 'SELECT COUNT(*) as cnt FROM orders'
  ).bind(...(ticker ? [ticker] : [])).first<{ cnt: number }>();

  return c.json({
    success: true,
    data: rows.results || [],
    total: total?.cnt || 0,
    limit,
    offset,
  });
});

// 매매 로그
trading.get('/logs', async (c) => {
  const limit = parseInt(c.req.query('limit') || '100');
  const ticker = c.req.query('ticker');
  const action = c.req.query('action');

  let query = 'SELECT * FROM trade_logs';
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (ticker) { conditions.push('ticker = ?'); params.push(ticker); }
  if (action) { conditions.push('action = ?'); params.push(action); }
  if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const rows = await c.env.DB.prepare(query).bind(...params).all();
  return c.json({ success: true, data: rows.results || [] });
});

// 실현 손익
trading.get('/profits', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const rows = await c.env.DB.prepare(
    'SELECT * FROM realized_profits ORDER BY created_at DESC LIMIT ?'
  ).bind(limit).all();

  const summary = await c.env.DB.prepare(
    'SELECT SUM(profit_loss) as total, COUNT(*) as count, AVG(return_rate) as avg_rate FROM realized_profits'
  ).first<{ total: number; count: number; avg_rate: number }>();

  return c.json({
    success: true,
    data: rows.results || [],
    summary: {
      total_profit: summary?.total || 0,
      count: summary?.count || 0,
      avg_return_rate: summary?.avg_rate || 0,
    },
  });
});

// 보유 종목
trading.get('/holdings', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM holdings ORDER BY eval_profit_loss DESC'
  ).all();
  return c.json({ success: true, data: rows.results || [] });
});

// 자동매매 ON/OFF
trading.post('/toggle', async (c) => {
  const body = await c.req.json() as { enabled: boolean };
  const value = body.enabled ? '1' : '0';
  await c.env.DB.prepare(
    "UPDATE system_config SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'auto_trade_enabled'"
  ).bind(value).run();

  return c.json({
    success: true,
    message: `자동매매 ${body.enabled ? '활성화' : '비활성화'} 완료`,
    auto_trade_enabled: body.enabled,
  });
});

// 수동 스캔 실행
trading.post('/scan', async (c) => {
  const result = await runTradeScan({
    DB: c.env.DB,
    KV: c.env.KV,
    KIS_APP_KEY: c.env.KIS_APP_KEY,
    KIS_APP_SECRET: c.env.KIS_APP_SECRET,
    KIS_ACCOUNT_NO: c.env.KIS_ACCOUNT_NO,
    KIS_ACCOUNT_SUFFIX: c.env.KIS_ACCOUNT_SUFFIX,
  });
  return c.json({ success: true, ...result });
});

// 볼린저밴드 미리보기 (특정 종목)
trading.get('/preview/:ticker', async (c) => {
  const ticker = c.req.param('ticker');

  if (!c.env.KIS_APP_KEY) {
    return c.json({ success: false, message: 'API 키가 설정되지 않았습니다.' }, 400);
  }

  try {
    const config = {
      appKey: c.env.KIS_APP_KEY,
      appSecret: c.env.KIS_APP_SECRET,
      accountNo: c.env.KIS_ACCOUNT_NO,
      accountSuffix: c.env.KIS_ACCOUNT_SUFFIX || '01',
    };

    const token = await getAccessToken(config, c.env.KV);
    const candles = await getDailyCandles(config, token, ticker, 30);

    const closes = candles.map((c) => c.close);
    const dates = candles.map((c) => c.date);
    const bands = calcBollingerBands(closes, dates);

    // DB에서 보유 여부 확인
    const holding = await c.env.DB.prepare(
      'SELECT qty FROM holdings WHERE ticker = ?'
    ).bind(ticker).first<{ qty: number }>();
    const hasPosition = !!holding && holding.qty > 0;

    const signal = getBollingerSignal(bands, hasPosition);
    const recent = bands.slice(-5);

    return c.json({
      success: true,
      ticker,
      signal: signal.action,
      reason: signal.reason,
      current_band: signal.current,
      prev_band: signal.prev,
      has_position: hasPosition,
      recent_bands: recent,
    });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 보유 종목 강제 동기화 (KIS API → DB)
trading.post('/sync-holdings', async (c) => {
  if (!c.env.KIS_APP_KEY) {
    return c.json({ success: false, message: 'API 키가 설정되지 않았습니다.' }, 400);
  }

  try {
    const config = {
      appKey: c.env.KIS_APP_KEY,
      appSecret: c.env.KIS_APP_SECRET,
      accountNo: c.env.KIS_ACCOUNT_NO,
      accountSuffix: c.env.KIS_ACCOUNT_SUFFIX || '01',
    };

    const token = await getAccessToken(config, c.env.KV);
    const holdings = await getHoldings(config, token);

    await c.env.DB.prepare('DELETE FROM holdings').run();
    for (const h of holdings) {
      await c.env.DB.prepare(
        `INSERT OR REPLACE INTO holdings (ticker, ticker_name, qty, avg_price, current_price, eval_profit_loss, eval_return_rate, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      )
        .bind(h.ticker, h.ticker_name, h.qty, h.avg_price, h.current_price, h.eval_profit_loss, h.eval_return_rate)
        .run();
    }

    return c.json({ success: true, message: `${holdings.length}개 종목 동기화 완료`, data: holdings });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

export default trading;
