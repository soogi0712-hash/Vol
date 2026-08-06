/**
 * LS증권 Open API 호출부 (Phase 1: 토큰 발급 + 국내/해외 잔고 조회)
 * ──────────────────────────────────────────────────────────────
 * 출처: LS증권 공식 Open API (https://openapi.ls-sec.co.kr) 문서/스펙.
 *  - 토큰:            POST /oauth2/token  (x-www-form-urlencoded, scope=oob)
 *  - 국내 잔고:       CSPAQ12200 "현물계좌예수금 주문가능금액 총평가 조회"  /stock/accno
 *  - 해외 종합잔고:   COSOQ00201 "해외주식 종합잔고평가 API"               /overseas-stock/accno
 * 공통 응답 성공코드: rsp_cd === "00000". 블록은 최상위 키(<TR>OutBlockN).
 *
 * ※ 전략/주문/스케줄러/D1/UI 는 이 파일에서 다루지 않는다(Phase 1 관찰 전용).
 */

const LS_BASE = 'https://openapi.ls-sec.co.kr:8080';

export interface LSConfig {
  appKey: string;
  appSecret: string;
  accountNo?: string;       // 마스킹 표시용(요청 본문 불필요 — 토큰에 계좌 귀속)
  accountSuffix?: string;
}

interface LSTokenCache { access_token: string; expires_at: number; }
let _lsMemToken: LSTokenCache | null = null;

