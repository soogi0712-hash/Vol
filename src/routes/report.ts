/**
 * AI 전략 리포트 라우터 v5
 * ─────────────────────────────────────────────
 * GET  /api/report/daily           — 오늘(또는 특정 날짜) 일일 리포트
 * GET  /api/report/daily/list      — 일일 리포트 목록 (최근 N일)
 * GET  /api/report/conditions      — 조건 미충족 집계
 * GET  /api/report/performance     — 7/30/90일 성능 지표
 * GET  /api/report/suggestions     — AI 개선 제안 목록
 * GET  /api/report/compare         — 전략 비교 시뮬레이션
 * POST /api/report/generate        — 리포트 수동 생성 (즉시 실행)
 */

import { Hono } from 'hono';
import {
  generateDailyReport,
  analyzeConditions,
  calcStrategyPerformance,
  generateSuggestions,
  compareStrategies,
  runFullDailyReport,
  getKSTDateStr,
} from '../lib/report-engine';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
};

const report = new Hono<{ Bindings: Bindings }>();

// ── GET /daily ────────────────────────────────────────────────
// 쿼리: ?date=YYYY-MM-DD (생략 시 오늘 KST)
report.get('/daily', async (c) => {
  const date = c.req.query('date') ?? getKSTDateStr();

  try {
    // DB에 저장된 리포트 먼저 조회
    const cached = await c.env.DB.prepare(
      'SELECT * FROM daily_reports WHERE report_date = ?'
    ).bind(date).first<Record<string, unknown>>();

    if (cached) {
      return c.json({ success: true, data: cached, source: 'cache' });
    }

    // 없으면 오늘 날짜만 실시간 생성 (과거는 데이터 없음 처리)
    const today = getKSTDateStr();
    if (date !== today) {
      return c.json({ success: true, data: null, message: `${date} 리포트가 존재하지 않습니다.` });
    }

    const report = await generateDailyReport(c.env.DB, date);
    return c.json({ success: true, data: report, source: 'generated' });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ success: false, error: msg }, 500);
  }
});

// ── GET /daily/list ───────────────────────────────────────────
// 쿼리: ?limit=30 (기본 30일)
report.get('/daily/list', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '30'), 90);

  try {
    const rows = await c.env.DB.prepare(`
      SELECT * FROM daily_reports
      ORDER BY report_date DESC
      LIMIT ?
    `).bind(limit).all();

    return c.json({ success: true, data: rows.results ?? [], count: (rows.results ?? []).length });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ success: false, error: msg }, 500);
  }
});

// ── GET /conditions ───────────────────────────────────────────
// 쿼리: ?date=YYYY-MM-DD&market=ALL|KR|US&days=7
report.get('/conditions', async (c) => {
  const date   = c.req.query('date') ?? getKSTDateStr();
  const market = (c.req.query('market') ?? 'ALL') as 'KR' | 'US' | 'ALL';
  const days   = parseInt(c.req.query('days') ?? '1');

  try {
    if (days <= 1) {
      // 단일 날짜 — DB 캐시 우선
      const cached = await c.env.DB.prepare(
        `SELECT * FROM condition_stats WHERE stat_date = ? AND market = ?`
      ).bind(date, market).first<Record<string, unknown>>();

      if (cached) {
        return c.json({ success: true, data: cached, source: 'cache' });
      }

      // 실시간 분석
      const stats = await analyzeConditions(c.env.DB, date, market);
      return c.json({ success: true, data: stats, source: 'generated' });
    }

    // 다중 날짜 — 최근 N일 집계
    const rows = await c.env.DB.prepare(`
      SELECT * FROM condition_stats
      WHERE stat_date >= date('now', ? || ' days', '+9 hours')
        AND market = ?
      ORDER BY stat_date DESC
    `).bind(`-${days}`, market).all();

    // 집계 합산
    const list = rows.results ?? [];
    if (list.length === 0) {
      return c.json({ success: true, data: [], aggregate: null });
    }

    const agg = list.reduce((acc: Record<string, number>, row: Record<string, unknown>) => {
      const keys = [
        'fail_no_lower_breach','fail_no_lower_recovery','fail_rsi_threshold',
        'fail_rsi_not_rising','fail_outside_hours','fail_no_data','fail_api_error',
        'total_scanned','total_no_signal',
      ];
      for (const k of keys) {
        acc[k] = (acc[k] ?? 0) + ((row[k] as number) ?? 0);
      }
      return acc;
    }, {} as Record<string, number>);

    return c.json({ success: true, data: list, aggregate: agg, days });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ success: false, error: msg }, 500);
  }
});

