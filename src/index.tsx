import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import watchlistRoute from './routes/watchlist'
import tradingRoute from './routes/trading'
import testRoute from './routes/api-test'
import { runTradeScan } from './lib/trade-engine'

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  KIS_APP_KEY: string;
  KIS_APP_SECRET: string;
  KIS_ACCOUNT_NO: string;
  KIS_ACCOUNT_SUFFIX: string;
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', logger())
app.use('/api/*', cors())

// API 라우트
app.route('/api/watchlist', watchlistRoute)
app.route('/api/trading', tradingRoute)
app.route('/api/test', testRoute)

// 시스템 설정 조회
app.get('/api/config', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT key, value, description FROM system_config'
  ).all()
  return c.json({ success: true, data: rows.results || [] })
})

// 시스템 설정 수정
app.put('/api/config/:key', async (c) => {
  const key = c.req.param('key')
  const body = await c.req.json() as { value: string }
  await c.env.DB.prepare(
    'UPDATE system_config SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?'
  ).bind(body.value, key).run()
  return c.json({ success: true, message: '설정 업데이트 완료' })
})

// Cron Trigger - 자동매매 스캔 (매분)
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(
      runTradeScan({
        DB: env.DB,
        KV: env.KV,
        KIS_APP_KEY: env.KIS_APP_KEY,
        KIS_APP_SECRET: env.KIS_APP_SECRET,
        KIS_ACCOUNT_NO: env.KIS_ACCOUNT_NO,
        KIS_ACCOUNT_SUFFIX: env.KIS_ACCOUNT_SUFFIX,
      })
    )
  },
}
