// 역매공파 실거래 연결 게이트 (P0-33) — 순수 로직. ⚠️ 실제 주문 전송 없음. 최종 게이트는 하드 OFF 유지.
//   LIVE BUY 후보 = confirmed 봉에서 5신호 중 1개+ matched=true 인 경우에만. reverse-only/near-match/provisional 은 절대 후보 아님.
//   최종 POST 허용 = liveTrading ∧ yeokmaeLive ∧ strategyValidated ∧ confirmedSignal ∧ (기존 모든 안전게이트).
//   ⚠️ 검색기 A/B/C/T 는 UNVERIFIED_EXTERNAL → live 필수조건 아님(diagnostic 로만 기록). 5화살표만 필수.
import type { YeokmaeSignalType } from './types';

// ── SELL 분리 (rule 9) — 역매공파 청산규칙 미정의. BB SELL 을 yeokmae SELL 로 오인 금지. 임의 손절/익절 추가 금지. ──
export const YEOKMAE_SELL_RULE_DEFINED = false;
// 역매공파 BUY 포지션의 청산정책: 아직 없음. BB SELL 은 BB 포지션 전용 — 전략 태그로 라우팅 분리해야 함(실행 연결 시).
export const YEOKMAE_BUY_SELL_POLICY = 'NO_YEOKMAE_SELL_RULE_YET(BB_SELL_MUST_NOT_APPLY)';

// ── LIVE 후보 객체 ──
export interface YeokmaeLiveCandidate {
  symbol: string;
  exchange: string;
  confirmedDate: string;
  matchedSignals: YeokmaeSignalType[];   // confirmed 봉에서 matched=true 인 화살표(≥1)
  searcherFormula: boolean;              // diagnostic 만(필수조건 아님)
  verifiedFailed: string[];              // 검증된 core 실패조건(diagnostic)
  unverifiedExternal: string[];          // [A,B,C,T] 미검증(diagnostic)
}

export interface YeokmaeSignalInput {
  symbol: string;
  exchange: string;
  confirmedDate: string | null;
  matchedSignals: YeokmaeSignalType[];   // CONFIRMED 봉 기준 matched 화살표
  isProvisional: boolean;                // true → 관찰 전용(후보 아님)
  searcherFormula?: boolean;
  verifiedFailed?: string[];
  unverifiedExternal?: string[];
}

// confirmed 봉 + 화살표 1개+ 일 때만 후보 생성. 그 외(provisional/화살표0/reverse-only/near-match)는 null.
export function buildYeokmaeLiveCandidate(inp: YeokmaeSignalInput): YeokmaeLiveCandidate | null {
  if (inp.isProvisional) return null;                       // rule 2: provisional 관찰 전용
  if (!inp.confirmedDate) return null;
  if (!inp.matchedSignals || inp.matchedSignals.length < 1) return null;   // rule 1/4: 화살표 0 → 후보 아님
  return {
    symbol: inp.symbol, exchange: inp.exchange, confirmedDate: inp.confirmedDate,
    matchedSignals: [...inp.matchedSignals],
    searcherFormula: !!inp.searcherFormula,
    verifiedFailed: inp.verifiedFailed ?? [],
    unverifiedExternal: inp.unverifiedExternal ?? ['A', 'B', 'C', 'T'],
  };
}

// ── 최종 LIVE 게이트 (기존 안전장치 전부 재사용 — 상태는 러너가 기존 인프라에서 주입) ──
export interface YeokmaeLiveGateInput {
  candidate: YeokmaeLiveCandidate | null;   // null → 후보 아님(즉시 차단)
  // 전략 토글
  liveTrading: boolean;          // LS_LIVE_TRADING
  yeokmaeLive: boolean;          // YEOKMAE_LIVE_TRADING
  strategyValidated: boolean;    // YEOKMAE_STRATEGY_VALIDATED (코드상수, 현재 false)
  // 기존 안전장치(주입) — 새로 만들지 않고 기존 US BUY 파이프라인 상태 재사용
  legacyBbBlocked: boolean;      // LEGACY_BB_LIVE=false 여야 함(true=차단됨=정상)
  cashOnly: boolean;             // cash-only 만족
  capitalGuardOk: boolean;       // 총자본 100만원 한도 + 실제 예수금/통합증거금 충분
  perSymbolBudgetOk: boolean;    // 종목별 예산 $60 로 최소 1주(budgetQty>=1)
  noPending: boolean;            // pending 없음
  reconciliationOk: boolean;     // reconciliation 통과
  notDuplicateOrder: boolean;    // 동일 symbol/date 중복주문 아님(idempotency)
  notSameDayReentry: boolean;    // 동일종목 당일 재진입 아님
}
export interface YeokmaeLiveGateResult {
  allowed: boolean;              // 최종 POST 허용(모든 조건 true). 현재 strategyValidated=false → 항상 false.
  reasons: string[];             // 차단 사유(통과 시 빈 배열)
  checklist: Record<string, boolean>;
}

// checklist 키 순서(로그 안정성). confirmedSignal 먼저 — 후보 아님이면 나머지 무의미.
const GATE_KEYS = [
  'confirmedSignal', 'liveTrading', 'yeokmaeLive', 'strategyValidated',
  'legacyBbBlocked', 'cashOnly', 'capitalGuardOk', 'perSymbolBudgetOk',
  'noPending', 'reconciliationOk', 'notDuplicateOrder', 'notSameDayReentry',
] as const;

export function evaluateYeokmaeLiveGate(g: YeokmaeLiveGateInput): YeokmaeLiveGateResult {
  const confirmedSignal = !!g.candidate && g.candidate.matchedSignals.length >= 1;
  const checklist: Record<string, boolean> = {
    confirmedSignal,
    liveTrading: !!g.liveTrading,
    yeokmaeLive: !!g.yeokmaeLive,
    strategyValidated: !!g.strategyValidated,
    legacyBbBlocked: !!g.legacyBbBlocked,
    cashOnly: !!g.cashOnly,
    capitalGuardOk: !!g.capitalGuardOk,
    perSymbolBudgetOk: !!g.perSymbolBudgetOk,
    noPending: !!g.noPending,
    reconciliationOk: !!g.reconciliationOk,
    notDuplicateOrder: !!g.notDuplicateOrder,
    notSameDayReentry: !!g.notSameDayReentry,
  };
  const reasons = GATE_KEYS.filter(k => !checklist[k]).map(k => `BLOCK:${k}`);
  return { allowed: reasons.length === 0, reasons, checklist };
}

// [YEOKMAE-LIVE-CHECKLIST] 한 줄 포맷.
export function formatYeokmaeLiveChecklist(r: YeokmaeLiveGateResult): string {
  return '[YEOKMAE-LIVE-CHECKLIST] ' + GATE_KEYS.map(k => `${k}=${r.checklist[k] ? '✓' : '✗'}`).join(' ')
    + ` → allowed=${r.allowed}`;
}