// ── GET /performance ──────────────────────────────────────────
// 쿼리: ?period=7|30|90 (복수 가능: ?period=7&period=30&period=90)
report.get('/performance', async (c) => {
  const periodParam = c.req.queries('period') ?? ['7', '30', '90'];
  const periods = periodParam.map(p => parseInt(p)).filter(p => [7, 30, 90].includes(p)) as (7|30|90)[];

  if (periods.length === 0) {
    return c.json({ success: false, error: 'period는 7, 30, 90 중 하나' }, 400);
  }

  try {
    const today = getKSTDateStr();
    const results = await Promise.all(periods.map(async (p) => {
      // DB 캐시 확인 (오늘 생성된 것)
      const cached = await c.env.DB.prepare(`
        SELECT * FROM strategy_perf_cache
        WHERE period_days = ? AND strategy_key = 'BB_RSI35'
          AND cache_date = ?
      `).bind(p, today).first<Record<string, unknown>>();

      if (cached) return { ...cached, source: 'cache' };

      // 실시간 계산
      const perf = await calcStrategyPerformance(c.env.DB, p);
      return { ...perf, source: 'calculated' };
    }));

    return c.json({ success: true, data: results });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ success: false, error: msg }, 500);
  }
});

// ── GET /suggestions ──────────────────────────────────────────
// 쿼리: ?date=YYYY-MM-DD&regenerate=1
report.get('/suggestions', async (c) => {
  const date       = c.req.query('date') ?? getKSTDateStr();
  const regenerate = c.req.query('regenerate') === '1';

  try {
    if (!regenerate) {
      // DB 캐시 먼저
      const cached = await c.env.DB.prepare(
        `SELECT * FROM ai_suggestions WHERE suggestion_date = ? ORDER BY priority DESC, id ASC`
      ).bind(date).all();

      if ((cached.results ?? []).length > 0) {
        return c.json({ success: true, data: cached.results, source: 'cache' });
      }
    }

    // 실시간 생성
    const suggestions = await generateSuggestions(c.env.DB, date);
    return c.json({ success: true, data: suggestions, source: 'generated' });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ success: false, error: msg }, 500);
  }
});

// ── GET /compare ──────────────────────────────────────────────
// 쿼리: ?period=30 (7|30|90)
report.get('/compare', async (c) => {
  const period = parseInt(c.req.query('period') ?? '30') as 7 | 30 | 90;
  if (![7, 30, 90].includes(period)) {
    return c.json({ success: false, error: 'period는 7, 30, 90 중 하나' }, 400);
  }

  try {
    const today = getKSTDateStr();

    // 캐시 확인 (오늘 생성된 4개 전략 비교)
    const strategies = ['BB_RSI35', 'BB_RSI40', 'BB_ONLY', 'BB_RSI30'];
    const cached = await c.env.DB.prepare(`
      SELECT * FROM strategy_perf_cache
      WHERE period_days = ? AND cache_date = ?
        AND strategy_key IN ('BB_RSI35','BB_RSI40','BB_ONLY','BB_RSI30')
      ORDER BY ev DESC
    `).bind(period, today).all();

    if ((cached.results ?? []).length === 4) {
      return c.json({
        success: true,
        data: cached.results,
        period,
        source: 'cache',
      });
    }

    // 실시간 비교
    const results = await compareStrategies(c.env.DB, period);
    return c.json({ success: true, data: results, period, source: 'generated' });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ success: false, error: msg }, 500);
  }
});

// ── POST /generate ────────────────────────────────────────────
// 오늘 전체 리포트 수동 생성 (즉시 실행)
report.post('/generate', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as { date?: string; full?: boolean };
    const date = body.date ?? getKSTDateStr();

    if (body.full) {
      // 전체 리포트 (daily + conditions + performance + suggestions)
      const result = await runFullDailyReport(c.env.DB);
      return c.json({ success: true, data: result, generated_at: new Date().toISOString() });
    }

    // 일일 리포트만
    const daily = await generateDailyReport(c.env.DB, date);
    return c.json({ success: true, data: daily, generated_at: new Date().toISOString() });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ success: false, error: msg }, 500);
  }
});

// ── GET /summary ──────────────────────────────────────────────
// 대시보드용 요약 (오늘 + 7일 성능 + 최근 제안 1건)
report.get('/summary', async (c) => {
  try {
    const today = getKSTDateStr();

    const [dailyRow, perfRow, sugRow] = await Promise.all([
      c.env.DB.prepare(
        'SELECT * FROM daily_reports WHERE report_date = ? LIMIT 1'
      ).bind(today).first<Record<string, unknown>>(),

      c.env.DB.prepare(`
        SELECT * FROM strategy_perf_cache
        WHERE period_days = 7 AND strategy_key = 'BB_RSI35'
        ORDER BY generated_at DESC LIMIT 1
      `).first<Record<string, unknown>>(),

      c.env.DB.prepare(`
        SELECT * FROM ai_suggestions
        WHERE priority IN ('HIGH','MEDIUM')
        ORDER BY suggestion_date DESC, id DESC LIMIT 3
      `).all(),
    ]);

    return c.json({
      success: true,
      data: {
        today: dailyRow ?? null,
        perf_7d: perfRow ?? null,
        top_suggestions: sugRow.results ?? [],
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ success: false, error: msg }, 500);
  }
});

export default report;
