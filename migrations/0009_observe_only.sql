-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0009: 관찰 전용(observe-only) 모드 플래그
-- ──────────────────────────────────────────────────────────────────────────────
-- observe_only_enabled = '1' 이면 (auto_trade_enabled=1 일 때) 전체 스캔·지표·
-- 캔들 누적·로그는 그대로 수행하되, 최종 실주문(buyKR/sellKR/buyUS/sellUS)만
-- 차단한다. 매수/매도 결정 로직·수량·사이징은 전혀 바뀌지 않는다.
--
-- auto_trade_enabled 의 의미는 재해석하지 않는다:
--   auto_trade_enabled=0             → 기존과 동일하게 스캔 자체가 비활성(조기 반환)
--   auto_trade_enabled=1, observe=1  → 스캔·기록 O, 실주문 X (안전 관찰)
--   auto_trade_enabled=1, observe=0  → 기존 라이브 매매 동작 그대로
--
-- 프로덕션 안전 기본값(마이그레이션 후):
--   auto_trade_enabled  = 0   (0002 기본값 유지, 여기서 건드리지 않음)
--   observe_only_enabled = 1  (아래에서 삽입)
-- 기존 마이그레이션과 동일한 멱등 삽입 패턴(INSERT OR IGNORE) 사용.
-- ──────────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO system_config (key, value, description) VALUES
  ('observe_only_enabled', '1', '관찰 전용 모드 — 스캔/기록은 하되 실주문 차단 (1=관찰, 0=라이브 주문)');
