-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0010: candle_history 에 timeframe 도입 + 오염된 KR 데이터 제거
-- ──────────────────────────────────────────────────────────────────────────────
-- 배경:
--  • 기존 candle_history 의 KR 행은 버그난 getKR15MinCandles(고정 fid_input_hour_1=
--    153000 → 미래시각 → 전 봉 현재가 반복) 결과로, 정상 15분봉이 아니다. 재사용 금지.
--  • US 행은 존재하지 않는다: accumulateKRHistory 가 유일한 writer 이며 `if (isKR)`
--    가드 안에서만 호출된다(코드 검증). 따라서 이관할 US 데이터가 없다.
--
-- 처리(안전 재생성):
--  • 기존 테이블을 DROP (KR 오염 데이터 제거, US 데이터 없음 → 손실 없음).
--  • 정확한 스키마로 재생성하며 timeframe 컬럼을 추가한다.
--  • 유니크 키/인덱스에 timeframe 을 포함한다.
--  • 기존 KR 행을 DEFAULT '15m' 로 이관하지 않는다(요구사항).
-- ──────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS candle_history;

CREATE TABLE candle_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  market      TEXT NOT NULL,               -- KR | US
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,               -- '15m' (그 외 주기는 명시적으로만 저장)
  candle_ts   TEXT NOT NULL,               -- 완성봉 시각 (YYYYMMDDHHMMSS, 15분봉은 버킷 시작)
  open        REAL NOT NULL,
  high        REAL NOT NULL,
  low         REAL NOT NULL,
  close       REAL NOT NULL,
  volume      REAL NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(market, symbol, timeframe, candle_ts)
);

CREATE INDEX IF NOT EXISTS idx_candle_history_tf
  ON candle_history (market, symbol, timeframe, candle_ts DESC);
