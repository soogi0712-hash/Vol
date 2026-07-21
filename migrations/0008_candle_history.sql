-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0008: 확정 캔들 이력 테이블 (관찰 전용, 매매와 무관)
-- ──────────────────────────────────────────────────────────────────────────────
-- KR 국내 15분봉 엔드포인트는 요청 count 와 무관하게 대략 하루치 세션만 반환한다.
-- 따라서 EMA60/EMA120 을 위한 장기 이력은 "추가 KIS 요청"으로 얻을 수 없다.
-- 대신 매매 스캔이 매 사이클 이미 가져오는 확정봉을 이 테이블에 누적 저장하고,
-- 지표 계산 시 D1 에서 최근 N개를 읽어 사용한다 (KR 추가 KIS 요청 0).
--
-- 형성 중(미확정) 최신봉은 절대 저장하지 않는다 (호출 측이 confirmedCandles 로 제거).
-- boolean 없음. 가격/거래량은 기존 규약대로 REAL.
-- 유니크 키 (market, symbol, candle_ts) 로 반복 스캔은 UPSERT(갱신)되고,
-- 서로 다른 candle_ts 는 별도 행으로 보존된다 (과거 캔들 삭제/덮어쓰기 없음).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS candle_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  market      TEXT NOT NULL,               -- KR | US
  symbol      TEXT NOT NULL,
  candle_ts   TEXT NOT NULL,               -- 확정봉 시각 (YYYYMMDDHHMMSS)
  open        REAL NOT NULL,
  high        REAL NOT NULL,
  low         REAL NOT NULL,
  close       REAL NOT NULL,
  volume      REAL NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(market, symbol, candle_ts)
);

-- 최근 N개 조회(oldest→newest 재정렬 전 DESC LIMIT) 최적화
CREATE INDEX IF NOT EXISTS idx_candle_history_symbol_ts
  ON candle_history (market, symbol, candle_ts DESC);
