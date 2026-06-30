/**
 * AI 전략 리포트 엔진 v5
 * ─────────────────────────────────────────────────────────────
 * 원칙: AI는 분석/통계/비교/제안만 수행.
 *       전략 변경은 사용자 승인 후에만. 임의 추천 금지.
 *
 * 제공 기능:
 *   1. generateDailyReport()     — 일일 리포트 자동 생성
 *   2. analyzeConditions()       — 조건별 미충족 집계
 *   3. calcStrategyPerformance() — 7/30/90일 성능 지표
 *   4. generateSuggestions()     — 데이터 기반 개선 제안
 *   5. compareStrategies()       — 전략 시뮬레이션 비교
 * ─────────────────────────────────────────────────────────────
 */

import { calcBB, calcRSI, runBacktest } from './bollinger';

// ─── 공통 타입 ───────────────────────────────────────────────

export interface DailyReport {
  report_date:       string;   // YYYY-MM-DD
  total_scanned:     number;
  normal_scanned:    number;
  no_data_count:     number;
  api_error_count:   number;
  buy_signal_count:  number;
  sell_signal_count: number;
  actual_buy_count:  number;
  actual_sell_count: number;
  order_fail_count:  number;
  order_fail_reasons: string;  // JSON array
  realized_pnl:      number;
  eval_pnl:          number;
  win_rate:          number;
  avg_profit_rate:   number;
  avg_loss_rate:     number;
  avg_hold_hours:    number;
  max_profit_ticker: string;
  max_profit_name:   string;
  max_profit_rate:   number;
  max_loss_ticker:   string;
  max_loss_name:     string;
  max_loss_rate:     number;
  generated_at:      string;
}

export interface ConditionStats {
  stat_date:              string;
  market:                 string;
  fail_no_lower_breach:   number;  // ① 하단선 이탈 미충족
  fail_no_lower_recovery: number;  // ② 하단선 복귀 미충족
  fail_rsi_threshold:     number;  // ③ RSI > 35
  fail_rsi_not_rising:    number;  // ④ RSI 하락
  fail_outside_hours:     number;  // 장외시간
  fail_no_data:           number;  // NO_DATA
  fail_api_error:         number;  // API_ERROR
  total_scanned:          number;
  total_no_signal:        number;
}

export interface StrategyPerf {
  period_days:     number;
  strategy_key:    string;
  total_trades:    number;
  win_trades:      number;
  loss_trades:     number;
  win_rate:        number;
  avg_profit_rate: number;
  avg_loss_rate:   number;
  total_profit:    number;
  total_loss:      number;
  ev:              number;   // 기대수익 = win_rate*avg_profit + (1-win_rate)*avg_loss
  profit_factor:   number;   // |총수익| / |총손실|
  mdd:             number;   // 최대 낙폭 (원)
  avg_hold_hours:  number;
}

export interface AISuggestion {
  category:    string;   // RSI_THRESHOLD | CONDITION_BLOCK | PERFORMANCE | STRATEGY
  priority:    string;   // HIGH | MEDIUM | LOW | INFO
  title:       string;
  description: string;
  data_basis:  Record<string, unknown>;
}

export interface StrategyCompareResult {
  strategy_key:    string;
  strategy_label:  string;
  rsi_threshold:   number | null;
  use_rsi_rising:  boolean;
  total_trades:    number;
  win_rate:        number;
  ev:              number;
  total_profit:    number;
  profit_factor:   number;
}

// ─── KST 날짜 헬퍼 ──────────────────────────────────────────

export function getKSTDateStr(date?: Date): string {
  const d = date ?? new Date();
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10); // YYYY-MM-DD
}

function getKSTDateRange(days: number): { from: string; to: string } {
  const now = new Date();
  const to   = getKSTDateStr(now);
  const from = getKSTDateStr(new Date(now.getTime() - days * 86400 * 1000));
  return { from, to };
}

/** realized_profits.created_at(UTC) → KST 날짜 문자열 비교용 offset */
function kstDateFilter(dateCol: string, fromDate: string, toDate: string): string {
  // SQLite: datetime 문자열에 +9시간 offset 적용
  return `datetime(${dateCol}, '+9 hours') BETWEEN '${fromDate}' AND '${toDate} 23:59:59'`;
}

// ─── 1. 일일 리포트 생성 ─────────────────────────────────────

/**
 * 오늘(KST) 기준 일일 리포트를 생성하여 DB에 저장
 * 한국장 종료 후(KST 15:30 이후) cron에서 자동 호출
 */
