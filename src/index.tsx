import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import watchlistRoute from './routes/watchlist'
import tradingRoute from './routes/trading'
import testRoute from './routes/api-test'
import reportRoute from './routes/report'
import indicatorsRoute from './routes/indicators'
import diagRoute from './routes/diag'
import { runTradeScan, isKRMarketOpen } from './lib/trade-engine'
import { runFullDailyReport, getKSTDateStr } from './lib/report-engine'

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
app.route('/api/report', reportRoute)
app.route('/api/indicators', indicatorsRoute)
app.route('/api/diag', diagRoute)

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

// Cron Trigger - 자동매매 스캔 (매분) + 일일 리포트 자동 생성
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    // ① 매매 스캔 (매분 실행)
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

    // ② 일일 리포트 자동 생성 — KST 15:35 (UTC 06:35) 전후 1분 구간에서 실행
    // Cron "* 0-6 * * 1-5" → UTC 06:35 = KST 15:35 (장마감 5분 후)
    ctx.waitUntil(
      (async () => {
        try {
          const now = new Date();
          const utcH = now.getUTCHours();
          const utcM = now.getUTCMinutes();
          // UTC 06:35 ~ 06:36 구간 (KST 15:35 ~ 15:36)
          if (utcH === 6 && utcM === 35) {
            // 오늘 이미 생성됐는지 확인
            const today = getKSTDateStr();
            const lastGen = await env.DB.prepare(
              `SELECT value FROM system_config WHERE key = 'report_last_generated'`
            ).first<{ value: string }>();
            if (lastGen?.value !== today) {
              await runFullDailyReport(env.DB);
              console.log(`[Report] 일일 리포트 자동 생성 완료: ${today}`);
            }
          }
        } catch (e) {
          console.error('[Report] 일일 리포트 자동 생성 오류:', e);
        }
      })()
    )
  },
}
