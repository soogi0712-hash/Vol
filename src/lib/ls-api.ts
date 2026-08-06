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

// 오류 분류 — 데이터 부족/빈 응답/호출 제한/네트워크/일반 API 를 구분해서 기록한다.
export type LSErrorKind = 'NETWORK' | 'RATE_LIMIT' | 'API' | 'EMPTY' | 'INSUFFICIENT';
export class LSApiError extends Error {
  kind: LSErrorKind;
  rspCd?: string;
  constructor(kind: LSErrorKind, message: string, rspCd?: string) {
    super(message);
    this.name = 'LSApiError';
    this.kind = kind;
    this.rspCd = rspCd;
  }
}

// LS REST 공통 POST. rsp_cd 를 즉시 throw 하지 않고 블록을 파싱한다.
// TR별 허용목록(LS_SUCCESS_CODES)에 없는 rsp_cd 만 실패. 네트워크/호출제한을 분류.
async function lsPost(token: string, path: string, trCd: string, inBlock: Record<string, unknown>): Promise<LSResult> {
  let res: Response;
  try {
    res = await fetch(`${LS_BASE}${path}`, {
      method: 'POST',
      headers: lsHeaders(token, trCd),
      body: JSON.stringify(inBlock),
    });
  } catch (e) {
    throw new LSApiError('NETWORK', `LS ${trCd} 네트워크 오류: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 429) throw new LSApiError('RATE_LIMIT', `LS ${trCd} 호출 제한(HTTP 429)`);
  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new LSApiError('API', `LS ${trCd}: 비정상 응답(HTTP ${res.status})`); }
  const rspCd = String(data.rsp_cd ?? '');
  const rspMsg = String(data.rsp_msg ?? '');
  const ok = LS_SUCCESS_CODES[trCd] ?? ['00000'];
  if (res.status >= 400 || (rspCd && !ok.includes(rspCd))) {
    // LS 호출제한 코드도 RATE_LIMIT 로 분류(메시지에 '초과/제한' 포함 시)
    const kind: LSErrorKind = /제한|초과|traffic|quota/i.test(rspMsg) ? 'RATE_LIMIT' : 'API';
    throw new LSApiError(kind, `LS ${trCd} rsp_cd=${rspCd || res.status} msg=${rspMsg}`, rspCd);
  }
  const empty = (LS_EMPTY_CODES[trCd] ?? []).includes(rspCd);
  return { data, rspCd, rspMsg, empty };
}

// ── 해외 거래소코드(exchcd) — LS 공식 확인분만 명시 관리 ──────
// 확인: 82=NASDAQ(공식 reqExample), 81=NYSE(공식 예제). AMEX 등은 미확인 → 매핑 안 함(추측 금지).
export const LS_OVERSEAS_EXCHCD: Record<string, string> = {
  NASDAQ: '82', NASD: '82', NAS: '82',
  NYSE: '81', NYS: '81',
};
/** 거래소명 → LS exchcd. 미확인 거래소는 null (호출측이 UNSUPPORTED 처리). */
export function toLSOverseasExchcd(name: string): string | null {
  return LS_OVERSEAS_EXCHCD[(name || '').toUpperCase()] ?? null;
}

export interface LSCandle { datetime: string; open: number; high: number; low: number; close: number; volume: number; }
export interface LSPrice { price: number; open: number; high: number; low: number; volume: number; }

// 오름차순 정렬 후 마지막(형성 중) 봉 1개 제외 → 확정봉만 반환.
function toConfirmed(candles: LSCandle[]): LSCandle[] {
  const sorted = [...candles].sort((a, b) => a.datetime.localeCompare(b.datetime));
  return sorted.length > 1 ? sorted.slice(0, -1) : sorted;
}

// ── 국내 현재가 (t1102) ──────────────────────────────────────
export async function getLSKRPrice(cfg: LSConfig, token: string, shcode: string): Promise<LSPrice> {
  const { data } = await lsPost(token, '/stock/market-data', 't1102', { t1102InBlock: { shcode } });
  const o = data.t1102OutBlock || {};
  return { price: toNum(o.price), open: toNum(o.open), high: toNum(o.high), low: toNum(o.low), volume: toNum(o.volume) };
}

// ── 해외 현재가 (g3101) — keysymbol = exchcd + symbol ────────
export async function getLSUSPrice(cfg: LSConfig, token: string, symbol: string, exchcd: string): Promise<LSPrice> {
  const { data } = await lsPost(token, '/overseas-stock/market-data', 'g3101', {
    g3101InBlock: { delaygb: 'R', keysymbol: exchcd + symbol, exchcd, symbol },
  });
  const o = data.g3101OutBlock || {};
  return { price: toNum(o.price), open: toNum(o.open), high: toNum(o.high), low: toNum(o.low), volume: toNum(o.volume) };
}

// ── 국내 15분봉 (t8412, ncnt=15) — OutBlock1: date/time/open/high/low/close/jdiff_vol ──
// 반환: 확정봉(형성 중 마지막 봉 제외), 오름차순. 빈 응답이면 [].
export async function getLSKR15Min(cfg: LSConfig, token: string, shcode: string, qrycnt = 60): Promise<LSCandle[]> {
  const { data } = await lsPost(token, '/stock/chart', 't8412', {
    // 공식 reqExample 필드 유지, ncnt(분)=15 / qrycnt(요청개수)만 조정. edate=99999999=최근.
    t8412InBlock: { shcode, ncnt: 15, qrycnt, nday: '0', sdate: '', stime: '', edate: '99999999', etime: '', cts_date: '', cts_time: '', comp_yn: 'N' },
  });
  const rows: any[] = data.t8412OutBlock1 || [];
  const candles: LSCandle[] = rows.map(r => ({
    datetime: String(r.date) + String(r.time).padStart(6, '0'),
    open: toNum(r.open), high: toNum(r.high), low: toNum(r.low), close: toNum(r.close), volume: toNum(r.jdiff_vol),
  }));
  return toConfirmed(candles);
}

// ── 해외 15분봉 (g3203, ncnt=15) — OutBlock1: date/loctime/open/high/low/close/exevol ──
export async function getLSUS15Min(cfg: LSConfig, token: string, symbol: string, exchcd: string, sdateYYYYMMDD: string, qrycnt = 100): Promise<LSCandle[]> {
  const { data } = await lsPost(token, '/overseas-stock/chart', 'g3203', {
    // 공식 reqExample 필드 유지, ncnt(분)=15. sdate~edate 범위 내 최근 qrycnt.
    g3203InBlock: { delaygb: 'R', keysymbol: exchcd + symbol, exchcd, symbol, ncnt: 15, qrycnt, comp_yn: 'N', sdate: sdateYYYYMMDD, edate: '' },
  });
  const rows: any[] = data.g3203OutBlock1 || [];
  const candles: LSCandle[] = rows.map(r => ({
    datetime: String(r.date) + String(r.loctime).padStart(6, '0'),
    open: toNum(r.open), high: toNum(r.high), low: toNum(r.low), close: toNum(r.close), volume: toNum(r.exevol),
  }));
  return toConfirmed(candles);
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
