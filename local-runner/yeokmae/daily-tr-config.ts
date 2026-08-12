// 역매공파 일봉 TR 설정 (P0-32B) — ⚠️ POST-PROBE 유일 채움 지점.
//   probe(npm run yeokmae:probe-daily) 로 실제 TR/필드/continuation/successCode 를 확인한 뒤 아래 null 만 채운다.
//   현재는 전부 미확정(null/UNCONFIRMED) → 어댑터가 fail-closed 로 동작(추측 하드코딩 금지).
import { EMPTY_DAILY_FIELD_MAP, type DailyFieldMap, type PaginationStrategy } from '../../src/lib/yeokmae/history';

export interface DailyTRConfig {
  market: 'KR' | 'US';
  trCode: string | null;                                  // 예: KR 't8413' / US 'g3103' (probe 확인 후)
  endpoint: '/stock/chart' | '/overseas-stock/chart' | null;
  fieldMap: DailyFieldMap;                                // OutBlock1 필드명(probe 확인 후)
  pagination: PaginationStrategy;                          // continuation 전략(probe 확인 후 하나만)
  successCodes: string[] | null;                          // 정상 rsp_cd(probe 확인 후)
  adjustedAvailable: boolean | null;                      // 수정주가 옵션 존재/기본값(probe 확인 후)
  maxPerPage: number | null;                              // 1회 최대 취득건수(probe 확인 후)
  // InBlock 빌더는 필드가 확정된 뒤 구현(현재 null → fail-closed). (date window/커서 인자 포함)
  buildInBlock: ((p: { symbol: string; exchcd?: string; sdate: string; edate: string; cursor?: string; delaygb?: string }) => Record<string, unknown>) | null;
}

// KR 일봉 — 후보 t8410/t8413(미확정). probe 후 확정.
export const KR_DAILY_TR: DailyTRConfig = {
  market: 'KR', trCode: null, endpoint: null,
  fieldMap: { ...EMPTY_DAILY_FIELD_MAP },
  pagination: 'UNCONFIRMED', successCodes: null, adjustedAvailable: null, maxPerPage: null, buildInBlock: null,
};
// US 일봉 — 후보 g3103/g3204(미확정). probe 후 확정.
export const US_DAILY_TR: DailyTRConfig = {
  market: 'US', trCode: null, endpoint: null,
  fieldMap: { ...EMPTY_DAILY_FIELD_MAP },
  pagination: 'UNCONFIRMED', successCodes: null, adjustedAvailable: null, maxPerPage: null, buildInBlock: null,
};

export function dailyTRConfig(market: 'KR' | 'US'): DailyTRConfig { return market === 'KR' ? KR_DAILY_TR : US_DAILY_TR; }

// ════════════════════════════════════════════════════════════════════════════
// POST-PROBE TODO — 실계정에서 `npm run yeokmae:probe-daily` 실행 후 아래만 채우면 파이프라인 활성.
// (probe 는 KR t8410/t8413 · US g3103/g3204 후보의 OutBlock1 원문 필드/샘플행을 그대로 덤프한다. 추측 금지.)
//
//   1) trCode        ← probe 로 실제 일봉 TR 확정 (KR 예: 't8413' 일별주가 / US 예: 'g3103').
//   2) endpoint      ← KR '/stock/chart' · US '/overseas-stock/chart'.
//   3) fieldMap      ← OutBlock1 실제 키명으로 date/open/high/low/close/volume(+turnover) 매핑.
//                       (예: KR t8413 → { date:'date', open:'open', high:'high', low:'low', close:'close', volume:'jdiff_vol', turnover:'value' } — probe 로 확인)
//   4) pagination    ← 연속조회 방식 하나 확정: HEADER_CONT(tr_cont 헤더) / BODY_CURSOR(cts_date 등 본문커서)
//                       / DATE_WINDOW(날짜창 이동) / FIXED_PAGE(1페이지) / NONE. UNCONFIRMED 는 fail-closed.
//   5) successCodes  ← 정상 rsp_cd 목록 (예: ['00000']). probe 응답 header 로 확인.
//   6) adjustedAvailable ← 수정주가 옵션 존재/기본값 (InBlock 에 수정주가 플래그가 있으면 true).
//   7) maxPerPage    ← 1회 최대 취득건수(연속조회 계획용).
//   8) buildInBlock  ← InBlock 빌더. probe 로 확인한 실제 InBlock 필드명 사용
//                       (KR 예: { shcode, gubun:'2'(일), sdate, edate, cts_date: cursor } — 실제명은 probe 우선).
//
// 채운 뒤: `npm run yeokmae:diag-cache -- <SYMBOL> [KR|US]` 로 캐시/무결성/readiness 확인,
//         `npm run yeokmae:batch-diag` / `yeokmae:semantics-grid` 로 대량/의미 대조.
// ⚠️ 이 파일 외에는 파이프라인 활성화를 위해 수정할 곳이 없다(어댑터/캐시/정규화/무결성/readiness 는 완성).
// ⚠️ 실주문 게이트(YEOKMAE_STRATEGY_VALIDATED=false)는 이 작업과 무관하게 그대로 OFF 유지.
// ════════════════════════════════════════════════════════════════════════════

// 설정이 실취득 가능 상태인지(전부 확정) — 하나라도 미확정이면 false(fail-closed).
export function isDailyTRReady(cfg: DailyTRConfig): { ready: boolean; reason: string } {
  if (!cfg.trCode || !cfg.endpoint) return { ready: false, reason: 'DAILY_TR_UNCONFIRMED' };
  if (cfg.pagination === 'UNCONFIRMED') return { ready: false, reason: 'PAGINATION_STRATEGY_UNCONFIRMED' };
  if (!cfg.successCodes || cfg.successCodes.length === 0) return { ready: false, reason: 'SUCCESS_CODE_UNCONFIRMED' };
  if (!cfg.buildInBlock) return { ready: false, reason: 'INBLOCK_BUILDER_UNCONFIRMED' };
  // fieldMap 확정 여부는 normalizeDailyRows 가 재확인(DAILY_FIELD_MAP_UNCONFIRMED)
  return { ready: true, reason: 'OK' };
}
