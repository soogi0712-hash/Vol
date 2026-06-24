// 트레이딩 API 라우트 v3
import { Hono } from 'hono';
import { runTradeScan, syncHoldings, isKRMarketOpen, isUSMarketOpen } from '../lib/trade-engine';
import {
  getAccessToken, getKR15MinCandles, getUS15MinCandles,
  getKRHoldings, getUSHoldings, getKROrderableCash, getUSOrderableCash,
  type ExchangeCode,
} from '../lib/kis-api';
import { calcBB, getBBSignal } from '../lib/bollinger';
import { runKISBacktest } from '../lib/backtest';
import {
  loadUniverseToDB, getScanStats, getSignalStocks,
  getUniverseStats, STOCK_UNIVERSE,
} from '../lib/stock-universe';

type Bindings = {
  DB: D1Database; KV: KVNamespace;
  KIS_APP_KEY: string; KIS_APP_SECRET: string;
  KIS_ACCOUNT_NO: string; KIS_ACCOUNT_SUFFIX: string;
};

const trading = new Hono<{ Bindings: Bindings }>();

// ─── 대시보드 ────────────────────────────────────────────────
trading.get('/dashboard', async (c) => {
  const [holdings, totalProfit, recentOrders, sysConf] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM holdings ORDER BY eval_profit_loss DESC').all(),
    c.env.DB.prepare('SELECT SUM(profit_loss) as total, COUNT(*) as cnt FROM realized_profits').first<{ total: number; cnt: number }>(),
    c.env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 10').all(),
    c.env.DB.prepare('SELECT key, value FROM system_config').all<{ key: string; value: string }>(),
  ]);
  const cfgMap: Record<string, string> = {};
  (sysConf.results || []).forEach(r => { cfgMap[r.key] = r.value; });

  return c.json({
    success: true,
    data: {
      holdings: holdings.results || [],
      total_eval_profit: (holdings.results || []).reduce((s: number, h: Record<string, unknown>) => s + (h.eval_profit_loss as number || 0), 0),
      realized_profit: totalProfit?.total || 0,
      realized_count: totalProfit?.cnt || 0,
      recent_orders: recentOrders.results || [],
      auto_trade_enabled: cfgMap['auto_trade_enabled'] === '1',
      kr_trade_enabled:   cfgMap['kr_trade_enabled']   === '1',
      us_trade_enabled:   cfgMap['us_trade_enabled']   === '1',
      scan_kr_enabled:    cfgMap['scan_kr_enabled']    === '1',
      scan_us_enabled:    cfgMap['scan_us_enabled']    === '1',
      last_scan_at:       cfgMap['last_scan_at'] || null,
      kr_market_open:     isKRMarketOpen(),
      us_market_open:     isUSMarketOpen(),
    },
  });
});

