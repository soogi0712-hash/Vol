-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0007: 기술적 지표 스냅샷 테이블
-- ──────────────────────────────────────────────────────────────────────────────
-- 관찰/저장 전용. 매매 전략(볼린저밴드 + RSI)과 무관하며 매매 판단·주문·수량·
-- 손익 로직에 사용되지 않는다. 스캐너가 확정봉 로드 후 종목별로 스냅샷을 계산해
-- UPSERT 한다.
--
-- boolean 은 기존 규약대로 INTEGER(0/1)로 저장한다.
-- boolean|null(가격-EMA 위치)은 EMA 미정의 시 NULL 로 저장한다.
-- 유니크 키 (market, symbol, candle_ts) 로 반복 스캔은 갱신되고,
-- 서로 다른 candle_ts 는 별도 행으로 보존된다(과거 이력 유지).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS indicator_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT    NOT NULL,
  market        TEXT    NOT NULL,                 -- KR | US
  candle_ts     TEXT    NOT NULL,                 -- 확정봉 시각 (YYYYMMDDHHMMSS)
  close         REAL    NOT NULL,

  -- 지수이동평균 (데이터 부족 시 NULL)
  ema20         REAL,
  ema30         REAL,
  ema60         REAL,
  ema120        REAL,

  -- MACD (12,26,9)
  macd                     REAL,
  macd_signal              REAL,
  macd_histogram           REAL,
  macd_golden_cross        INTEGER NOT NULL DEFAULT 0,
  macd_dead_cross          INTEGER NOT NULL DEFAULT 0,
  macd_histogram_positive  INTEGER NOT NULL DEFAULT 0,

  -- 캔들 패턴 플래그 (0/1)
  doji               INTEGER NOT NULL DEFAULT 0,
  long_legged_doji   INTEGER NOT NULL DEFAULT 0,
  dragonfly_doji     INTEGER NOT NULL DEFAULT 0,
  gravestone_doji    INTEGER NOT NULL DEFAULT 0,
  hammer             INTEGER NOT NULL DEFAULT 0,
  inverted_hammer    INTEGER NOT NULL DEFAULT 0,
  shooting_star      INTEGER NOT NULL DEFAULT 0,
  bullish_engulfing  INTEGER NOT NULL DEFAULT 0,
  bearish_engulfing  INTEGER NOT NULL DEFAULT 0,
  bullish_harami     INTEGER NOT NULL DEFAULT 0,
  bearish_harami     INTEGER NOT NULL DEFAULT 0,

  -- 거래량
  current_volume   REAL,
  volume_sma20     REAL,
  volume_ratio     REAL,
  volume_surge     INTEGER NOT NULL DEFAULT 0,

  -- 변동성/추세
  atr14                REAL,
  adx14                REAL,
  bollinger_bandwidth  REAL,

  -- EMA 정렬/위치
  ema_bullish_alignment     INTEGER NOT NULL DEFAULT 0,
  ema_bearish_alignment     INTEGER NOT NULL DEFAULT 0,
  price_above_ema20         INTEGER,   -- 0/1/NULL (EMA 미정의 시 NULL)
  price_above_ema30         INTEGER,
  price_above_ema60         INTEGER,
  price_above_ema120        INTEGER,
  ema30_pullback_candidate  INTEGER NOT NULL DEFAULT 0,

  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(market, symbol, candle_ts)
);

-- 조회 인덱스: 종목별 / 시각별
CREATE INDEX IF NOT EXISTS idx_indicator_snap_symbol
  ON indicator_snapshots (market, symbol, candle_ts DESC);
CREATE INDEX IF NOT EXISTS idx_indicator_snap_ts
  ON indicator_snapshots (candle_ts DESC);
CREATE INDEX IF NOT EXISTS idx_indicator_snap_symbol_only
  ON indicator_snapshots (symbol);
