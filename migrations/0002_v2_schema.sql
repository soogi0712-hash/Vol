-- 볼린저밴드 자동매매 v2 스키마 (15분봉, KR+US)
-- v1 테이블을 DROP 후 v2로 재생성 (market, above_upper, buy_amount 등 추가)

-- ── v1 테이블 삭제 ────────────────────────────────────────────
DROP TABLE IF EXISTS watch_list;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS holdings;
DROP TABLE IF EXISTS trade_logs;
DROP TABLE IF EXISTS realized_profits;
DROP TABLE IF EXISTS system_config;
DROP TABLE IF EXISTS backtest_results;

-- ── v2 테이블 재생성 ──────────────────────────────────────────

-- 감시 종목
CREATE TABLE IF NOT EXISTS watch_list (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker       TEXT    NOT NULL UNIQUE,
  ticker_name  TEXT    NOT NULL,
  market       TEXT    NOT NULL DEFAULT 'KR',  -- KR | US
  is_active    INTEGER NOT NULL DEFAULT 1,
  buy_amount   REAL    NOT NULL DEFAULT 100000, -- 1회 매수 금액(원/달러)
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 주문 내역
CREATE TABLE IF NOT EXISTS orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no     TEXT,
  ticker       TEXT    NOT NULL,
  ticker_name  TEXT    NOT NULL,
  market       TEXT    NOT NULL DEFAULT 'KR',
  order_type   TEXT    NOT NULL,   -- BUY | SELL
  price        REAL    NOT NULL,
  qty          INTEGER NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'PENDING',
  reason       TEXT,               -- BB_BUY | BB_SELL_UPPER_BREAK
  raw_response TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 보유 종목
CREATE TABLE IF NOT EXISTS holdings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker           TEXT NOT NULL UNIQUE,
  ticker_name      TEXT NOT NULL,
  market           TEXT NOT NULL DEFAULT 'KR',
  qty              INTEGER NOT NULL DEFAULT 0,
  avg_price        REAL    NOT NULL DEFAULT 0,
  current_price    REAL    NOT NULL DEFAULT 0,
  above_upper      INTEGER NOT NULL DEFAULT 0, -- 상단선 위에 있는 상태 플래그
  eval_profit_loss REAL    NOT NULL DEFAULT 0,
  eval_return_rate REAL    NOT NULL DEFAULT 0,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 매매 로그
CREATE TABLE IF NOT EXISTS trade_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker        TEXT NOT NULL,
  ticker_name   TEXT NOT NULL,
  market        TEXT NOT NULL DEFAULT 'KR',
  action        TEXT NOT NULL,
  current_price REAL,
  bb_upper      REAL,
  bb_middle     REAL,
  bb_lower      REAL,
  prev_close    REAL,
  prev_bb_lower REAL,
  above_upper   INTEGER DEFAULT 0,
  message       TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 실현 손익
CREATE TABLE IF NOT EXISTS realized_profits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker       TEXT NOT NULL,
  ticker_name  TEXT NOT NULL,
  market       TEXT NOT NULL DEFAULT 'KR',
  sell_order_id INTEGER,
  buy_price    REAL NOT NULL,
  sell_price   REAL NOT NULL,
  qty          INTEGER NOT NULL,
  profit_loss  REAL NOT NULL,
  return_rate  REAL NOT NULL,
  sell_reason  TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 백테스트 결과
CREATE TABLE IF NOT EXISTS backtest_results (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker         TEXT NOT NULL,
  ticker_name    TEXT NOT NULL,
  market         TEXT NOT NULL DEFAULT 'KR',
  start_date     TEXT NOT NULL,
  end_date       TEXT NOT NULL,
  total_trades   INTEGER NOT NULL DEFAULT 0,
  win_trades     INTEGER NOT NULL DEFAULT 0,
  loss_trades    INTEGER NOT NULL DEFAULT 0,
  total_profit   REAL    NOT NULL DEFAULT 0,
  win_rate       REAL    NOT NULL DEFAULT 0,
  avg_return     REAL    NOT NULL DEFAULT 0,
  max_drawdown   REAL    NOT NULL DEFAULT 0,
  params         TEXT,   -- JSON: {period, stddev}
  trades_json    TEXT,   -- JSON 상세 거래 내역
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 시스템 설정
CREATE TABLE IF NOT EXISTS system_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  description TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO system_config (key, value, description) VALUES
  ('auto_trade_enabled',    '0',   '자동매매 활성화 여부'),
  ('kr_trade_enabled',      '1',   '한국주식 거래 활성화'),
  ('us_trade_enabled',      '1',   '미국주식 거래 활성화'),
  ('last_scan_at',          '',    '마지막 스캔 시각'),
  ('bb_period',             '20',  '볼린저밴드 기간'),
  ('bb_stddev',             '2',   '볼린저밴드 표준편차');

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_orders_ticker       ON orders(ticker);
CREATE INDEX IF NOT EXISTS idx_orders_created_at   ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_trade_logs_ticker   ON trade_logs(ticker);
CREATE INDEX IF NOT EXISTS idx_trade_logs_created_at ON trade_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_realized_ticker     ON realized_profits(ticker);
CREATE INDEX IF NOT EXISTS idx_backtest_ticker     ON backtest_results(ticker);