export async function generateDailyReport(db: D1Database, targetDate?: string): Promise<DailyReport> {
  const reportDate = targetDate ?? getKSTDateStr();

  // ── 스캔 통계 (trade_logs) ──────────────────────────────
  const scanStatsRow = await db.prepare(`
    SELECT
      COUNT(*) as total_scanned,
      SUM(CASE WHEN action = 'NO_DATA' THEN 1 ELSE 0 END) as no_data_count,
      SUM(CASE WHEN action LIKE 'ERROR%' OR action LIKE '%API_ERROR%' THEN 1 ELSE 0 END) as api_error_count,
      SUM(CASE WHEN action = 'BUY' THEN 1 ELSE 0 END) as buy_signal_count,
      SUM(CASE WHEN action = 'SELL' THEN 1 ELSE 0 END) as sell_signal_count
    FROM trade_logs
    WHERE ${kstDateFilter('created_at', reportDate, reportDate)}
  `).first<{
    total_scanned: number; no_data_count: number; api_error_count: number;
    buy_signal_count: number; sell_signal_count: number;
  }>();

  const totalScanned    = scanStatsRow?.total_scanned    ?? 0;
  const noDataCount     = scanStatsRow?.no_data_count    ?? 0;
  const apiErrorCount   = scanStatsRow?.api_error_count  ?? 0;
  const buySigCount     = scanStatsRow?.buy_signal_count ?? 0;
  const sellSigCount    = scanStatsRow?.sell_signal_count ?? 0;
  const normalScanned   = totalScanned - noDataCount - apiErrorCount;

  // ── 주문 통계 (orders) ────────────────────────────────────
  const orderStatsRow = await db.prepare(`
    SELECT
      SUM(CASE WHEN order_type = 'BUY'  AND status = 'FILLED' THEN 1 ELSE 0 END) as actual_buy,
      SUM(CASE WHEN order_type = 'SELL' AND status = 'FILLED' THEN 1 ELSE 0 END) as actual_sell,
      SUM(CASE WHEN status = 'FAILED' OR status = 'ERROR' THEN 1 ELSE 0 END) as fail_count
    FROM orders
    WHERE ${kstDateFilter('created_at', reportDate, reportDate)}
  `).first<{ actual_buy: number; actual_sell: number; fail_count: number }>();

  const actualBuyCount  = orderStatsRow?.actual_buy  ?? 0;
  const actualSellCount = orderStatsRow?.actual_sell ?? 0;
  const orderFailCount  = orderStatsRow?.fail_count  ?? 0;

  // 주문 실패 사유 수집
  const failReasonsRows = await db.prepare(`
    SELECT reason, COUNT(*) as cnt
    FROM orders
    WHERE status IN ('FAILED','ERROR')
      AND ${kstDateFilter('created_at', reportDate, reportDate)}
    GROUP BY reason
  `).all<{ reason: string; cnt: number }>();
  const orderFailReasons = JSON.stringify(
    (failReasonsRows.results ?? []).map(r => ({ reason: r.reason ?? '', count: r.cnt }))
  );

  // ── 실현손익 (realized_profits) ──────────────────────────
  const profitRows = await db.prepare(`
    SELECT
      ticker, ticker_name, buy_price, sell_price,
      profit_loss, return_rate, created_at
    FROM realized_profits
    WHERE ${kstDateFilter('created_at', reportDate, reportDate)}
    ORDER BY created_at ASC
  `).all<{
    ticker: string; ticker_name: string; buy_price: number;
    sell_price: number; profit_loss: number; return_rate: number;
    created_at: string;
  }>();

  const profits = profitRows.results ?? [];
  const realizedPnl  = profits.reduce((s, r) => s + r.profit_loss, 0);
  const winTrades    = profits.filter(r => r.profit_loss > 0);
  const lossTrades   = profits.filter(r => r.profit_loss <= 0);
  const winRate      = profits.length > 0 ? winTrades.length / profits.length * 100 : 0;
  const avgProfitRate = winTrades.length > 0
    ? winTrades.reduce((s, r) => s + r.return_rate, 0) / winTrades.length : 0;
  const avgLossRate   = lossTrades.length > 0
    ? lossTrades.reduce((s, r) => s + r.return_rate, 0) / lossTrades.length : 0;

  // 최대 수익/손실 종목
  let maxProfitTicker = '', maxProfitName = '', maxProfitRate = 0;
  let maxLossTicker = '', maxLossName = '', maxLossRate = 0;
  if (profits.length > 0) {
    const maxP = profits.reduce((a, b) => a.return_rate > b.return_rate ? a : b);
    const maxL = profits.reduce((a, b) => a.return_rate < b.return_rate ? a : b);
    maxProfitTicker = maxP.ticker;   maxProfitName = maxP.ticker_name;   maxProfitRate = maxP.return_rate;
    maxLossTicker   = maxL.ticker;   maxLossName   = maxL.ticker_name;   maxLossRate   = maxL.return_rate;
  }

  // 평균 보유기간 — holdings에 buy_datetime 없으므로 orders JOIN으로 추정
  // BUY/SELL 주문 페어로 보유시간 계산
  const holdRows = await db.prepare(`
    SELECT b.ticker,
           (julianday(s.created_at) - julianday(b.created_at)) * 24 as hold_hours
    FROM orders b
    JOIN orders s ON b.ticker = s.ticker
      AND s.order_type = 'SELL' AND s.status = 'FILLED'
      AND s.created_at > b.created_at
    WHERE b.order_type = 'BUY' AND b.status = 'FILLED'
      AND ${kstDateFilter('s.created_at', reportDate, reportDate)}
    GROUP BY b.ticker, b.created_at
  `).all<{ ticker: string; hold_hours: number }>();
  const holdRows2 = holdRows.results ?? [];
  const avgHoldHours = holdRows2.length > 0
    ? holdRows2.reduce((s, r) => s + r.hold_hours, 0) / holdRows2.length : 0;

  // ── 평가손익 (holdings 현재 상태) ────────────────────────
  const evalRow = await db.prepare(`
    SELECT COALESCE(SUM(eval_profit_loss), 0) as eval_pnl
    FROM holdings
  `).first<{ eval_pnl: number }>();
  const evalPnl = evalRow?.eval_pnl ?? 0;

  // ── DB 저장 ──────────────────────────────────────────────
  const report: DailyReport = {
    report_date:       reportDate,
    total_scanned:     totalScanned,
    normal_scanned:    Math.max(0, normalScanned),
    no_data_count:     noDataCount,
    api_error_count:   apiErrorCount,
    buy_signal_count:  buySigCount,
    sell_signal_count: sellSigCount,
    actual_buy_count:  actualBuyCount,
    actual_sell_count: actualSellCount,
    order_fail_count:  orderFailCount,
    order_fail_reasons: orderFailReasons,
    realized_pnl:      parseFloat(realizedPnl.toFixed(2)),
    eval_pnl:          parseFloat(evalPnl.toFixed(2)),
    win_rate:          parseFloat(winRate.toFixed(2)),
    avg_profit_rate:   parseFloat(avgProfitRate.toFixed(4)),
    avg_loss_rate:     parseFloat(avgLossRate.toFixed(4)),
    avg_hold_hours:    parseFloat(avgHoldHours.toFixed(2)),
    max_profit_ticker: maxProfitTicker,
    max_profit_name:   maxProfitName,
    max_profit_rate:   parseFloat(maxProfitRate.toFixed(4)),
    max_loss_ticker:   maxLossTicker,
    max_loss_name:     maxLossName,
    max_loss_rate:     parseFloat(maxLossRate.toFixed(4)),
    generated_at:      new Date().toISOString(),
  };

  await db.prepare(`
    INSERT OR REPLACE INTO daily_reports (
      report_date, total_scanned, normal_scanned, no_data_count, api_error_count,
      buy_signal_count, sell_signal_count, actual_buy_count, actual_sell_count,
      order_fail_count, order_fail_reasons, realized_pnl, eval_pnl,
      win_rate, avg_profit_rate, avg_loss_rate, avg_hold_hours,
      max_profit_ticker, max_profit_name, max_profit_rate,
      max_loss_ticker, max_loss_name, max_loss_rate,
      generated_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  `).bind(
    report.report_date, report.total_scanned, report.normal_scanned,
    report.no_data_count, report.api_error_count,
    report.buy_signal_count, report.sell_signal_count,
    report.actual_buy_count, report.actual_sell_count,
    report.order_fail_count, report.order_fail_reasons,
    report.realized_pnl, report.eval_pnl,
    report.win_rate, report.avg_profit_rate, report.avg_loss_rate, report.avg_hold_hours,
    report.max_profit_ticker, report.max_profit_name, report.max_profit_rate,
    report.max_loss_ticker, report.max_loss_name, report.max_loss_rate,
  ).run();

  // system_config 업데이트
  await db.prepare(
    `UPDATE system_config SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'report_last_generated'`
  ).bind(reportDate).run();

  return report;
}

