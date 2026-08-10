// 미국장 실전 투입 최종 P0 체크리스트 (P0-10). 안전장치 구현 여부 + 오늘 운영 설정을 종합해
// US_LIVE_READY 를 산출한다. 모두 true 여야 오늘 미국장 실전 가능(하나라도 false 면 LS_LIVE_TRADING=false 유지).
import type { LiveConfig } from './live-config';

export interface USP0Checklist {
  MANUAL_CANCEL_MODE: boolean;
  AUTO_CANCEL_MODE: boolean;
  US_ORDER_POST_IDEMPOTENT: boolean;      // 전송 직전 candle lock — 같은 candle 1 POST(구현됨)
  US_CASH_ONLY_GATE: boolean;             // 현금(USD) 주문가능 재조회 게이트(구현됨)
  US_PENDING_REORDER_BLOCKED: boolean;    // 미체결 시 신규 BUY 금지(구현됨)
  US_RESTART_RECONCILIATION: boolean;     // 주문 전 거래소 대사(구현됨)
  US_AS_EVENT_LINKED: boolean;            // AS0/AS1/AS3/AS4 ↔ 주문번호 pending 연결(구현됨)
  US_SINGLE_POST_PER_CANDLE: boolean;     // 같은 candle 1회 POST(idempotent 와 동일 보장)
  US_DAILY_BUY_LIMIT: boolean;            // AAPL·qty1·하루 BUY1 제한(설정 확인)
  US_CROSS_WON_VERIFIED: boolean;         // 타통화+원화(통합증거금/선환전) 공식 필드 실측확인(P0-16). 미확인이면 BUY 하드차단.
  US_LIVE_READY: boolean;                 // 위 전부 충족(+수동취소 모드) → 실전 가능
}

// 구현된 안전장치 플래그(코드로 보장). 설정 의존 플래그는 cfg 로 판정.
export function computeUSP0Checklist(cfg: LiveConfig): USP0Checklist {
  // P0-23: 종목 하드코딩(AAPL) 제거 — 오늘 첫 전체종목 실전 안전제한(qty1/하루BUY1)만 확인.
  const dailyOk = cfg.maxQty === 1 && cfg.dailyMaxBuys === 1;
  const base = {
    MANUAL_CANCEL_MODE: cfg.manualCancel,
    AUTO_CANCEL_MODE: cfg.autoCancel,
    US_ORDER_POST_IDEMPOTENT: true,
    US_CASH_ONLY_GATE: true,
    US_PENDING_REORDER_BLOCKED: true,
    US_RESTART_RECONCILIATION: true,
    US_AS_EVENT_LINKED: true,
    US_SINGLE_POST_PER_CANDLE: true,
    US_DAILY_BUY_LIMIT: dailyOk,
    US_CROSS_WON_VERIFIED: cfg.crossWonVerified,   // 실측확인 전 false → 타통화+원화 경로 BUY 하드차단
  };
  // 실전 준비 = 안전장치 전부 true + 수동취소 모드(자동취소 미확인이므로) + 일일제한 OK + 타통화+원화 필드 실측확인.
  const READY = base.MANUAL_CANCEL_MODE && !base.AUTO_CANCEL_MODE
    && base.US_ORDER_POST_IDEMPOTENT && base.US_CASH_ONLY_GATE && base.US_PENDING_REORDER_BLOCKED
    && base.US_RESTART_RECONCILIATION && base.US_AS_EVENT_LINKED && base.US_SINGLE_POST_PER_CANDLE
    && base.US_DAILY_BUY_LIMIT && base.US_CROSS_WON_VERIFIED;
  return { ...base, US_LIVE_READY: READY };
}

export function formatUSP0Checklist(c: USP0Checklist): string {
  return Object.entries(c).map(([k, v]) => `${k}=${v}`).join('\n');
}
