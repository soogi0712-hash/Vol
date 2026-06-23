// 감시 종목 관리 라우트 v2
import { Hono } from 'hono';

type Bindings = {
  DB: D1Database; KV: KVNamespace;
  KIS_APP_KEY: string; KIS_APP_SECRET: string;
  KIS_ACCOUNT_NO: string; KIS_ACCOUNT_SUFFIX: string;
};

const watchlist = new Hono<{ Bindings: Bindings }>();

// 목록 조회
watchlist.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM watch_list ORDER BY market, created_at DESC'
  ).all();
  return c.json({ success: true, data: rows.results });
});

// 추가
watchlist.post('/', async (c) => {
  const body = await c.req.json() as {
    ticker: string; ticker_name: string;
    market?: 'KR' | 'US'; buy_amount?: number;
  };
  if (!body.ticker || !body.ticker_name)
    return c.json({ success: false, message: '종목코드·종목명 필수' }, 400);

  const ticker = body.ticker.trim().toUpperCase();
  const market = body.market === 'US' ? 'US' : 'KR';

  try {
    await c.env.DB.prepare(
      'INSERT INTO watch_list (ticker, ticker_name, market, buy_amount) VALUES (?,?,?,?)'
    ).bind(ticker, body.ticker_name.trim(), market, body.buy_amount || 100000).run();
    return c.json({ success: true, message: `${body.ticker_name} 추가 완료` });
  } catch (e) {
    if (String(e).includes('UNIQUE'))
      return c.json({ success: false, message: '이미 등록된 종목' }, 400);
    return c.json({ success: false, message: String(e) }, 500);
  }
});

// 수정
watchlist.put('/:id', async (c) => {
  const id   = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const allowed = ['is_active','buy_amount','ticker_name','market'];
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const k of allowed) {
    if (body[k] !== undefined) { fields.push(`${k} = ?`); values.push(body[k]); }
  }
  if (!fields.length) return c.json({ success: false, message: '수정 항목 없음' }, 400);
  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);
  await c.env.DB.prepare(`UPDATE watch_list SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  return c.json({ success: true, message: '수정 완료' });
});

// 삭제
watchlist.delete('/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM watch_list WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ success: true, message: '삭제 완료' });
});

export default watchlist;