// ─── 2. 조건 분석 ────────────────────────────────────────────

/**
 * 날짜별 NO_SIGNAL fail_reasons 집계
 * trade_logs.message에서 패턴 매칭으로 각 조건 미충족 횟수 카운트
 */
export async function analyzeConditions(
  db: D1Database,
  targetDate?: string,
  market: 'KR' | 'US' | 'ALL' = 'ALL'
): Promise<ConditionStats> {
  const statDate = targetDate ?? getKSTDateStr();

  // trade_logs에서 해당 날짜 NONE(NO_SIGNAL) 로그 조회
  const marketFilter = market === 'ALL' ? '' : `AND market = '${market}'`;
  const rows = await db.prepare(`
    SELECT action, message, market
    FROM trade_logs
    WHERE action = 'NONE'
      AND ${kstDateFilter('created_at', statDate, statDate)}
      ${marketFilter}
  `).all<{ action: string; message: string; market: string }>();

  const logs = rows.results ?? [];
  let failNoBreach = 0, failNoRecovery = 0, failRsiThreshold = 0;
  let failRsiNotRising = 0, failOutsideHours = 0, failNoData = 0, failApiError = 0;

  for (const log of logs) {
    const msg = (log.message ?? '').toLowerCase();
    // fail_reasons 패턴 매칭
    if (msg.includes('하단선 이탈 미충족') || msg.includes('직전봉') && msg.includes('≥')) failNoBreach++;
    if (msg.includes('하단선 복귀 미충족') || msg.includes('현재봉') && msg.includes('≤')) failNoRecovery++;
    if (msg.includes('rsi 조건 미충족') || msg.includes('rsi') && msg.includes('>')) failRsiThreshold++;
    if (msg.includes('rsi 하락') || msg.includes('rsi 상승') && msg.includes('미충족')) failRsiNotRising++;
    if (msg.includes('장외') || msg.includes('outside')) failOutsideHours++;
  }

  // NO_DATA, API_ERROR는 별도 action 타입
  const otherRows = await db.prepare(`
    SELECT action, COUNT(*) as cnt
    FROM trade_logs
    WHERE action IN ('NO_DATA', 'API_ERROR', 'ERROR')
      AND ${kstDateFilter('created_at', statDate, statDate)}
      ${marketFilter}
    GROUP BY action
  `).all<{ action: string; cnt: number }>();

  for (const r of (otherRows.results ?? [])) {
    if (r.action === 'NO_DATA')  failNoData   += r.cnt;
    if (r.action.includes('ERROR')) failApiError += r.cnt;
  }

  // 전체 스캔 수
  const totalRow = await db.prepare(`
    SELECT COUNT(*) as total, SUM(CASE WHEN action='NONE' THEN 1 ELSE 0 END) as no_signal
    FROM trade_logs
    WHERE ${kstDateFilter('created_at', statDate, statDate)}
      ${marketFilter}
  `).first<{ total: number; no_signal: number }>();

  const stats: ConditionStats = {
    stat_date:              statDate,
    market,
    fail_no_lower_breach:   failNoBreach,
    fail_no_lower_recovery: failNoRecovery,
    fail_rsi_threshold:     failRsiThreshold,
    fail_rsi_not_rising:    failRsiNotRising,
    fail_outside_hours:     failOutsideHours,
    fail_no_data:           failNoData,
    fail_api_error:         failApiError,
    total_scanned:          totalRow?.total     ?? 0,
    total_no_signal:        totalRow?.no_signal ?? 0,
  };

  // DB 저장
  await db.prepare(`
    INSERT OR REPLACE INTO condition_stats (
      stat_date, market,
      fail_no_lower_breach, fail_no_lower_recovery,
      fail_rsi_threshold, fail_rsi_not_rising,
      fail_outside_hours, fail_no_data, fail_api_error,
      total_scanned, total_no_signal,
      updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
  `).bind(
    stats.stat_date, stats.market,
    stats.fail_no_lower_breach, stats.fail_no_lower_recovery,
    stats.fail_rsi_threshold, stats.fail_rsi_not_rising,
    stats.fail_outside_hours, stats.fail_no_data, stats.fail_api_error,
    stats.total_scanned, stats.total_no_signal,
  ).run();

  return stats;
}

