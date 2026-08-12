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

// KR 일봉 — P0-32C probe 실측 확정. t8413(주식차트 일주월) primary(수정주가 sujung 지원).
//   OutBlock1 실측 keys: date,open,high,low,close,jdiff_vol,value,jongchk,rate,pricechk,ratevalue,sign
//   실측 rsp_cd=00000, rows=269(400일 창). 마지막 행=당일 진행봉 포함.
//   ⚠️ value(거래대금) 단위는 실측상 '백만원' 추정(close×volume ÷ value ≈ 1e6) — 단정 금지, rawTurnover 로 보존.
//     → fieldMap.turnover='value' 는 raw 보존용. 검색기 T 는 KR 에선 close×volume(원)로 계산(turnoverKRW 미단정).
export const KR_DAILY_TR: DailyTRConfig = {
  market: 'KR',
  trCode: 't8413',                 // primary(수정주가 지원). fallback=t8410(sujung 없음) — KR_DAILY_TR_ALT 참조.
  endpoint: '/stock/chart',
  fieldMap: { date: 'date', open: 'open', high: 'high', low: 'low', close: 'close', volume: 'jdiff_vol', turnover: 'value' },
  pagination: 'DATE_WINDOW',       // 실측: 한 창(sdate~edate)당 그 구간 전 영업일 반환 → edate 를 과거로 밀어 누적(kr-daily.ts). 헤더 tr_cont 도 병행 확인.
  successCodes: ['00000'],
  adjustedAvailable: true,         // t8413 sujung='Y' → 수정주가(정확성은 분할종목 대조 전까지 flag).
  maxPerPage: 700,                 // probe 에서 qrycnt=700 수용 확인(하드 상한 주장 아님 — pages probe 로 실측).
  buildInBlock: (p) => ({ t8413InBlock: { shcode: p.symbol, gubun: '2', qrycnt: 700, sdate: p.sdate, edate: p.edate, cts_date: p.cursor ?? '', comp_yn: 'N', sujung: 'Y' } }),
};
// t8410(주식종목별기간별주가) — sujung 파라미터 없음(수정주가 미지원 추정) → adjustment=UNKNOWN. 동일 구조/269행.
export const KR_DAILY_TR_ALT: DailyTRConfig = {
  market: 'KR', trCode: 't8410', endpoint: '/stock/chart',
  fieldMap: { date: 'date', open: 'open', high: 'high', low: 'low', close: 'close', volume: 'jdiff_vol', turnover: 'value' },
  pagination: 'DATE_WINDOW', successCodes: ['00000'], adjustedAvailable: false, maxPerPage: 700,
  buildInBlock: (p) => ({ t8410InBlock: { shcode: p.symbol, gubun: '2', qrycnt: 700, sdate: p.sdate, edate: p.edate, cts_date: p.cursor ?? '', comp_yn: 'N' } }),
};
// US 일봉 — 미확정 유지(봉인). P0-32C probe: g3103(gubun=0)/g3204(gubun=0) → rsp_cd=00000 이나 rows=0("해당 자료가 없습니다").
//   ⚠️ rows=0 만으로 TR 폐기 금지 — parameter 조합 미탐색. `npm run yeokmae:probe-us-daily -- AAPL` 로 조합 실측 후 rows>0 조합에서만 확정.
export const US_DAILY_TR: DailyTRConfig = {
  market: 'US', trCode: null, endpoint: null,
  fieldMap: { ...EMPTY_DAILY_FIELD_MAP },
  pagination: 'UNCONFIRMED', successCodes: null, adjustedAvailable: null, maxPerPage: null, buildInBlock: null,
};

export function dailyTRConfig(market: 'KR' | 'US'): DailyTRConfig { return market === 'KR' ? KR_DAILY_TR : US_DAILY_TR; }

// ════════════════════════════════════════════════════════════════════════════
// POST-PROBE 상태 (P0-32C)
//   KR ✅ 확정 — t8413 primary(수정주가), field map/pagination/successCodes/buildInBlock 채움.
//              `npm run yeokmae:fetch-daily -- KR <SYMBOL>` 로 실 캐시 저장 가능.
//   US ⛔ 봉인 유지 — g3103/g3204(gubun=0) rows=0. 남은 미확정:
//     · rows>0 을 내는 TR + parameter 조합(symbol 형식/exchcd/gubun enum/date range/qrycnt/keysymbol/continuation)
//     · rows>0 확인 후에만: trCode/endpoint('/overseas-stock/chart')/fieldMap/pagination/successCodes/buildInBlock 채움.
//     → `npm run yeokmae:probe-us-daily -- AAPL` 로 조합 실측(주문 없음). 임의 필드 주입 금지 — repo 확인필드만.
// ⚠️ 이 파일 외에는 파이프라인 활성화를 위해 수정할 곳이 없다(어댑터/캐시/정규화/무결성/readiness 완성).
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
