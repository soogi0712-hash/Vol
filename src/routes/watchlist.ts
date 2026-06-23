// API 라우트 - 감시 종목 관리
import { Hono } from 'hono';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  KIS_APP_KEY: string;
  KIS_APP_SECRET: string;
  KIS_ACCOUNT_NO: string;
  KIS_ACCOUNT_SUFFIX: string;
};

const watchlist = new Hono<{ Bindings: Bindings }>();

// 감시 종목 목록 조회
watchlist.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM watch_list ORDER BY created_at DESC'
  ).all();
  return c.json({ success: true, data: rows.results });
});

// 감시 종목 추가
watchlist.post('/', async (c) => {
  const body = await c.req.json() as {
    ticker: string;
    ticker_name: string;
    bb_period?: number;
    bb_stddev?: number;
    buy_qty?: number;
  };

  if (!body.ticker || !body.ticker_name) {
    return c.json({ success: false, message: '종목코드와 종목명은 필수입니다.' }, 400);
  }

  const ticker = body.ticker.trim().padStart(6, '0');

  try {
    await c.env.DB.prepare(
      `INSERT INTO watch_list (ticker, ticker_name, bb_period, bb_stddev, buy_qty)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        ticker,
        body.ticker_name.trim(),
        body.bb_period || 20,
        body.bb_stddev || 2.0,
        body.buy_qty || 1
      )
      .run();

    return c.json({ success: true, message: `${body.ticker_name} 추가 완료` });
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      return c.json({ success: false, message: '이미 등록된 종목입니다.' }, 400);
    }
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 감시 종목 수정
watchlist.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as {
    is_active?: number;
    bb_period?: number;
    bb_stddev?: number;
    buy_qty?: number;
    ticker_name?: string;
  };

  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.is_active !== undefined) { fields.push('is_active = ?'); values.push(body.is_active); }
  if (body.bb_period !== undefined) { fields.push('bb_period = ?'); values.push(body.bb_period); }
  if (body.bb_stddev !== undefined) { fields.push('bb_stddev = ?'); values.push(body.bb_stddev); }
  if (body.buy_qty !== undefined) { fields.push('buy_qty = ?'); values.push(body.buy_qty); }
  if (body.ticker_name !== undefined) { fields.push('ticker_name = ?'); values.push(body.ticker_name); }

  if (fields.length === 0) {
    return c.json({ success: false, message: '수정할 항목이 없습니다.' }, 400);
  }

  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);

  await c.env.DB.prepare(
    `UPDATE watch_list SET ${fields.join(', ')} WHERE id = ?`
  )
    .bind(...values)
    .run();

  return c.json({ success: true, message: '수정 완료' });
});

// 감시 종목 삭제
watchlist.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM watch_list WHERE id = ?').bind(id).run();
  return c.json({ success: true, message: '삭제 완료' });
});

export default watchlist;