// ─── 3. 전략 성능 분석 ──────────────────────────────────────

/**
 * 특정 기간(7/30/90일) 기준 현재 전략 성능 지표 계산
 * realized_profits 테이블 기반
 */
export async function calcStrategyPerformance(
  db: D1Database,
  periodDays: 7 | 30 | 90,
  strategyKey = 'BB_RSI35'
): Promise<StrategyPerf> {
  const { from, to } = getKSTDateRange(periodDays);

  const rows = await db.prepare(`
    SELECT
      ticker, ticker_name, buy_price, sell_price,
      profit_loss, return_rate, created_at
    FROM realized_profits
    WHERE ${kstDateFilter('created_at', from, to)}
    ORDER BY created_at ASC
  `).all<{
    ticker: string; ticker_name: string; buy_price: number;
    sell_price: number; profit_loss: number; return_rate: number;
    created_at: string;
  }>();

  const trades = rows.results ?? [];

  if (trades.length === 0) {
    const empty: StrategyPerf = {
      period_days: periodDays, strategy_key: strategyKey,
      total_trades: 0, win_trades: 0, loss_trades: 0,
      win_rate: 0, avg_profit_rate: 0, avg_loss_rate: 0,
      total_profit: 0, total_loss: 0, ev: 0,
      profit_factor: 0, mdd: 0, avg_hold_hours: 0,
    };
    await _savePerfCache(db, empty);
    return empty;
  }

  const wins  = trades.filter(t => t.profit_loss > 0);
  const losses = trades.filter(t => t.profit_loss <= 0);

  const winRate       = trades.length > 0 ? wins.length / trades.length * 100 : 0;
  const avgProfitRate = wins.length > 0
    ? wins.reduce((s, t) => s + t.return_rate, 0)   / wins.length : 0;
  const avgLossRate   = losses.length > 0
    ? losses.reduce((s, t) => s + t.return_rate, 0) / losses.length : 0;
  const totalProfit   = wins.reduce((s, t) => s + t.profit_loss, 0);
  const totalLoss     = Math.abs(losses.reduce((s, t) => s + t.profit_loss, 0));

  // EV = win_rate * avg_profit_rate + (1 - win_rate) * avg_loss_rate
  const wr = winRate / 100;
  const ev = wr * avgProfitRate + (1 - wr) * avgLossRate;

  // Profit Factor = |총수익| / |총손실|
  const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? Infinity : 0);

  // MDD — 누적 손익 기준
  let peak = 0, mdd = 0, cum = 0;
  for (const t of trades) {
    cum += t.profit_loss;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > mdd) mdd = dd;
  }

  // 평균 보유시간 (orders join으로 계산)
  const holdRows = await db.prepare(`
    SELECT (julianday(s.created_at) - julianday(b.created_at)) * 24 as hold_hours
    FROM orders b
    JOIN orders s ON b.ticker = s.ticker
      AND s.order_type = 'SELL' AND s.status = 'FILLED'
      AND s.created_at > b.created_at
    WHERE b.order_type = 'BUY' AND b.status = 'FILLED'
      AND ${kstDateFilter('s.created_at', from, to)}
    GROUP BY b.ticker, b.created_at
  `).all<{ hold_hours: number }>();
  const holdArr = holdRows.results ?? [];
  const avgHoldHours = holdArr.length > 0
    ? holdArr.reduce((s, r) => s + r.hold_hours, 0) / holdArr.length : 0;

  const perf: StrategyPerf = {
    period_days:     periodDays,
    strategy_key:    strategyKey,
    total_trades:    trades.length,
    win_trades:      wins.length,
    loss_trades:     losses.length,
    win_rate:        parseFloat(winRate.toFixed(2)),
    avg_profit_rate: parseFloat(avgProfitRate.toFixed(4)),
    avg_loss_rate:   parseFloat(avgLossRate.toFixed(4)),
    total_profit:    parseFloat(totalProfit.toFixed(2)),
    total_loss:      parseFloat(totalLoss.toFixed(2)),
    ev:              parseFloat(ev.toFixed(4)),
    profit_factor:   isFinite(profitFactor) ? parseFloat(profitFactor.toFixed(3)) : 9999,
    mdd:             parseFloat(mdd.toFixed(2)),
    avg_hold_hours:  parseFloat(avgHoldHours.toFixed(2)),
  };

  await _savePerfCache(db, perf);
  return perf;
}

