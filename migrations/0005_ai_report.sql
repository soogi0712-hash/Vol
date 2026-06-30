-- AI 전략 리포트 v5
-- daily_reports: 날짜별 일일 리포트 저장
-- condition_stats: 조건별 미충족 집계 (날짜별)
-- strategy_perf_cache: 전략 성능 지표 캐시 (7/30/90일)

-- ── 일일 리포트 테이블 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_reports (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date          TEXT    NOT NULL UNIQUE,  -- YYYY-MM-DD (KST)
  -- 스캔 통계
  total_scanned        INTEGER NOT NULL DEFAULT 0,  -- 전체 스캔 종목 수
  normal_scanned       INTEGER NOT NULL DEFAULT 0,  -- 정상 스캔 종목 수
  no_data_count        INTEGER NOT NULL DEFAULT 0,  -- NO_DATA 종목 수
  api_error_count      INTEGER NOT NULL DEFAULT 0,  -- API_ERROR 종목 수
  -- 신호 통계
  buy_signal_count     INTEGER NOT NULL DEFAULT 0,  -- 매수 신호 발생 건수
  sell_signal_count    INTEGER NOT NULL DEFAULT 0,  -- 매도 신호 발생 건수
  actual_buy_count     INTEGER NOT NULL DEFAULT 0,  -- 실제 매수 건수
  actual_sell_count    INTEGER NOT NULL DEFAULT 0,  -- 실제 매도 건수
  order_fail_count     INTEGER NOT NULL DEFAULT 0,  -- 주문 실패 건수
  order_fail_reasons   TEXT    NOT NULL DEFAULT '', -- 주문 실패 사유 (JSON)
  -- 손익 통계
  realized_pnl         REAL    NOT NULL DEFAULT 0,  -- 실현손익 (원)
  eval_pnl             REAL    NOT NULL DEFAULT 0,  -- 평가손익 (원)
  -- 성과 지표
  win_rate             REAL    NOT NULL DEFAULT 0,  -- 승률 (%, 해당일 청산 기준)
  avg_profit_rate      REAL    NOT NULL DEFAULT 0,  -- 평균 수익률 (%)
  avg_loss_rate        REAL    NOT NULL DEFAULT 0,  -- 평균 손실률 (%)
  avg_hold_hours       REAL    NOT NULL DEFAULT 0,  -- 평균 보유기간 (시간)
  -- 최대 종목
  max_profit_ticker    TEXT    NOT NULL DEFAULT '', -- 최대 수익 종목 코드
  max_profit_name      TEXT    NOT NULL DEFAULT '', -- 최대 수익 종목명
  max_profit_rate      REAL    NOT NULL DEFAULT 0,  -- 최대 수익률 (%)
  max_loss_ticker      TEXT    NOT NULL DEFAULT '', -- 최대 손실 종목 코드
  max_loss_name        TEXT    NOT NULL DEFAULT '', -- 최대 손실 종목명
  max_loss_rate        REAL    NOT NULL DEFAULT 0,  -- 최대 손실률 (%)
  -- 메타
  generated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ── 조건 미충족 집계 테이블 ──────────────────────────────────────
-- 날짜+시장 단위로 각 조건별 미충족 횟수 집계
CREATE TABLE IF NOT EXISTS condition_stats (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  stat_date                TEXT    NOT NULL,        -- YYYY-MM-DD (KST)
  market                   TEXT    NOT NULL DEFAULT 'ALL', -- KR | US | ALL
  -- 조건별 미충족 횟수
  fail_no_lower_breach     INTEGER NOT NULL DEFAULT 0,  -- ① 하단선 이탈 미충족
  fail_no_lower_recovery   INTEGER NOT NULL DEFAULT 0,  -- ② 하단선 복귀 미충족
  fail_rsi_threshold       INTEGER NOT NULL DEFAULT 0,  -- ③ RSI 조건 미충족 (RSI > 35)
  fail_rsi_not_rising      INTEGER NOT NULL DEFAULT 0,  -- ④ RSI 상승 미충족
  fail_outside_hours       INTEGER NOT NULL DEFAULT 0,  -- 장외시간
  fail_no_data             INTEGER NOT NULL DEFAULT 0,  -- NO_DATA
  fail_api_error           INTEGER NOT NULL DEFAULT 0,  -- API_ERROR
  total_scanned            INTEGER NOT NULL DEFAULT 0,  -- 총 스캔 수
  total_no_signal          INTEGER NOT NULL DEFAULT 0,  -- NO_SIGNAL 건수
  -- 메타
  created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(stat_date, market)
);

-- ── 전략 성능 캐시 테이블 ─────────────────────────────────────────
-- 7일/30일/90일 기준 전략 성능 지표 (계산 비용이 높아 캐싱)
CREATE TABLE IF NOT EXISTS strategy_perf_cache (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_date      TEXT    NOT NULL,  -- 캐시 생성 날짜 YYYY-MM-DD
  period_days     INTEGER NOT NULL,  -- 7 | 30 | 90
  strategy_key    TEXT    NOT NULL DEFAULT 'BB_RSI35', -- 전략 식별키
  -- 성능 지표
  total_trades    INTEGER NOT NULL DEFAULT 0,   -- 총 거래 수
  win_trades      INTEGER NOT NULL DEFAULT 0,   -- 수익 거래 수
  loss_trades     INTEGER NOT NULL DEFAULT 0,   -- 손실 거래 수
  win_rate        REAL    NOT NULL DEFAULT 0,   -- 승률 (%)
  avg_profit_rate REAL    NOT NULL DEFAULT 0,   -- 평균 수익률 (%)
  avg_loss_rate   REAL    NOT NULL DEFAULT 0,   -- 평균 손실률 (%)
  total_profit    REAL    NOT NULL DEFAULT 0,   -- 총 수익 (원)
  total_loss      REAL    NOT NULL DEFAULT 0,   -- 총 손실 (원)
  ev              REAL    NOT NULL DEFAULT 0,   -- 기대수익 EV (%)
  profit_factor   REAL    NOT NULL DEFAULT 0,   -- Profit Factor
  mdd             REAL    NOT NULL DEFAULT 0,   -- 최대 낙폭 MDD (원)
  avg_hold_hours  REAL    NOT NULL DEFAULT 0,   -- 평균 보유 시간
  -- 전략 비교용 추가 필드
  rsi_threshold   INTEGER NOT NULL DEFAULT 35,  -- RSI 임계값
  use_rsi         INTEGER NOT NULL DEFAULT 1,   -- RSI 조건 사용 여부
  use_rsi_rising  INTEGER NOT NULL DEFAULT 1,   -- RSI 상승 조건 사용 여부
  -- 메타
  generated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(cache_date, period_days, strategy_key)
);

-- ── AI 개선 제안 테이블 ──────────────────────────────────────────
-- 데이터 기반 규칙 제안 (임의 생성 금지)
CREATE TABLE IF NOT EXISTS ai_suggestions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_date TEXT    NOT NULL,        -- YYYY-MM-DD
  category        TEXT    NOT NULL,        -- RSI_THRESHOLD | CONDITION_BLOCK | PERFORMANCE | STRATEGY
  priority        TEXT    NOT NULL DEFAULT 'INFO', -- HIGH | MEDIUM | LOW | INFO
  title           TEXT    NOT NULL,        -- 제안 제목
  description     TEXT    NOT NULL,        -- 상세 설명 (데이터 수치 포함)
  data_basis      TEXT    NOT NULL DEFAULT '', -- 근거 데이터 (JSON)
  is_applied      INTEGER NOT NULL DEFAULT 0,  -- 적용 여부 (항상 0, 사용자만 변경)
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(suggestion_date, category, title)
);

-- ── 인덱스 ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_daily_reports_date    ON daily_reports(report_date);
CREATE INDEX IF NOT EXISTS idx_condition_stats_date  ON condition_stats(stat_date);
CREATE INDEX IF NOT EXISTS idx_condition_stats_mkt   ON condition_stats(stat_date, market);
CREATE INDEX IF NOT EXISTS idx_strategy_perf_date    ON strategy_perf_cache(cache_date);
CREATE INDEX IF NOT EXISTS idx_strategy_perf_key     ON strategy_perf_cache(strategy_key, period_days);
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_date   ON ai_suggestions(suggestion_date);

-- ── system_config: 리포트 관련 키 추가 ──────────────────────────
INSERT OR IGNORE INTO system_config (key, value, description) VALUES
  ('report_auto_generate',  '1',    '장마감 후 자동 리포트 생성 여부'),
  ('report_last_generated', '',     '마지막 리포트 생성 날짜 (YYYYMMDD)'),
  ('report_perf_cache_ttl', '3600', '성능 캐시 유효시간(초)');
