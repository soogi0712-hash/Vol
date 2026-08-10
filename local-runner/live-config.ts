// Phase 3A 실전 설정 — 환경변수에서 읽는다. 오늘 실전 제한을 코드로 강제한다.
//   지정가만, 하루 매수/매도 각 1회. 주문수량은 P0-29A 로 1회 거래예산(LS_US_PER_TRADE_BUDGET_USD)
//   기반 정수주 계산으로 전환(테스트 maxQty=1 하드제한 해제). 예산 미설정 시 fail-closed(주문 금지).
// ⚠️ 자동취소 REST(COSAT00311)는 공식 필드 미확인 → AUTO_CANCEL_MODE 불가.
//    대신 MANUAL_CANCEL_MODE(수동취소)로 운영: 미체결 시 사용자 수동취소 요구, AS3 수신 시에만 다음 BUY.
import { toLSOverseasExchcd, LS_CANCEL_TR_CONFIRMED, LS_US_CROSS_WON_TR_CONFIRMED, CROSS_WON_ADOPTED_FIELD } from '../src/lib/ls-api';

export interface LiveConfig {
  liveSymbol: string;          // 'AAPL'
  liveExchange: string;        // 'NASDAQ'
  liveExchcd: string;          // '82'
  maxQty: number | null;       // 선택적 안전 상한(주수). 미설정=null → 예산이 상한을 결정(P0-29A, 하드1 제거)
  perTradeBudgetUsd: number | null;  // LS_US_PER_TRADE_BUDGET_USD — 1회 거래예산(USD). 미설정=null → fail-closed
  dailyMaxBuys: number;        // 1
  dailyMaxSells: number;       // 1
  armed: boolean;              // LS_TRADING_ARMED
  liveTrading: boolean;        // LS_LIVE_TRADING
  cancelConfirmed: boolean;    // LS_CANCEL_TR_CONFIRMED (env)
  autoCancel: boolean;         // 자동취소 모드 — env AND 코드상수(취소TR 확인). 현재 항상 false.
  manualCancel: boolean;       // 수동취소 모드 — autoCancel 아니면 true(오늘 운영 모드).
  pendingTimeoutSec: number;   // (auto 모드에서만) 미체결 취소까지 대기 시간(초)
  htsOrderableQty: number | null;  // LS_US_HTS_ORDERABLE_QTY — 참고용 관찰값(불일치 시 차단만, 허용 근거 아님). 미설정=null.
  crossWonVerified: boolean;   // 타통화+원화(통합증거금/선환전) 경로 실측확인 — env AND 코드상수. 현재 항상 false → 해당 경로 LIVE 하드차단.
}

const intEnv = (name: string, def: number, min: number, max: number): number => {
  const n = parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
};

// LS_US_LIVE_SYMBOL="NASDAQ:AAPL" 파싱. 거래소 미확인이면 예외(추측 금지).
export function loadLiveConfig(): LiveConfig {
  const raw = (process.env.LS_US_LIVE_SYMBOL || 'NASDAQ:AAPL').trim();
  const [exRaw, symRaw] = raw.includes(':') ? raw.split(':') : ['NASDAQ', raw];
  const liveExchange = (exRaw || 'NASDAQ').trim().toUpperCase();
  const liveSymbol = (symRaw || '').trim().toUpperCase();
  const liveExchcd = toLSOverseasExchcd(liveExchange) ?? '';
  if (!liveSymbol || !liveExchcd) throw new Error(`LS_US_LIVE_SYMBOL 파싱 실패/거래소 미확인: '${raw}'`);
  const autoCancel = process.env.LS_AUTO_CANCEL_MODE === 'true' && LS_CANCEL_TR_CONFIRMED;   // 코드상수 false → 항상 false
  return {
    liveSymbol, liveExchange, liveExchcd,
    // 선택적 안전 상한(주수). 미설정=null → 1회 거래예산이 상한을 결정(P0-29A: maxQty=1 하드제한 제거).
    maxQty: (() => { const v = process.env.LS_US_MAX_QTY; if (v == null || v.trim() === '') return null; const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; })(),
    // 1회 거래예산(USD). 미설정/비정상(<=0) → null → 주문 fail-closed(전량매수 방지의 핵심).
    perTradeBudgetUsd: (() => { const v = process.env.LS_US_PER_TRADE_BUDGET_USD; if (v == null || v.trim() === '') return null; const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; })(),
    dailyMaxBuys: intEnv('LS_US_DAILY_MAX_BUYS', 1, 0, 1),  // 오늘은 최대 1(하루 BUY 1회 유지)
    dailyMaxSells: intEnv('LS_US_DAILY_MAX_SELLS', 1, 0, 1),
    armed: process.env.LS_TRADING_ARMED === 'true',
    liveTrading: process.env.LS_LIVE_TRADING === 'true',
    cancelConfirmed: process.env.LS_CANCEL_TR_CONFIRMED === 'true',
    // 자동취소는 env 요청 AND 코드상수(공식 취소필드 확인)여야 가능. 코드상수 false → 항상 false → 수동취소 모드.
    autoCancel,
    manualCancel: !autoCancel,
    pendingTimeoutSec: intEnv('LS_US_PENDING_TIMEOUT_SEC', 60, 5, 600),
    // HTS 관찰값(참고용) — 설정 시 프로그램 계산값과 불일치하면 차단(안전방향). 허용의 근거로는 쓰지 않는다.
    htsOrderableQty: (() => { const v = process.env.LS_US_HTS_ORDERABLE_QTY; if (v == null || v.trim() === '') return null; const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(0, n) : null; })(),
    // 타통화+원화 경로 실측확인(P0-20 완료) — 코드상수(공식 필드 확정) AND 채택필드 지정 시 true.
    //   안전 kill-switch: env LS_US_CROSS_WON_VERIFIED='false' 로 강제 비활성 가능.
    crossWonVerified: LS_US_CROSS_WON_TR_CONFIRMED && CROSS_WON_ADOPTED_FIELD != null && process.env.LS_US_CROSS_WON_VERIFIED !== 'false',
  };
}

// 이 종목이 오늘 실전 대상인가(1종목만 허용).
export function isLiveSymbol(cfg: LiveConfig, symbol: string): boolean {
  return symbol.toUpperCase() === cfg.liveSymbol;
}
