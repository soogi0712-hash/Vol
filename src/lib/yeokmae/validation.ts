// 역매공파 실전 활성화 검증 게이트 (P0-35) — ⚠️ HTS 1:1 대조 완료 전 절대 활성화 금지.
//   원본 수식 무변경. semantics 4종을 HTS 실측 화살표와 대조·확정하기 전까지 DEFAULT 유지(한 종목 튜닝 금지).
import { DEFAULT_SEMANTICS, type YeokmaeSemantics } from './types';

export type SemanticsVerifyStatus = 'UNVERIFIED' | 'CONFIRMED';
export interface YeokmaeSemanticsVerification {
  shiftDir: SemanticsVerifyStatus;
  stddevPopulation: SemanticsVerifyStatus;
  ichimokuDisplaced: SemanticsVerifyStatus;
  emaSeed: SemanticsVerifyStatus;
}

// 현재 상태 — 4종 전부 UNVERIFIED. HTS 대조로 확정되면 CONFIRMED 로 교체.
export const YEOKMAE_SEMANTICS_STATUS: YeokmaeSemanticsVerification = {
  shiftDir: 'UNVERIFIED', stddevPopulation: 'UNVERIFIED', ichimokuDisplaced: 'UNVERIFIED', emaSeed: 'UNVERIFIED',
};

// ⚠️ 4종 전부 CONFIRMED + 최소 N개 종목 재현 확인 전까지 절대 true 금지(코드상수).
export const YEOKMAE_SEMANTICS_VERIFIED = false;

// HTS 확정 전까지 DEFAULT 유지 — 확정 시 이 값 + STATUS + VERIFIED 를 '함께' 교체(한 종목 튜닝 금지).
export const YEOKMAE_CONFIRMED_SEMANTICS: YeokmaeSemantics = DEFAULT_SEMANTICS;

// rule 4: 최소 2~3개 실제 신호 종목에서 동일 semantics 재현 확인.
export const YEOKMAE_MIN_VERIFIED_SYMBOLS = 2;

export interface YeokmaeActivationInput {
  semanticsVerified: boolean;        // 4종 전부 CONFIRMED?
  verifiedSignalSymbols: number;     // HTS 로 1:1 대조 성공한 실신호 종목수(사람 확인 입력)
}
export interface YeokmaeActivationReadiness { canActivate: boolean; reasons: string[] }

// 활성화(코드상수 YEOKMAE_STRATEGY_VALIDATED=true 전환) 가능 여부 — 전부 충족해야 canActivate.
export function yeokmaeActivationReadiness(p: YeokmaeActivationInput): YeokmaeActivationReadiness {
  const reasons: string[] = [];
  if (!p.semanticsVerified) reasons.push('SEMANTICS_UNVERIFIED');
  if (allConfirmed(YEOKMAE_SEMANTICS_STATUS) !== true) reasons.push('SEMANTICS_STATUS_NOT_ALL_CONFIRMED');
  if (p.verifiedSignalSymbols < YEOKMAE_MIN_VERIFIED_SYMBOLS) reasons.push(`NEED_>=${YEOKMAE_MIN_VERIFIED_SYMBOLS}_HTS_VERIFIED_SYMBOLS(have=${p.verifiedSignalSymbols})`);
  return { canActivate: reasons.length === 0, reasons };
}
export function allConfirmed(v: YeokmaeSemanticsVerification): boolean {
  return v.shiftDir === 'CONFIRMED' && v.stddevPopulation === 'CONFIRMED' && v.ichimokuDisplaced === 'CONFIRMED' && v.emaSeed === 'CONFIRMED';
}
