-- v4: 전체시장 종목 마스터 로드 지원
-- KIS 마스터 파일에서 직접 로드 (KOSPI ~1800, KOSDAQ ~1800, NASD ~5200, NYSE ~2900, AMEX ~4500)

-- ── stock_universe 인덱스 추가 (이미 없을 경우) ───────────────
CREATE INDEX IF NOT EXISTS idx_universe_signal   ON stock_universe(last_signal);
CREATE INDEX IF NOT EXISTS idx_universe_error    ON stock_universe(scan_error);

-- ── system_config: 전체시장 로드 관련 키 ─────────────────────
INSERT OR IGNORE INTO system_config (key, value, description) VALUES
  ('universe_kr_count',    '0',   'DB에 로드된 KR 종목 수'),
  ('universe_us_count',    '0',   'DB에 로드된 US 종목 수'),
  ('universe_load_source', '',    '마지막 로드 소스 (kis_master|embedded)'),
  ('universe_load_date',   '',    '마지막 종목 마스터 로드 날짜 (YYYYMMDD)'),
  ('scan_us_type',         '2,3', 'US 스캔 대상 타입 (2=주식, 3=ETF, 2,3=둘다)'),
  ('scan_kr_type',         '6',   'KR 스캔 대상 (6=6자리코드일반주식)'),
  ('scan_batch_offset_all','0',   '전체(KR+US) 통합 배치 오프셋');
