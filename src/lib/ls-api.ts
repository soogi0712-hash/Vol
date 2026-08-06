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
  // 토큰 발급도 공용 limiter 로 직렬화(req 4)
  const res = await runLimited(() => fetch(`${LS_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }));
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

export interface LSResult { data: any; rspCd: string; rspMsg: string; empty: boolean; diag: LSHttpDiag; }

// HTTP 원문 진단 (JSON 파싱 전 캡처) — 요청/응답 메타. textHead 는 호출측이 마스킹해 로깅.
export interface LSHttpDiag {
  reqHeaders: { tr_cd: string; tr_cont: string; tr_cont_key: string; content_type: string };
  status: number;
  statusText: string;
  contentType: string;      // 응답 content-type
  trCont: string;           // 응답 tr_cont 헤더
  trContKey: string;        // 응답 tr_cont_key 헤더
  textLen: number;
  textHead: string;         // raw 본문 앞 1000자 (미마스킹 — 호출측이 scrub 후 로깅)
}

// 오류 분류 — 데이터부족/빈응답/호출제한/네트워크/무효응답/일반 API 를 구분해서 기록한다.
export type LSErrorKind = 'NETWORK' | 'RATE_LIMIT' | 'API' | 'EMPTY' | 'INSUFFICIENT' | 'INVALID_RESPONSE';
export class LSApiError extends Error {
  kind: LSErrorKind;
  rspCd?: string;
  diag?: LSHttpDiag;
  constructor(kind: LSErrorKind, message: string, rspCd?: string, diag?: LSHttpDiag) {
    super(message);
    this.name = 'LSApiError';
    this.kind = kind;
    this.rspCd = rspCd;
    this.diag = diag;
  }
}

// LS 호출제한 rsp_cd (초당/건수 초과). IGW00201 = 유량초과(거래건수 초과).
export const LS_RATE_LIMIT_CODES = new Set(['IGW00201', 'IGW00121']);
export function isLSRateLimited(e: unknown): boolean {
  return e instanceof LSApiError && e.kind === 'RATE_LIMIT';
}

// ── 공용 RateLimiter — 모든 LS REST 호출을 하나로 직렬화 + 최소간격 + IGW00201 재시도 ──
// 토큰/현재가/차트/잔고가 이 limiter 를 공유한다(req 1·2·4). 테스트는 configure 로 무지연화.
interface LSLimiterState {
  minIntervalMs: number;
  maxRetries: number;
  backoffMs: number[];
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}
let _lim: LSLimiterState = {
  minIntervalMs: 1100,               // 기본 1초 이상 (안전)
  maxRetries: 2,                     // IGW00201 최대 2회 재시도
  backoffMs: [1500, 3000],           // 1차 1.5s, 2차 3s
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};
let _chain: Promise<unknown> = Promise.resolve();
let _lastAt = 0;
/** 테스트/운영 튜닝용 — 공용 limiter 재설정. */
export function configureLSRateLimiter(opts: Partial<LSLimiterState>): void {
  _lim = { ..._lim, ...opts };
}
// 직렬 실행(chain) + 최소간격 대기 + rate-limit 재시도.
async function runLimited<T>(op: () => Promise<T>): Promise<T> {
  const exec = async (): Promise<T> => {
    const wait = _lim.minIntervalMs - (_lim.now() - _lastAt);
    if (wait > 0) await _lim.sleep(wait);
    let attempt = 0;
    for (;;) {
      try { const r = await op(); _lastAt = _lim.now(); return r; }
      catch (e) {
        _lastAt = _lim.now();
        if (isLSRateLimited(e) && attempt < _lim.maxRetries) {
          await _lim.sleep(_lim.backoffMs[attempt] ?? _lim.backoffMs[_lim.backoffMs.length - 1] ?? 1500);
          attempt++;
          continue;
        }
        throw e;
      }
    }
  };
  const p = _chain.then(exec, exec);
  _chain = p.then(() => undefined, () => undefined);
  return p;
}

// LS REST 공통 POST. rsp_cd 를 즉시 throw 하지 않고 블록을 파싱한다.
// TR별 허용목록(LS_SUCCESS_CODES)에 없는 rsp_cd 만 실패. 네트워크/호출제한을 분류.
// 전체 동작을 runLimited 로 감싸 직렬화 + IGW00201 재시도를 적용한다.
async function lsPost(token: string, path: string, trCd: string, inBlock: Record<string, unknown>): Promise<LSResult> {
  const reqHeaders = { tr_cd: trCd, tr_cont: 'N', tr_cont_key: '', content_type: 'application/json; charset=UTF-8' };
  return runLimited(async () => {
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
    // JSON 파싱 전에 HTTP 원문 진단을 캡처(req 1)
    const text = await res.text();
    const diag: LSHttpDiag = {
      reqHeaders,
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get('content-type') || '',
      trCont: res.headers.get('tr_cont') || '',
      trContKey: res.headers.get('tr_cont_key') || '',
      textLen: text.length,
      textHead: text.slice(0, 1000),
    };
    if (res.status === 429) throw new LSApiError('RATE_LIMIT', `LS ${trCd} 호출 제한(HTTP 429)`, undefined, diag);
    // HTTP 200 이어도 본문이 비면 성공 처리 금지(req 3)
    if (!text.trim()) throw new LSApiError('INVALID_RESPONSE', `LS ${trCd}: 빈 응답 본문(HTTP ${res.status})`, undefined, diag);
    let data: any;
    try { data = JSON.parse(text); }
    catch { throw new LSApiError('INVALID_RESPONSE', `LS ${trCd}: JSON 아님(HTTP ${res.status})`, undefined, diag); }
    const rspCd = String(data.rsp_cd ?? '');
    const rspMsg = String(data.rsp_msg ?? '');
    const ok = LS_SUCCESS_CODES[trCd] ?? ['00000'];
    if (res.status >= 400 || (rspCd && !ok.includes(rspCd))) {
      const rl = LS_RATE_LIMIT_CODES.has(rspCd) || /제한|초과|traffic|quota/i.test(rspMsg);
      throw new LSApiError(rl ? 'RATE_LIMIT' : 'API', `LS ${trCd} rsp_cd=${rspCd || res.status} msg=${rspMsg}`, rspCd, diag);
    }
    const empty = (LS_EMPTY_CODES[trCd] ?? []).includes(rspCd);
    return { data, rspCd, rspMsg, empty, diag };
  });
}

// ── 해외 거래소코드(exchcd) — LS 공식 확인분 ──────────────────
// 82=NASDAQ(공식 reqExample), 81=NYSE/AMEX(공식 GSH reqExample: "81SOXL"). ARCA 계열도 81.
export const LS_OVERSEAS_EXCHCD: Record<string, string> = {
  NASDAQ: '82', NASD: '82', NAS: '82',
  NYSE: '81', NYS: '81',
  AMEX: '81', AMS: '81', ARCA: '81',
};
/** 거래소명 → LS exchcd. 미확인 거래소는 null (호출측이 UNSUPPORTED 처리). */
export function toLSOverseasExchcd(name: string): string | null {
  return LS_OVERSEAS_EXCHCD[(name || '').toUpperCase()] ?? null;
}

export interface LSCandle { datetime: string; open: number; high: number; low: number; close: number; volume: number; }
export interface LSPrice { price: number; open: number; high: number; low: number; volume: number; diag: LSHttpDiag; }

// 현재가 유효성(req 3·4·5): OutBlock·rsp_cd 모두 없으면 INVALID_RESPONSE, price<=0 이면 EMPTY.
function parseLSPrice(trCd: string, res: LSResult, outBlockName: string): LSPrice {
  const o = res.data?.[outBlockName];
  if ((o === undefined || o === null) && !res.rspCd) {
    throw new LSApiError('INVALID_RESPONSE', `LS ${trCd}: rsp_cd·${outBlockName} 모두 없음`, res.rspCd || undefined, res.diag);
  }
  const price = toNum(o?.price);
  if (!(price > 0)) {
    throw new LSApiError('EMPTY', `LS ${trCd}: price<=0 (데이터 없음/시세권한 의심)`, res.rspCd || undefined, res.diag);
  }
  return { price, open: toNum(o.open), high: toNum(o.high), low: toNum(o.low), volume: toNum(o.volume), diag: res.diag };
}

// 오름차순 정렬 후 마지막(형성 중) 봉 1개 제외 → 확정봉만 반환.
function toConfirmed(candles: LSCandle[]): LSCandle[] {
  const sorted = [...candles].sort((a, b) => a.datetime.localeCompare(b.datetime));
  return sorted.length > 1 ? sorted.slice(0, -1) : sorted;
}

// ── 국내 현재가 (t1102) ──────────────────────────────────────
export async function getLSKRPrice(cfg: LSConfig, token: string, shcode: string): Promise<LSPrice> {
  const res = await lsPost(token, '/stock/market-data', 't1102', { t1102InBlock: { shcode } });
  return parseLSPrice('t1102', res, 't1102OutBlock');
}

// ── 해외 현재가 (g3101) — keysymbol = exchcd + symbol ────────
// delaygb 는 하드코딩하지 않는다(req1): 호출측이 실시간('R') 또는 공식 지연 코드를 전달.
export async function getLSUSPrice(cfg: LSConfig, token: string, symbol: string, exchcd: string, delaygb: string): Promise<LSPrice> {
  const res = await lsPost(token, '/overseas-stock/market-data', 'g3101', {
    g3101InBlock: { delaygb, keysymbol: exchcd + symbol, exchcd, symbol },
  });
  return parseLSPrice('g3101', res, 'g3101OutBlock');
}

// 차트 조회 결과(진단 포함). candles 는 확정봉(형성봉 제외, 오름차순).
export interface LSChartResult {
  candles: LSCandle[];
  rspCd: string;
  rspMsg: string;
  rawCount: number;        // OutBlock1 원본 행 수(확정봉 제외 전)
  outBlock: any;           // 요약 OutBlock (연속조회 cts 필드 등 포함)
  reqBody: Record<string, unknown>;   // 실제 요청 body (진단용, 민감정보 없음)
  diag: LSHttpDiag;
}

// 차트 응답 분류(req 3·5·10): rsp_cd·OutBlock 모두 없고 데이터 0 → INVALID_RESPONSE,
// 확정봉 0 → EMPTY, 그 외 OK(개수 충족 여부는 호출측이 minConfirmed 로 별도 판정).
export type LSChartStatus = 'OK' | 'EMPTY' | 'INVALID_RESPONSE';
export function classifyChart(r: LSChartResult): LSChartStatus {
  const noEnvelope = !r.rspCd && (!r.outBlock || Object.keys(r.outBlock).length === 0);
  if (r.rawCount === 0 && noEnvelope) return 'INVALID_RESPONSE';
  if (r.candles.length === 0) return 'EMPTY';
  return 'OK';
}

// ── 국내 15분봉 (t8412, ncnt=15) — OutBlock1: date/time/open/high/low/close/jdiff_vol ──
export async function getLSKR15Min(cfg: LSConfig, token: string, shcode: string, qrycnt = 60): Promise<LSChartResult> {
  // 공식 reqExample 필드 유지, ncnt(분)=15 / qrycnt(요청개수)만 조정. edate=99999999=최근.
  const reqBody = { t8412InBlock: { shcode, ncnt: 15, qrycnt, nday: '0', sdate: '', stime: '', edate: '99999999', etime: '', cts_date: '', cts_time: '', comp_yn: 'N' } };
  const { data, rspCd, rspMsg, diag } = await lsPost(token, '/stock/chart', 't8412', reqBody);
  const rows: any[] = data.t8412OutBlock1 || [];
  const candles = toConfirmed(rows.map(r => ({
    datetime: String(r.date) + String(r.time).padStart(6, '0'),
    open: toNum(r.open), high: toNum(r.high), low: toNum(r.low), close: toNum(r.close), volume: toNum(r.jdiff_vol),
  })));
  return { candles, rspCd, rspMsg, rawCount: rows.length, outBlock: data.t8412OutBlock || {}, reqBody, diag };
}

// ── 해외 15분봉 (g3203, ncnt=15) — OutBlock1: date/loctime/open/high/low/close/exevol ──
export async function getLSUS15Min(cfg: LSConfig, token: string, symbol: string, exchcd: string, delaygb: string, sdateYYYYMMDD: string, qrycnt = 100): Promise<LSChartResult> {
  // delaygb 는 하드코딩하지 않는다(req1·4): 호출측이 실시간('R') 또는 공식 지연 코드를 전달.
  // 그 외 필드는 공식 reqExample 유지: keysymbol=exchcd+symbol, comp_yn=N, edate="".
  const reqBody = { g3203InBlock: { delaygb, keysymbol: exchcd + symbol, exchcd, symbol, ncnt: 15, qrycnt, comp_yn: 'N', sdate: sdateYYYYMMDD, edate: '' } };
  const { data, rspCd, rspMsg, diag } = await lsPost(token, '/overseas-stock/chart', 'g3203', reqBody);
  const rows: any[] = data.g3203OutBlock1 || [];
  const candles = toConfirmed(rows.map(r => ({
    datetime: String(r.date) + String(r.loctime).padStart(6, '0'),
    open: toNum(r.open), high: toNum(r.high), low: toNum(r.low), close: toNum(r.close), volume: toNum(r.exevol),
  })));
  return { candles, rspCd, rspMsg, rawCount: rows.length, outBlock: data.g3203OutBlock || {}, reqBody, diag };
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