async function _savePerfCache(db: D1Database, perf: StrategyPerf) {
  const today = getKSTDateStr();
  await db.prepare(`
    INSERT OR REPLACE INTO strategy_perf_cache (
      cache_date, period_days, strategy_key,
      total_trades, win_trades, loss_trades,
      win_rate, avg_profit_rate, avg_loss_rate,
      total_profit, total_loss, ev, profit_factor, mdd, avg_hold_hours,
      generated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
  `).bind(
    today, perf.period_days, perf.strategy_key,
    perf.total_trades, perf.win_trades, perf.loss_trades,
    perf.win_rate, perf.avg_profit_rate, perf.avg_loss_rate,
    perf.total_profit, perf.total_loss, perf.ev, perf.profit_factor,
    perf.mdd, perf.avg_hold_hours,
  ).run();
}

// ─── 4. AI 개선 제안 ─────────────────────────────────────────

/**
 * 실제 누적 데이터 기반 규칙적 제안 생성
 * 임의 추천 금지 — 모든 제안은 데이터 수치 기반
 */
export async function generateSuggestions(
  db: D1Database,
  targetDate?: string
): Promise<AISuggestion[]> {
  const today = targetDate ?? getKSTDateStr();
  const suggestions: AISuggestion[] = [];

  // ① 조건 차단 분석 — 최근 7일 누적
  const condRows = await db.prepare(`
    SELECT
      SUM(fail_no_lower_breach)   as s_breach,
      SUM(fail_no_lower_recovery) as s_recovery,
      SUM(fail_rsi_threshold)     as s_rsi_thr,
      SUM(fail_rsi_not_rising)    as s_rsi_rise,
      SUM(fail_outside_hours)     as s_outside,
      SUM(fail_no_data)           as s_no_data,
      SUM(fail_api_error)         as s_api_err,
      SUM(total_no_signal)        as total_no_sig,
      SUM(total_scanned)          as total_scan
    FROM condition_stats
    WHERE stat_date >= date('now', '-7 days', '+9 hours')
      AND market = 'ALL'
  `).first<{
    s_breach: number; s_recovery: number; s_rsi_thr: number;
    s_rsi_rise: number; s_outside: number; s_no_data: number;
    s_api_err: number; total_no_sig: number; total_scan: number;
  }>();

  if (condRows && condRows.total_no_sig > 0) {
    const totalNS = condRows.total_no_sig;
    const conditions = [
      { key: 'fail_no_lower_breach',   val: condRows.s_breach   ?? 0, label: '하단선 이탈(①조건)' },
      { key: 'fail_no_lower_recovery', val: condRows.s_recovery ?? 0, label: '하단선 복귀(②조건)' },
      { key: 'fail_rsi_threshold',     val: condRows.s_rsi_thr  ?? 0, label: 'RSI 임계값(③조건)' },
      { key: 'fail_rsi_not_rising',    val: condRows.s_rsi_rise ?? 0, label: 'RSI 상승(④조건)' },
    ];

    // 가장 많이 차단하는 조건
    const topBlocker = conditions.reduce((a, b) => a.val > b.val ? a : b);
    const blockRate  = totalNS > 0 ? (topBlocker.val / totalNS * 100).toFixed(1) : '0';

    if (topBlocker.val > 0) {
      suggestions.push({
        category:    'CONDITION_BLOCK',
        priority:    topBlocker.val / totalNS > 0.5 ? 'HIGH' : 'MEDIUM',
        title:       `최대 차단 조건: ${topBlocker.label} (최근 7일)`,
        description: `최근 7일간 NO_SIGNAL ${totalNS}건 중 ${topBlocker.label} 조건이 ${topBlocker.val}건(${blockRate}%)을 차단했습니다. ` +
                     `전체 스캔 대비 신호 발생률은 ${condRows.total_scan > 0 ? (totalNS / condRows.total_scan * 100).toFixed(2) : 0}%입니다.`,
        data_basis: {
          period: '7일',
          total_no_signal: totalNS,
          total_scanned: condRows.total_scan,
          top_blocker: topBlocker,
          all_conditions: conditions,
        },
      });
    }

    // RSI 조건 차단 비율이 60% 이상이면 RSI 임계값 조정 제안
    const rsiBlockTotal = (condRows.s_rsi_thr ?? 0) + (condRows.s_rsi_rise ?? 0);
    if (rsiBlockTotal / totalNS > 0.60) {
      suggestions.push({
        category: 'RSI_THRESHOLD',
        priority: 'MEDIUM',
        title:    'RSI 조건이 60% 이상의 신호를 차단 중',
        description:
          `최근 7일간 RSI 관련 조건(③+④)이 NO_SIGNAL의 ${(rsiBlockTotal/totalNS*100).toFixed(1)}%를 차단하고 있습니다. ` +
          `RSI 임계값(현재 35)을 상향 조정하면 매수 신호 발생 빈도가 증가할 수 있습니다. ` +
          `단, 임계값 변경 전 전략 비교 탭에서 RSI 40 시나리오의 EV를 확인하세요.`,
        data_basis: {
          rsi_threshold_blocks: condRows.s_rsi_thr,
          rsi_rising_blocks: condRows.s_rsi_rise,
          total_blocks: rsiBlockTotal,
          block_ratio: parseFloat((rsiBlockTotal / totalNS).toFixed(4)),
        },
      });
    }
  }

  // ② 전략 성능 제안 — 최근 30일 성능 조회
  const perfRow = await db.prepare(`
    SELECT * FROM strategy_perf_cache
    WHERE period_days = 30 AND strategy_key = 'BB_RSI35'
    ORDER BY generated_at DESC LIMIT 1
  `).first<StrategyPerf & { cache_date: string }>();

  if (perfRow && perfRow.total_trades >= 5) {
    // 승률 60% 이상 + EV 양수 = 현재 전략 유지 권장
    if (perfRow.win_rate >= 60 && perfRow.ev > 0) {
      suggestions.push({
        category:    'PERFORMANCE',
        priority:    'INFO',
        title:       '현재 전략 유지 권장 (최근 30일 기준)',
        description: `최근 30일 기준 승률 ${perfRow.win_rate.toFixed(1)}%, EV ${(perfRow.ev*100).toFixed(2)}%로 ` +
                     `양호한 성과를 기록 중입니다. 현재 BB(20,2)+RSI(14≤35) 전략 유지가 통계적으로 유리합니다.`,
        data_basis:  { period: 30, win_rate: perfRow.win_rate, ev: perfRow.ev, profit_factor: perfRow.profit_factor },
      });
    }
    // 승률 < 40% 또는 EV < 0 = 전략 점검 필요
    if (perfRow.win_rate < 40 || perfRow.ev < 0) {
      suggestions.push({
        category:    'PERFORMANCE',
        priority:    'HIGH',
        title:       '전략 점검 필요 (최근 30일 기준)',
        description: `최근 30일 기준 승률 ${perfRow.win_rate.toFixed(1)}%, EV ${(perfRow.ev*100).toFixed(2)}%로 ` +
                     `성과가 저조합니다. 전략 비교 탭에서 대안 전략의 시뮬레이션 결과를 확인하세요.`,
        data_basis:  { period: 30, win_rate: perfRow.win_rate, ev: perfRow.ev, mdd: perfRow.mdd },
      });
    }

    // Profit Factor < 1 = 손실이 수익보다 큼
    if (perfRow.profit_factor < 1 && perfRow.profit_factor > 0) {
      suggestions.push({
        category:    'PERFORMANCE',
        priority:    'HIGH',
        title:       'Profit Factor < 1 — 총 손실이 총 수익 초과',
        description: `최근 30일 Profit Factor: ${perfRow.profit_factor.toFixed(3)}. ` +
                     `총 수익(${perfRow.total_profit.toLocaleString()}원)보다 총 손실(${perfRow.total_loss.toLocaleString()}원)이 큽니다. ` +
                     `RSI 임계값 또는 매도 조건 검토를 고려하세요.`,
        data_basis:  {
          profit_factor: perfRow.profit_factor,
          total_profit: perfRow.total_profit,
          total_loss: perfRow.total_loss,
        },
      });
    }
  }

  // ③ 거래 데이터 부족 안내
  if ((perfRow?.total_trades ?? 0) < 5) {
    suggestions.push({
      category:    'STRATEGY',
      priority:    'INFO',
      title:       '분석용 거래 데이터 부족',
      description: `최근 30일간 체결된 거래가 ${perfRow?.total_trades ?? 0}건으로 통계적 분석에는 ` +
                   `최소 5건 이상의 거래 데이터가 필요합니다. 더 많은 데이터가 축적되면 정밀한 제안이 생성됩니다.`,
      data_basis:  { trades_needed: 5, trades_available: perfRow?.total_trades ?? 0 },
    });
  }

  // ── DB 저장 ──────────────────────────────────────────────
  for (const sug of suggestions) {
    await db.prepare(`
      INSERT OR REPLACE INTO ai_suggestions (
        suggestion_date, category, priority, title, description, data_basis, is_applied
      ) VALUES (?,?,?,?,?,?,0)
    `).bind(
      today, sug.category, sug.priority, sug.title,
      sug.description, JSON.stringify(sug.data_basis),
    ).run();
  }

  return suggestions;
}