const toNum = (v: unknown): number => {
  const n = parseFloat(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
};

/**
 * 접근토큰 발급. POST /oauth2/token (application/x-www-form-urlencoded)
 *   body: grant_type=client_credentials, appkey, appsecretkey, scope=oob
 *   resp: { access_token, token_type, expires_in, scope }
 * 유효기간은 익일 07:00 까지(문서). expires_in 을 그대로 캐시 TTL 로 사용.
 */
export async function getLSAccessToken(cfg: LSConfig, kv?: KVNamespace): Promise<string> {
  const now = Date.now();
  if (kv) {
    const cached = await kv.get('ls_token_v1');
    if (cached) {
      const t = JSON.parse(cached) as LSTokenCache;
      if (t.expires_at > now + 60_000) return t.access_token;
    }
  } else if (_lsMemToken && _lsMemToken.expires_at > now + 60_000) {
    return _lsMemToken.access_token;
  }

  const body = new URLSearchParams({
    appkey: cfg.appKey,
    appsecretkey: cfg.appSecret,
    grant_type: 'client_credentials',
    scope: 'oob',
  });
  const res = await fetch(`${LS_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`LS Token Error ${res.status}: ${await res.text()}`);
  const d = await res.json() as { access_token?: string; expires_in?: number };
  if (!d.access_token) throw new Error('LS Token: access_token 없음');
  const ttl = d.expires_in && d.expires_in > 0 ? d.expires_in : 86400;
  const obj: LSTokenCache = { access_token: d.access_token, expires_at: now + (ttl - 60) * 1000 };
  if (kv) await kv.put('ls_token_v1', JSON.stringify(obj), { expirationTtl: ttl - 60 });
  else _lsMemToken = obj;
  return d.access_token;
}

// LS REST 공통 헤더 (tr_cont='N' 단건 조회)
function lsHeaders(token: string, trCd: string): Record<string, string> {
  return {
    'content-type': 'application/json; charset=UTF-8',
    'authorization': `Bearer ${token}`,
    'tr_cd': trCd,
    'tr_cont': 'N',
    'tr_cont_key': '',
  };
}

/**
 * TR별 "정상 처리" rsp_cd 허용목록. rsp_cd 는 메시지 문자열이 아니라 이 목록으로 판정한다.
 * 여기에 없는 코드만 실패로 간주해 throw 한다.
 *   CSPAQ12200: 00000 정상 / 00136 "조회가 완료되었습니다."
 *   COSOQ00201: 00000 정상 / 02679 "조회내역이 없습니다."(빈 잔고 = 정상)
 */
export const LS_SUCCESS_CODES: Record<string, string[]> = {
  CSPAQ12200: ['00000', '00136'],
  COSOQ00201: ['00000', '02679'],
};
/** 정상이나 데이터가 없는(빈 결과) 코드 — 잔고 0 으로 처리한다. */
export const LS_EMPTY_CODES: Record<string, string[]> = {
  COSOQ00201: ['02679'],
};

export interface LSResult { data: any; rspCd: string; rspMsg: string; empty: boolean; }

// LS REST 공통 POST. rsp_cd 를 즉시 throw 하지 않고 블록을 파싱한다.
// TR별 허용목록(LS_SUCCESS_CODES)에 없는 rsp_cd 또는 HTTP 4xx/5xx 만 실패로 throw.
async function lsPost(token: string, path: string, trCd: string, inBlock: Record<string, unknown>): Promise<LSResult> {
  const res = await fetch(`${LS_BASE}${path}`, {
    method: 'POST',
    headers: lsHeaders(token, trCd),
    body: JSON.stringify(inBlock),
  });
  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`LS ${trCd}: 비정상 응답(HTTP ${res.status})`); }
  const rspCd = String(data.rsp_cd ?? '');
  const rspMsg = String(data.rsp_msg ?? '');
  const ok = LS_SUCCESS_CODES[trCd] ?? ['00000'];
  // rsp_cd 가 비어있으면(일부 응답) 통과, 있으면 허용목록으로 판정
  if (res.status >= 400 || (rspCd && !ok.includes(rspCd))) {
    throw new Error(`LS ${trCd} rsp_cd=${rspCd || res.status} msg=${rspMsg}`);
  }
  const empty = (LS_EMPTY_CODES[trCd] ?? []).includes(rspCd);
  return { data, rspCd, rspMsg, empty };
}

// ─── 국내 계좌 잔고 (CSPAQ12200) ──────────────────────────────
// req: { CSPAQ12200InBlock1: { BalCreTp: "1" } }
// resp OutBlock2: MnyOrdAbleAmt(주문가능현금) / DpsastTotamt(예탁자산총평가) /
//                 BalEvalAmt(잔고평가) / Dps(예수금).  OutBlock1: AcntNo(계좌번호 에코)
export interface LSKRBalance {
  orderableCash: number;   // 현금 주문가능금액
  totalEval: number;       // 예탁자산 총평가금액
  balEval: number;         // 잔고(보유주식) 평가금액
  deposit: number;         // 예수금
  accountNo: string | null;
  rspCd: string;
  raw: { OutBlock1: any; OutBlock2: any };   // 진단용(호출측이 민감필드 제거 후 로깅)
}
export async function getLSKRBalance(cfg: LSConfig, token: string): Promise<LSKRBalance> {
  const { data, rspCd } = await lsPost(token, '/stock/accno', 'CSPAQ12200', { CSPAQ12200InBlock1: { BalCreTp: '1' } });
  const o1 = data.CSPAQ12200OutBlock1 || {};
  const o2 = data.CSPAQ12200OutBlock2 || {};
  return {
    orderableCash: toNum(o2.MnyOrdAbleAmt),
    totalEval: toNum(o2.DpsastTotamt),
    balEval: toNum(o2.BalEvalAmt),
    deposit: toNum(o2.Dps),
    accountNo: o1.AcntNo ?? null,
    rspCd,
    raw: { OutBlock1: o1, OutBlock2: o2 },
  };
}

// ─── 해외 종합잔고평가 (COSOQ00201) ───────────────────────────
// req: { COSOQ00201InBlock1: { RecCnt:1, BaseDt:"YYYYMMDD", CrcyCode:"ALL", AstkBalTpCode:"00" } }
// resp OutBlock2: WonEvalSumAmt(원화평가합계=총평가 원화환산) / WonDpsBalAmt(원화예수금).
//      OutBlock1: AcntNo(계좌번호 에코)
export interface LSUSBalance {
  totalEvalKRW: number;    // 원화환산 총평가금액 (빈 결과면 0)
  wonDeposit: number;      // 원화예수금
  accountNo: string | null;
  rspCd: string;
  empty: boolean;          // 02679 등 조회내역 없음(잔고 0)
}
export async function getLSUSBalance(cfg: LSConfig, token: string, baseDateYYYYMMDD: string): Promise<LSUSBalance> {
  const { data, rspCd, empty } = await lsPost(token, '/overseas-stock/accno', 'COSOQ00201', {
    COSOQ00201InBlock1: { RecCnt: 1, BaseDt: baseDateYYYYMMDD, CrcyCode: 'ALL', AstkBalTpCode: '00' },
  });
  const o1 = data.COSOQ00201OutBlock1 || {};
  const o2 = data.COSOQ00201OutBlock2 || {};
  // 빈 결과(02679)는 잔고 0 인 정상 응답으로 처리
  return {
    totalEvalKRW: empty ? 0 : toNum(o2.WonEvalSumAmt),
    wonDeposit: empty ? 0 : toNum(o2.WonDpsBalAmt),
    accountNo: o1.AcntNo ?? null,
    rspCd,
    empty,
  };
}
