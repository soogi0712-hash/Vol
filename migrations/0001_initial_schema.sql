-- 볼린저밴드 자동매매 DB 스키마

-- 매매 종목 설정
CREATE TABLE IF NOT EXISTS watch_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL UNIQUE,          -- 종목코드 (ex: 005930)
  ticker_name TEXT NOT NULL,            -- 종목명
  is_active INTEGER NOT NULL DEFAULT 1, -- 0: 비활성, 1: 활성
  bb_period INTEGER NOT NULL DEFAULT 20,
  bb_stddev REAL NOT NULL DEFAULT 2.0,
  buy_qty INTEGER NOT NULL DEFAULT 1,   -- 1회 매수 수량
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 주문 내역
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT,                        -- 한국투자증권 주문번호
  ticker TEXT NOT NULL,
  ticker_name TEXT NOT NULL,
  order_type TEXT NOT NULL,             -- BUY / SELL
  price REAL NOT NULL,
  qty INTEGER NOT NULL,
  filled_qty INTEGER NOT NULL DEFAULT 0,
  filled_price REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING / FILLED / PARTIAL / CANCELLED / FAILED
  reason TEXT,                          -- 매매 사유 (BB_BUY / BB_SELL_MID / BB_SELL_UPPER)
  raw_response TEXT,                    -- API 응답 원문 (JSON)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 보유 종목
CREATE TABLE IF NOT EXISTS holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL UNIQUE,
  ticker_name TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  avg_price REAL NOT NULL DEFAULT 0,
  current_price REAL NOT NULL DEFAULT 0,
  eval_profit_loss REAL NOT NULL DEFAULT 0,
  eval_return_rate REAL NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 매매 로그 (전략 판단 로그)
CREATE TABLE IF NOT EXISTS trade_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  ticker_name TEXT NOT NULL,
  action TEXT NOT NULL,                 -- SIGNAL_BUY / SIGNAL_SELL_MID / SIGNAL_SELL_UPPER / NO_SIGNAL / ERROR
  current_price REAL,
  bb_upper REAL,
  bb_middle REAL,
  bb_lower REAL,
  prev_close REAL,
  prev_bb_lower REAL,
  message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 실현 손익
CREATE TABLE IF NOT EXISTS realized_profits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  ticker_name TEXT NOT NULL,
  sell_order_id INTEGER,
  buy_price REAL NOT NULL,
  sell_price REAL NOT NULL,
  qty INTEGER NOT NULL,
  profit_loss REAL NOT NULL,
  return_rate REAL NOT NULL,
  sell_reason TEXT,                     -- BB_SELL_MID / BB_SELL_UPPER
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 시스템 설정
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 기본 시스템 설정 삽입
INSERT OR IGNORE INTO system_config (key, value, description) VALUES
  ('auto_trade_enabled', '0', '자동매매 활성화 여부 (0: 비활성, 1: 활성)'),
  ('scan_interval_minutes', '1', '매매 스캔 주기 (분)'),
  ('market_open_time', '0900', '장 시작 시간'),
  ('market_close_time', '1530', '장 마감 시간'),
  ('last_scan_at', '', '마지막 스캔 시각');

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_orders_ticker ON orders(ticker);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_trade_logs_ticker ON trade_logs(ticker);
CREATE INDEX IF NOT EXISTS idx_trade_logs_created_at ON trade_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_realized_profits_ticker ON realized_profits(ticker);