// ─── 5. 전략 비교 ────────────────────────────────────────────

/**
 * 실제 realized_profits 데이터를 재시뮬레이션하여 전략 간 성능 비교
 * 비교 전략: BB+RSI35(현재) vs BB+RSI40 vs BB단독 vs BB+RSI30
 *
 * 주의: API 호출 없이 기존 realized_profits의 buy_price / sell_price로
 * 각 전략 조건을 역산 적용하여 비교
 */
export async function compareStrategies(
  db: D1Database,
  periodDays: 7 | 30 | 90 = 30
): Promise<StrategyCompareResult[]> {
  const { from, to } = getKSTDateRange(periodDays);

  // realized_profits에서 실제 체결 데이터 조회
  // buy_rsi 컬럼이 없으므로 trade_logs의 message에서 RSI 값 파싱 시도
  // 또는 orders 테이블과 JOIN하여 매수 시점 RSI를 역산
  const profitRows = await db.prepare(`
    SELECT
      r.ticker, r.ticker_name, r.buy_price, r.sell_price,
      r.profit_loss, r.return_rate,
      r.created_at as sell_at
    FROM realized_profits r
    WHERE ${kstDateFilter('r.created_at', from, to)}
    ORDER BY r.created_at ASC
  `).all<{
    ticker: string; ticker_name: string; buy_price: number;
    sell_price: number; profit_loss: number; return_rate: number;
    sell_at: string;
  }>();

  const trades = profitRows.results ?? [];

  // trade_logs에서 BUY 신호의 RSI 값 수집 (ticker + 날짜 기준)
  const rsiLogs = await db.prepare(`
    SELECT ticker, message, created_at
    FROM trade_logs
    WHERE action = 'BUY'
      AND ${kstDateFilter('created_at', from, to)}
  `).all<{ ticker: string; message: string; created_at: string }>();

  // RSI 값 파싱 맵 구축 (ticker → RSI)
  const rsiMap = new Map<string, number>();
  for (const log of (rsiLogs.results ?? [])) {
    // message 예시: "RSI(34.2→35.8≤35)"
    const match = log.message?.match(/RSI\([^→]+→([0-9.]+)≤/);
    if (match) {
      rsiMap.set(log.ticker, parseFloat(match[1]));
    }
  }

  // 4가지 전략 정의
  const strategies = [
    { key: 'BB_RSI35',  label: 'BB + RSI35 (현재)',  rsiThreshold: 35, useRsi: true,  useRsiRising: true  },
    { key: 'BB_RSI40',  label: 'BB + RSI40',          rsiThreshold: 40, useRsi: true,  useRsiRising: true  },
    { key: 'BB_ONLY',   label: 'BB 단독',              rsiThreshold: 0,  useRsi: false, useRsiRising: false },
    { key: 'BB_RSI30',  label: 'BB + RSI30',           rsiThreshold: 30, useRsi: true,  useRsiRising: true  },
  ];

  const results: StrategyCompareResult[] = [];
  const today = getKSTDateStr();

  for (const strat of strategies) {
    // 각 전략 조건에 맞는 거래만 필터링
    let filteredTrades = trades;

    if (strat.useRsi) {
      filteredTrades = trades.filter(t => {
        const rsi = rsiMap.get(t.ticker);
        if (rsi === undefined) return strat.key === 'BB_RSI35'; // 현재 전략은 전체 포함
        return rsi <= strat.rsiThreshold;
      });
    }
    // BB 단독: RSI 조건 없이 전체 거래 포함 (BB 매수 신호만 기준)
    if (!strat.useRsi) filteredTrades = trades;

    const wins  = filteredTrades.filter(t => t.profit_loss > 0);
    const total = filteredTrades.length;
    const winRate = total > 0 ? wins.length / total * 100 : 0;

    const totalProfit = wins.reduce((s, t) => s + t.profit_loss, 0);
    const totalLoss   = Math.abs(filteredTrades.filter(t => t.profit_loss <= 0).reduce((s, t) => s + t.profit_loss, 0));
    const avgPR = wins.length > 0 ? wins.reduce((s, t) => s + t.return_rate, 0) / wins.length : 0;
    const avgLR = filteredTrades.filter(t => t.profit_loss <= 0).length > 0
      ? filteredTrades.filter(t => t.profit_loss <= 0).reduce((s, t) => s + t.return_rate, 0)
        / filteredTrades.filter(t => t.profit_loss <= 0).length : 0;

    const wr = winRate / 100;
    const ev = wr * avgPR + (1 - wr) * avgLR;
    const pf = totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? 9999 : 0);

    const result: StrategyCompareResult = {
      strategy_key:   strat.key,
      strategy_label: strat.label,
      rsi_threshold:  strat.useRsi ? strat.rsiThreshold : null,
      use_rsi_rising: strat.useRsiRising,
      total_trades:   total,
      win_rate:       parseFloat(winRate.toFixed(2)),
      ev:             parseFloat(ev.toFixed(4)),
      total_profit:   parseFloat((totalProfit - totalLoss).toFixed(2)),
      profit_factor:  parseFloat(pf.toFixed(3)),
    };
    results.push(result);

    // 캐시 저장
    await db.prepare(`
      INSERT OR REPLACE INTO strategy_perf_cache (
        cache_date, period_days, strategy_key,
        total_trades, win_trades, loss_trades,
        win_rate, avg_profit_rate, avg_loss_rate,
        total_profit, total_loss, ev, profit_factor, mdd, avg_hold_hours,
        rsi_threshold, use_rsi, use_rsi_rising,
        generated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,CURRENT_TIMESTAMP)
    `).bind(
      today, periodDays, strat.key,
      total, wins.length, total - wins.length,
      result.win_rate, avgPR, avgLR,
      totalProfit, totalLoss, result.ev, result.profit_factor,
      strat.useRsi ? strat.rsiThreshold : 0,
      strat.useRsi ? 1 : 0,
      strat.useRsiRising ? 1 : 0,
    ).run();
  }

  return results;
}

// ─── 전체 리포트 일괄 생성 (cron 호출용) ────────────────────

export async function runFullDailyReport(db: D1Database): Promise<{
  daily: DailyReport;
  conditions: ConditionStats;
  performance: StrategyPerf[];
  suggestions: AISuggestion[];
}> {
  const today = getKSTDateStr();

  const [daily, condKR, condUS, condAll] = await Promise.all([
    generateDailyReport(db, today),
    analyzeConditions(db, today, 'KR'),
    analyzeConditions(db, today, 'US'),
    analyzeConditions(db, today, 'ALL'),
  ]);

  const [p7, p30, p90] = await Promise.all([
    calcStrategyPerformance(db, 7),
    calcStrategyPerformance(db, 30),
    calcStrategyPerformance(db, 90),
  ]);

  const suggestions = await generateSuggestions(db, today);

  // 전략 비교도 함께 실행 (캐시 업데이트)
  await compareStrategies(db, 30);

  return {
    daily,
    conditions: condAll,
    performance: [p7, p30, p90],
    suggestions,
  };
}
