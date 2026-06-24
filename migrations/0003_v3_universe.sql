-- v3: 전체시장 스캔 지원
-- stock_universe: KOSPI/KOSDAQ/NASD/NYSE/AMEX 전체 종목 목록
-- scan_batch_state: 배치 스캔 진행 상태 추적
-- system_config에 스캔 관련 키 추가

-- ── 종목 유니버스 테이블 ────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_universe (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker       TEXT    NOT NULL,
  ticker_name  TEXT    NOT NULL DEFAULT '',
  market       TEXT    NOT NULL,           -- KR | US
  exchange     TEXT    NOT NULL,           -- KOSPI | KOSDAQ | NASD | NYSE | AMEX
  is_active    INTEGER NOT NULL DEFAULT 1,
  last_scanned_at DATETIME,               -- 마지막 스캔 시각
  last_signal  TEXT    DEFAULT 'NONE',    -- 마지막 BB 신호
  scan_error   TEXT,                       -- 마지막 오류 메시지
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(ticker, exchange)
);

-- ── 스캔 배치 상태 테이블 ──────────────────────────────────
CREATE TABLE IF NOT EXISTS scan_batch_state (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        TEXT    NOT NULL UNIQUE,  -- 배치 식별자 (날짜+시장)
  market          TEXT    NOT NULL,         -- KR | US
  exchange        TEXT    NOT NULL,         -- KOSPI | KOSDAQ | NASD | NYSE | AMEX
  total_tickers   INTEGER NOT NULL DEFAULT 0,
  scanned_count   INTEGER NOT NULL DEFAULT 0,
  buy_signals     INTEGER NOT NULL DEFAULT 0,
  sell_signals    INTEGER NOT NULL DEFAULT 0,
  error_count     INTEGER NOT NULL DEFAULT 0,
  batch_offset    INTEGER NOT NULL DEFAULT 0,  -- 다음 스캔 시작 인덱스
  status          TEXT    NOT NULL DEFAULT 'IDLE', -- IDLE | RUNNING | DONE
  started_at      DATETIME,
  completed_at    DATETIME,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ── system_config 신규 키 추가 ──────────────────────────────
INSERT OR IGNORE INTO system_config (key, value, description) VALUES
  ('scan_batch_size',      '20',   '1회 Cron 실행당 처리할 종목 수'),
  ('scan_kr_enabled',      '1',    'KR 전체시장 스캔 활성화'),
  ('scan_us_enabled',      '1',    'US 전체시장 스캔 활성화'),
  ('current_batch_id',     '',     '현재 진행 중인 배치 ID'),
  ('universe_loaded_at',   '',     '종목 유니버스 마지막 로드 시각');

-- ── holdings 테이블에 exchange 컬럼 추가 (v2 schema에 누락됨) ──
-- trade-engine v3에서 exchange 컬럼을 INSERT/UPDATE하므로 필수
ALTER TABLE holdings ADD COLUMN exchange TEXT NOT NULL DEFAULT 'KOSPI';

-- ── 인덱스 ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_universe_market    ON stock_universe(market);
CREATE INDEX IF NOT EXISTS idx_universe_exchange  ON stock_universe(exchange);
CREATE INDEX IF NOT EXISTS idx_universe_scanned   ON stock_universe(last_scanned_at);
CREATE INDEX IF NOT EXISTS idx_batch_market       ON scan_batch_state(market);