// ─── 스캔 현황 (전체시장 스캔 대시보드용) ────────────────────
trading.get('/scan-status', async (c) => {
  try {
    const [stats, buySigs, sellSigs, cfgRows] = await Promise.all([
      getScanStats(c.env.DB),
      getSignalStocks(c.env.DB, 'BUY', 50),
      getSignalStocks(c.env.DB, 'SELL', 50),
      c.env.DB.prepare(
        `SELECT key, value FROM system_config WHERE key IN (
          'last_scan_at','scan_batch_size','scan_batch_offset_kr','scan_batch_offset_us',
          'kr_trade_enabled','us_trade_enabled','scan_kr_enabled','scan_us_enabled'
        )`
      ).all<{ key: string; value: string }>(),
    ]);

    const cfgMap: Record<string, string> = {};
    (cfgRows.results || []).forEach(r => { cfgMap[r.key] = r.value; });

    const universeStats = getUniverseStats();
    const batchSize = parseInt(cfgMap['scan_batch_size'] || '20');
    const krOffset  = parseInt(cfgMap['scan_batch_offset_kr'] || '0');
    const usOffset  = parseInt(cfgMap['scan_batch_offset_us'] || '0');

    // 다음 스캔 예정 시각 (다음 분)
    const now = new Date();
    const nextScan = new Date(now);
    nextScan.setSeconds(0, 0);
    nextScan.setMinutes(nextScan.getMinutes() + 1);

    return c.json({
      success: true,
      data: {
        // 전체 종목 수
        universe: universeStats,
        // 스캔 통계
        scan: {
          ...stats,
          batch_size: batchSize,
          kr_offset: krOffset,
          us_offset: usOffset,
          kr_market_open: isKRMarketOpen(),
          us_market_open: isUSMarketOpen(),
          last_scan_at: cfgMap['last_scan_at'] || null,
          next_scan_at: nextScan.toISOString(),
        },
        // 신호 종목
        buy_signal_stocks: buySigs,
        sell_signal_stocks: sellSigs,
        // 설정
        config: {
          kr_enabled: cfgMap['kr_trade_enabled'] === '1',
          us_enabled: cfgMap['us_trade_enabled'] === '1',
          scan_kr: cfgMap['scan_kr_enabled'] === '1',
          scan_us: cfgMap['scan_us_enabled'] === '1',
        },
        // 스캔 함수 정보 (실제 구현 확인용)
        scan_function: {
          name: 'runTradeScan',
          module: 'src/lib/trade-engine.ts',
          strategy: '15분봉 BB(20,2) 종가',
          buy_condition: 'prev.close < prev.lower AND current.close > current.lower',
          sell_condition: 'above_upper=true AND current.close < current.upper',
          batch_size: batchSize,
          markets: ['KOSPI', 'KOSDAQ', 'NASD', 'NYSE', 'AMEX'],
          kr_scan_tickers: universeStats.kr_total,
          us_scan_tickers: universeStats.us_total,
          total_scan_tickers: universeStats.total,
        },
      },
    });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// ─── 종목 유니버스 로드/조회 ─────────────────────────────────
trading.post('/universe/load', async (c) => {
  try {
    const result = await loadUniverseToDB(c.env.DB);
    return c.json({ success: true, message: `종목 유니버스 로드 완료`, ...result });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

trading.get('/universe/stats', async (c) => {
  const stats = getUniverseStats();
  const dbRow = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM stock_universe WHERE is_active=1').first<{cnt:number}>();
  return c.json({ success: true, data: { ...stats, db_count: dbRow?.cnt || 0 } });
});

trading.get('/universe/list', async (c) => {
  const exchange = c.req.query('exchange');
  const market   = c.req.query('market');
  const signal   = c.req.query('signal');
  const limit    = parseInt(c.req.query('limit') || '100');
  const offset   = parseInt(c.req.query('offset') || '0');

  let q = 'SELECT * FROM stock_universe WHERE is_active=1';
  const params: unknown[] = [];
  if (exchange) { q += ' AND exchange=?'; params.push(exchange); }
  if (market)   { q += ' AND market=?';   params.push(market); }
  if (signal)   { q += ' AND last_signal=?'; params.push(signal); }
  q += ' ORDER BY exchange, ticker LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows  = await c.env.DB.prepare(q).bind(...params).all();
  const total = await c.env.DB.prepare(
    q.replace('SELECT *', 'SELECT COUNT(*) as cnt').replace(/ORDER BY.*/, '')
  ).bind(...params.slice(0, -2)).first<{cnt:number}>();
  return c.json({ success: true, data: rows.results || [], total: total?.cnt || 0 });
});

// ─── 주문 내역 ────────────────────────────────────────────────
trading.get('/orders', async (c) => {
  const limit  = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const market = c.req.query('market');
  const ticker = c.req.query('ticker');

  let q = 'SELECT * FROM orders'; const cond: string[] = []; const params: unknown[] = [];
  if (market) { cond.push('market = ?'); params.push(market); }
  if (ticker) { cond.push('ticker = ?'); params.push(ticker); }
  if (cond.length) q += ' WHERE ' + cond.join(' AND ');
  q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows  = await c.env.DB.prepare(q).bind(...params).all();
  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM orders ${cond.length ? 'WHERE '+cond.join(' AND ') : ''}`
  ).bind(...params.slice(0, -2)).first<{ cnt: number }>();
  return c.json({ success: true, data: rows.results || [], total: total?.cnt || 0 });
});

// ─── 매매 로그 ────────────────────────────────────────────────
trading.get('/logs', async (c) => {
  const limit  = parseInt(c.req.query('limit') || '200');
  const market = c.req.query('market');
  const ticker = c.req.query('ticker');
  const action = c.req.query('action');

  let q = 'SELECT * FROM trade_logs'; const cond: string[] = []; const params: unknown[] = [];
  if (market) { cond.push('market = ?'); params.push(market); }
  if (ticker) { cond.push('ticker = ?'); params.push(ticker); }
  if (action) { cond.push('action = ?'); params.push(action); }
  if (cond.length) q += ' WHERE ' + cond.join(' AND ');
  q += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  const rows = await c.env.DB.prepare(q).bind(...params).all();
  return c.json({ success: true, data: rows.results || [] });
});

// ─── 실현 손익 ────────────────────────────────────────────────
trading.get('/profits', async (c) => {
  const limit  = parseInt(c.req.query('limit') || '50');
  const market = c.req.query('market');
  const rows   = await c.env.DB.prepare(
    `SELECT * FROM realized_profits ${market ? 'WHERE market=?' : ''} ORDER BY created_at DESC LIMIT ?`
  ).bind(...(market ? [market, limit] : [limit])).all();

  const summary = await c.env.DB.prepare(
    'SELECT SUM(profit_loss) as total, COUNT(*) as cnt, AVG(return_rate) as avg_rate FROM realized_profits'
  ).first<{ total: number; cnt: number; avg_rate: number }>();

  return c.json({
    success: true, data: rows.results || [],
    summary: { total_profit: summary?.total||0, count: summary?.cnt||0, avg_return_rate: summary?.avg_rate||0 },
  });
});

// ─── 보유 종목 ────────────────────────────────────────────────
trading.get('/holdings', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM holdings ORDER BY eval_profit_loss DESC').all();
  return c.json({ success: true, data: rows.results || [] });
});

// ─── 자동매매 ON/OFF ─────────────────────────────────────────
trading.post('/toggle', async (c) => {
  const body = await c.req.json() as {
    enabled?: boolean; kr?: boolean; us?: boolean;
    scan_kr?: boolean; scan_us?: boolean; batch_size?: number;
  };
  const batch: Promise<unknown>[] = [];
  if (body.enabled    !== undefined) batch.push(c.env.DB.prepare("UPDATE system_config SET value=? WHERE key='auto_trade_enabled'").bind(body.enabled?'1':'0').run());
  if (body.kr         !== undefined) batch.push(c.env.DB.prepare("UPDATE system_config SET value=? WHERE key='kr_trade_enabled'").bind(body.kr?'1':'0').run());
  if (body.us         !== undefined) batch.push(c.env.DB.prepare("UPDATE system_config SET value=? WHERE key='us_trade_enabled'").bind(body.us?'1':'0').run());
  if (body.scan_kr    !== undefined) batch.push(c.env.DB.prepare("UPDATE system_config SET value=? WHERE key='scan_kr_enabled'").bind(body.scan_kr?'1':'0').run());
  if (body.scan_us    !== undefined) batch.push(c.env.DB.prepare("UPDATE system_config SET value=? WHERE key='scan_us_enabled'").bind(body.scan_us?'1':'0').run());
  if (body.batch_size !== undefined) batch.push(c.env.DB.prepare("UPDATE system_config SET value=? WHERE key='scan_batch_size'").bind(String(body.batch_size)).run());
  await Promise.all(batch);
  return c.json({ success: true, message: '설정 업데이트 완료' });
});

// ─── 수동 스캔 ────────────────────────────────────────────────
trading.post('/scan', async (c) => {
  const result = await runTradeScan({
    DB: c.env.DB, KV: c.env.KV,
    KIS_APP_KEY: c.env.KIS_APP_KEY, KIS_APP_SECRET: c.env.KIS_APP_SECRET,
    KIS_ACCOUNT_NO: c.env.KIS_ACCOUNT_NO, KIS_ACCOUNT_SUFFIX: c.env.KIS_ACCOUNT_SUFFIX,
  });
  return c.json({ success: true, ...result });
});

// ─── 보유 종목 KIS 동기화 ────────────────────────────────────
trading.post('/sync-holdings', async (c) => {
  if (!c.env.KIS_APP_KEY) return c.json({ success: false, message: 'API 키 미설정' }, 400);
  try {
    const cfg = {
      appKey: c.env.KIS_APP_KEY, appSecret: c.env.KIS_APP_SECRET,
      accountNo: c.env.KIS_ACCOUNT_NO, accountSuffix: c.env.KIS_ACCOUNT_SUFFIX || '01',
    };
    const token = await getAccessToken(cfg, c.env.KV);
    const [krH, usH] = await Promise.all([
      getKRHoldings(cfg, token).catch(() => []),
      getUSHoldings(cfg, token).catch(() => []),
    ]);
    const all = [...krH, ...usH];
    await syncHoldings(c.env.DB, all);
    return c.json({ success: true, message: `${all.length}개 종목 동기화 완료`, data: all });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// ─── 잔고 조회 (국내+해외 동일 계좌) ──────────────────────────
trading.get('/balance', async (c) => {
  if (!c.env.KIS_APP_KEY) return c.json({ success: false, message: 'API 키 미설정' }, 400);
  try {
    const cfg = {
      appKey: c.env.KIS_APP_KEY, appSecret: c.env.KIS_APP_SECRET,
      accountNo: c.env.KIS_ACCOUNT_NO, accountSuffix: c.env.KIS_ACCOUNT_SUFFIX || '01',
    };
    const token = await getAccessToken(cfg, c.env.KV);
    const [kr, us] = await Promise.all([
      getKROrderableCash(cfg, token).catch(() => 0),
      getUSOrderableCash(cfg, token).catch(() => 0),
    ]);
    return c.json({
      success: true,
      data: {
        account_no: c.env.KIS_ACCOUNT_NO,
        cash_kr: kr, cash_kr_formatted: kr.toLocaleString('ko-KR') + '원',
        cash_us: us, cash_us_formatted: '$' + us.toFixed(2),
      },
    });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// ─── BB 신호 미리보기 ────────────────────────────────────────
trading.get('/preview/:market/:ticker', async (c) => {
  const market   = c.req.param('market').toUpperCase() as 'KR' | 'US';
  const ticker   = c.req.param('ticker').toUpperCase();
  const exchange = (c.req.query('exchange') || (market === 'US' ? 'NASD' : '')).toUpperCase() as ExchangeCode;
  if (!c.env.KIS_APP_KEY) return c.json({ success: false, message: 'API 키 미설정' }, 400);

  try {
    const cfg = {
      appKey: c.env.KIS_APP_KEY, appSecret: c.env.KIS_APP_SECRET,
      accountNo: c.env.KIS_ACCOUNT_NO, accountSuffix: c.env.KIS_ACCOUNT_SUFFIX || '01',
    };
    const token   = await getAccessToken(cfg, c.env.KV);
    const candles = market === 'KR'
      ? await getKR15MinCandles(cfg, token, ticker, 40)
      : await getUS15MinCandles(cfg, token, ticker, 40, exchange || 'NASD');

    const closes = candles.map(c => c.close);
    const dts    = candles.map(c => c.datetime);
    const bands  = calcBB(closes, dts);

    const holdRow = await c.env.DB.prepare(
      'SELECT qty, above_upper FROM holdings WHERE ticker = ?'
    ).bind(ticker).first<{ qty: number; above_upper: number }>();
    const hasPos     = !!holdRow && holdRow.qty > 0;
    const aboveUpper = hasPos && holdRow!.above_upper === 1;

    const signal = getBBSignal(bands, hasPos, aboveUpper);
    return c.json({
      success: true, ticker, market, exchange,
      signal: signal.action, reason: signal.reason,
      current_band: signal.current, prev_band: signal.prev,
      above_upper: signal.above_upper, has_position: hasPos,
      recent_bands: bands.slice(-5),
      candle_count: candles.length,
    });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// ─── 백테스트 ────────────────────────────────────────────────
trading.post('/backtest', async (c) => {
  const body = await c.req.json() as {
    ticker: string; ticker_name?: string; market?: 'KR' | 'US';
    exchange?: string; buy_amount?: number; days?: number;
  };
  if (!body.ticker) return c.json({ success: false, message: 'ticker 필수' }, 400);
  if (!c.env.KIS_APP_KEY) return c.json({ success: false, message: 'API 키 미설정' }, 400);

  try {
    const result = await runKISBacktest(
      {
        KIS_APP_KEY: c.env.KIS_APP_KEY, KIS_APP_SECRET: c.env.KIS_APP_SECRET,
        KIS_ACCOUNT_NO: c.env.KIS_ACCOUNT_NO, KIS_ACCOUNT_SUFFIX: c.env.KIS_ACCOUNT_SUFFIX,
        KV: c.env.KV,
      },
      {
        ticker:      body.ticker.toUpperCase(),
        ticker_name: body.ticker_name || body.ticker,
        market:      body.market === 'US' ? 'US' : 'KR',
        buy_amount:  body.buy_amount || 100000,
        days:        body.days || 7,
      }
    );

    await c.env.DB.prepare(
      `INSERT INTO backtest_results
         (ticker, ticker_name, market, start_date, end_date,
          total_trades, win_trades, loss_trades, total_profit,
          win_rate, avg_return, max_drawdown, params, trades_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      result.ticker, result.ticker_name, result.market,
      result.trades[0]?.buy_datetime?.slice(0,8) || '',
      result.trades.at(-1)?.sell_datetime?.slice(0,8) || '',
      result.total_trades, result.win_trades, result.loss_trades,
      result.total_profit, result.win_rate, result.avg_return,
      result.max_drawdown,
      JSON.stringify({ period: 20, stddev: 2 }),
      JSON.stringify(result.trades),
    ).run();

    return c.json({ success: true, data: result });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// ─── 백테스트 이력 조회 ──────────────────────────────────────
trading.get('/backtest/history', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id,ticker,ticker_name,market,start_date,end_date,total_trades,win_trades,loss_trades,total_profit,win_rate,avg_return,max_drawdown,created_at FROM backtest_results ORDER BY created_at DESC LIMIT 50'
  ).all();
  return c.json({ success: true, data: rows.results || [] });
});

export default trading;
