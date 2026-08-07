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

// LS REST 공통 헤더. 연속조회 시 tr_cont='Y' + 이전 응답 tr_cont_key (공식 연속조회 방식).
function lsHeaders(token: string, trCd: string, trCont = 'N', trContKey = ''): Record<string, string> {
  return {
    'content-type': 'application/json; charset=UTF-8',
    'authorization': `Bearer ${token}`,
    'tr_cd': trCd,
    'tr_cont': trCont,
    'tr_cont_key': trContKey,
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
  COSOQ02701: ['00000', '00136'],   // 해외 예수금 — 00136 "조회가 완료되었습니다."(실계정 확인) = 정상

  CSPAT00601: ['00000', '00040'],   // 현물주문 — 00040 "매수 주문이 완료되었습니다."(실계정 확인) = 정상
  CSPAT00801: ['00000', '00156'],   // 현물취소주문 — 00156(취소 접수) 도 정상(공식 resExample)
  COSAT00301: ['00000'],            // 미국시장주문 — 공식 확인 성공코드(00000). 그 외 코드+OrdNo 는 아래 isUSOrderSuccess 로 판정
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
async function lsPost(token: string, path: string, trCd: string, inBlock: Record<string, unknown>, cont: { trCont?: string; trContKey?: string } = {}): Promise<LSResult> {
  const trCont = cont.trCont ?? 'N';
  const trContKey = cont.trContKey ?? '';
  const reqHeaders = { tr_cd: trCd, tr_cont: trCont, tr_cont_key: trContKey, content_type: 'application/json; charset=UTF-8' };
  return runLimited(async () => {
    let res: Response;
    try {
      res = await fetch(`${LS_BASE}${path}`, {
        method: 'POST',
        headers: lsHeaders(token, trCd, trCont, trContKey),
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
  rows: LSCandle[];        // 형성봉 포함 전체 매핑 행(연속조회 병합용)
  rspCd: string;
  rspMsg: string;
  rawCount: number;        // OutBlock1 원본 행 수(확정봉 제외 전)
  recCount: number;        // OutBlock.rec_count (응답 건수)
  ctsDate: string;         // OutBlock.cts_date (연속조회 위치)
  ctsTime: string;         // OutBlock.cts_time (연속조회 위치)
  resTrCont: string;       // 응답 헤더 tr_cont ('Y'=연속조회 있음)
  resTrContKey: string;    // 응답 헤더 tr_cont_key (다음 요청에 사용)
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
  const rowsRaw: any[] = data.t8412OutBlock1 || [];
  const rows = rowsRaw.map(r => ({
    datetime: String(r.date) + String(r.time).padStart(6, '0'),
    open: toNum(r.open), high: toNum(r.high), low: toNum(r.low), close: toNum(r.close), volume: toNum(r.jdiff_vol),
  }));
  const ob = data.t8412OutBlock || {};
  return {
    candles: toConfirmed(rows), rows, rspCd, rspMsg, rawCount: rowsRaw.length,
    recCount: toNum(ob.rec_count), ctsDate: String(ob.cts_date ?? ''), ctsTime: String(ob.cts_time ?? ''),
    resTrCont: diag.trCont, resTrContKey: diag.trContKey, outBlock: ob, reqBody, diag,
  };
}

// ── 해외 15분봉 (g3203, ncnt=15) — OutBlock1: date/loctime/open/high/low/close/exevol ──
// ⚠️ 공식 제한(g3203): comp_yn='N'(비압축) → qrycnt 최대 5. comp_yn='Y'(압축) → 최대 2000.
//    압축응답 해제 방식은 공식 문서에서 확인되지 않았으므로 여기서는 비압축(N, 상한 5)만 사용한다.
//    20개 이상 시드는 getLSUS15MinPaged 로 연속조회(tr_cont/tr_cont_key) 반복 호출해 확보한다.
// g3203InBlock 필드(공식): delaygb/keysymbol/exchcd/symbol/ncnt/qrycnt/comp_yn/sdate/edate — cts_* 입력 없음.
export const LS_G3203_MAX_QRYCNT_UNCOMPRESSED = 5;   // comp_yn='N' 공식 상한

export interface LSUS15MinOpts {
  ncnt?: number;        // 분(기본 15)
  qrycnt?: number;      // 요청건수 — comp_yn='N' 공식 상한 5 로 강제 clamp
  sdate?: string;       // 시작일 YYYYMMDD (공식 reqExample 필드)
  edate?: string;       // 종료일(기본 '')
  trCont?: string;      // 연속조회 요청 헤더('N' 최초 / 'Y' 연속)
  trContKey?: string;   // 이전 응답 tr_cont_key
}

export async function getLSUS15Min(
  cfg: LSConfig, token: string, symbol: string, exchcd: string, delaygb: string, opts: LSUS15MinOpts = {},
): Promise<LSChartResult> {
  // delaygb 는 하드코딩하지 않는다(req1·4): 호출측이 실시간('R') 또는 공식 지연 코드를 전달.
  const ncnt = opts.ncnt ?? 15;
  const qrycnt = Math.min(opts.qrycnt ?? LS_G3203_MAX_QRYCNT_UNCOMPRESSED, LS_G3203_MAX_QRYCNT_UNCOMPRESSED);   // 비압축 상한 5
  const reqBody = { g3203InBlock: { delaygb, keysymbol: exchcd + symbol, exchcd, symbol, ncnt, qrycnt, comp_yn: 'N', sdate: opts.sdate ?? '', edate: opts.edate ?? '' } };
  const { data, rspCd, rspMsg, diag } = await lsPost(token, '/overseas-stock/chart', 'g3203', reqBody, { trCont: opts.trCont ?? 'N', trContKey: opts.trContKey ?? '' });
  const rowsRaw: any[] = data.g3203OutBlock1 || [];
  const rows = rowsRaw.map(r => ({
    datetime: String(r.date) + String(r.loctime).padStart(6, '0'),
    open: toNum(r.open), high: toNum(r.high), low: toNum(r.low), close: toNum(r.close), volume: toNum(r.exevol),
  }));
  const ob = data.g3203OutBlock || {};
  return {
    candles: toConfirmed(rows), rows, rspCd, rspMsg, rawCount: rowsRaw.length,
    recCount: toNum(ob.rec_count), ctsDate: String(ob.cts_date ?? ''), ctsTime: String(ob.cts_time ?? ''),
    resTrCont: diag.trCont, resTrContKey: diag.trContKey, outBlock: ob, reqBody, diag,
  };
}

// ── 해외 15분봉 연속조회 시드 (Phase B) ──────────────────────────
// 비압축(qrycnt=5)으로 tr_cont='Y' + tr_cont_key(이전 응답 헤더)를 사용해 반복 호출,
// timestamp 로 중복 제거하며 최신 target 개 확정봉(형성봉 제외)을 확보한다. RateLimiter 준수(lsPost 경유).
export interface LSChartPaged {
  candles: LSCandle[];   // 병합·중복제거·정렬된 확정봉(최신 1개=형성봉 제외)
  calls: number;
  pages: Array<{ rspCd: string; rawCount: number; recCount: number; resTrCont: string; resTrContKey: string }>;
  last: LSChartResult;   // 마지막 페이지(진단용)
}

export async function getLSUS15MinPaged(
  cfg: LSConfig, token: string, symbol: string, exchcd: string, delaygb: string,
  opts: { target?: number; maxCalls?: number; ncnt?: number; sdate?: string } = {},
): Promise<LSChartPaged> {
  const target = opts.target ?? 60;
  const maxCalls = opts.maxCalls ?? 12;
  const ncnt = opts.ncnt ?? 15;
  const sdate = opts.sdate ?? '';
  const seen = new Set<string>();
  const merged: LSCandle[] = [];
  const pages: LSChartPaged['pages'] = [];
  let trCont = 'N';
  let trContKey = '';
  let calls = 0;
  let last!: LSChartResult;
  while (calls < maxCalls) {
    const r = await getLSUS15Min(cfg, token, symbol, exchcd, delaygb, { ncnt, qrycnt: LS_G3203_MAX_QRYCNT_UNCOMPRESSED, sdate, trCont, trContKey });
    calls++;
    last = r;
    let added = 0;
    for (const c of r.rows) if (!seen.has(c.datetime)) { seen.add(c.datetime); merged.push(c); added++; }   // 중복 timestamp 제거
    pages.push({ rspCd: r.rspCd, rawCount: r.rawCount, recCount: r.recCount, resTrCont: r.resTrCont, resTrContKey: r.resTrContKey });
    if (merged.length >= target + 1) break;                 // +1: 형성봉 제외 후 target 확보
    if (r.rows.length === 0 || added === 0) break;          // 진전 없음 → 중단
    if (r.resTrCont !== 'Y' || !r.resTrContKey) break;      // 연속조회 없음(공식 헤더 기준)
    trCont = 'Y';
    trContKey = r.resTrContKey;
  }
  const sorted = merged.sort((a, b) => a.datetime.localeCompare(b.datetime));
  const confirmed = sorted.length > 1 ? sorted.slice(0, -1) : sorted;   // 최신 1개=형성봉 제외
  const candles = confirmed.slice(Math.max(0, confirmed.length - target));   // 최신 target 개
  return { candles, calls, pages, last };
}

// ── 해외 과거 틱 (g3202 NTICK) — 15분봉 재집계 fallback 용 ────────
// g3203(NMIN)이 빈 응답일 때, 공식 g3202(과거 틱)로 틱을 받아 15분 OHLCV 로 재집계한다.
// OutBlock1: date/loctime/open/high/low/close/exevol (+ jongchk/sign 등). 연속조회 위치 = OutBlock.cts_seq.
// g3202InBlock 필드(공식): delaygb/keysymbol/exchcd/symbol/ncnt/qrycnt/comp_yn/sdate/edate — cts 입력 없음(헤더 연속조회).
export interface LSTick { datetime: string; open: number; high: number; low: number; close: number; volume: number; }
export interface LSTickResult {
  ticks: LSTick[];
  rspCd: string; rspMsg: string;
  rawCount: number; recCount: number;
  ctsSeq: string;
  resTrCont: string; resTrContKey: string;
  outBlock: any; reqBody: Record<string, unknown>; diag: LSHttpDiag;
}

export interface LSTicksOpts { ncnt?: number; qrycnt?: number; sdate?: string; edate?: string; trCont?: string; trContKey?: string; }

export async function getLSUSTicks(
  cfg: LSConfig, token: string, symbol: string, exchcd: string, delaygb: string, opts: LSTicksOpts = {},
): Promise<LSTickResult> {
  const ncnt = opts.ncnt ?? 5;   // 공식 reqExample 값(추측 금지). 어떤 값이든 각 행이 date/loctime/OHLC/exevol 이라 15분 재집계 가능.
  const qrycnt = Math.min(opts.qrycnt ?? LS_G3203_MAX_QRYCNT_UNCOMPRESSED, LS_G3203_MAX_QRYCNT_UNCOMPRESSED);   // 비압축 상한 5
  const reqBody = { g3202InBlock: { delaygb, keysymbol: exchcd + symbol, exchcd, symbol, ncnt, qrycnt, comp_yn: 'N', sdate: opts.sdate ?? '', edate: opts.edate ?? '' } };
  const { data, rspCd, rspMsg, diag } = await lsPost(token, '/overseas-stock/chart', 'g3202', reqBody, { trCont: opts.trCont ?? 'N', trContKey: opts.trContKey ?? '' });
  const rowsRaw: any[] = data.g3202OutBlock1 || [];
  const ticks = rowsRaw.map(r => ({
    datetime: String(r.date) + String(r.loctime).padStart(6, '0'),
    open: toNum(r.open), high: toNum(r.high), low: toNum(r.low), close: toNum(r.close), volume: toNum(r.exevol),
  }));
  const ob = data.g3202OutBlock || {};
  return {
    ticks, rspCd, rspMsg, rawCount: rowsRaw.length, recCount: toNum(ob.rec_count),
    ctsSeq: String(ob.cts_seq ?? ''), resTrCont: diag.trCont, resTrContKey: diag.trContKey, outBlock: ob, reqBody, diag,
  };
}

// 15분 버킷 키(ET 벽시계 문자열 floor) — 조기중단용 진행도 계산 전용(집계 본체는 러너 aggregateTicksTo15Min).
function mins15Key(ts: string): string {
  if (ts.length < 12) return ts;
  const mm = parseInt(ts.slice(10, 12) || '0', 10);
  return ts.slice(0, 8) + ts.slice(8, 10) + String(Math.floor(mm / 15) * 15).padStart(2, '0');
}

// g3202 연속조회로 틱을 누적한다(tr_cont/tr_cont_key 헤더). 틱은 같은 loctime 중복이 정상 → timestamp dedup 금지.
// 15분 버킷 target 개가 모이면 조기 종료. RateLimiter 준수(lsPost 경유).
export interface LSTicksPaged { ticks: LSTick[]; calls: number; pages: Array<{ rspCd: string; rawCount: number; recCount: number; resTrCont: string }>; last: LSTickResult; }
export async function getLSUSTicksPaged(
  cfg: LSConfig, token: string, symbol: string, exchcd: string, delaygb: string,
  opts: { target?: number; maxCalls?: number; ncnt?: number; sdate?: string } = {},
): Promise<LSTicksPaged> {
  const target = opts.target ?? 21;      // 확정 20 + 형성 1 버킷
  const maxCalls = opts.maxCalls ?? 40;
  const ncnt = opts.ncnt ?? 5;
  const sdate = opts.sdate ?? '';
  const ticks: LSTick[] = [];
  const buckets = new Set<string>();
  const pages: LSTicksPaged['pages'] = [];
  let trCont = 'N', trContKey = '', calls = 0;
  let last!: LSTickResult;
  while (calls < maxCalls) {
    const r = await getLSUSTicks(cfg, token, symbol, exchcd, delaygb, { ncnt, qrycnt: LS_G3203_MAX_QRYCNT_UNCOMPRESSED, sdate, trCont, trContKey });
    calls++;
    last = r;
    for (const t of r.ticks) { ticks.push(t); if (t.datetime.length >= 12) buckets.add(mins15Key(t.datetime)); }   // 틱 중복제거 안 함
    pages.push({ rspCd: r.rspCd, rawCount: r.rawCount, recCount: r.recCount, resTrCont: r.resTrCont });
    if (buckets.size >= target) break;
    if (r.ticks.length === 0) break;
    if (r.resTrCont !== 'Y' || !r.resTrContKey) break;   // 연속조회 없음
    trCont = 'Y';
    trContKey = r.resTrContKey;
  }
  return { ticks, calls, pages, last };
}

// 해외 차트 원문 프로브(진단 전용) — 임의 TR(g3103/g3202/g3203/g3204)을 그대로 호출해 rsp_cd/행수/원문을 반환.
export async function lsOverseasChartRaw(
  token: string, trCd: string, inBlock: Record<string, unknown>, cont: { trCont?: string; trContKey?: string } = {},
): Promise<{ rspCd: string; rspMsg: string; out1: any[]; outBlock: any; diag: LSHttpDiag }> {
  const { data, rspCd, rspMsg, diag } = await lsPost(token, '/overseas-stock/chart', trCd, inBlock, cont);
  return { rspCd, rspMsg, out1: data[`${trCd}OutBlock1`] || [], outBlock: data[`${trCd}OutBlock`] || {}, diag };
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

// ══════════════════════════════════════════════════════════════════
//  해외주식 주문/체결/예수금 (Phase 3 준비 — 공식 필드만 사용, 추측 금지)
//  ⚠️ 이 함수들은 LS_LIVE_TRADING='true' + 전 조건 충족 시에만 러너가 호출한다.
//     기본(observe/ARMED)에서는 절대 호출되지 않는다.
// ══════════════════════════════════════════════════════════════════

// ── 미국 지정가 매수 주문 (COSAT00301, /overseas-stock/order) ──
// InBlock1(공식): RecCnt/OrdPtnCode/OrdMktCode/IsuNo/OrdQty/OvrsOrdPrc/OrdprcPtnCode/BrkTpCode
//   OrdPtnCode='02'(매수), OrdprcPtnCode='00'(지정가) — 공식 reqExample + COSAQ00102 OutBlock3
//   (OrdPtnCode '02'→'매수', OrdprcPtnCode '00'→'지정가')로 확인.
//   OrdMktCode=거래소코드(exchcd), IsuNo=심볼, OvrsOrdPrc=해외주문가(지정가).
export interface LSOrderResult { rspCd: string; rspMsg: string; ordNo: string | null; raw: any; diag: LSHttpDiag; }

// COSAT00301 주문 성공 판정 — 성공코드(00000) 또는 주문번호(OrdNo) 존재. (KR 00040 오탐 사고 방지 패턴 이식)
export const US_ORDER_SUCCESS_CODES = new Set(['00000']);
export function isUSOrderSuccess(rspCd: string, ordNo: string | null | undefined): boolean {
  return (ordNo != null && ordNo !== '' && ordNo !== '(unknown)') || US_ORDER_SUCCESS_CODES.has(rspCd);
}

export async function placeLSUSBuyOrder(
  cfg: LSConfig, token: string, p: { exchcd: string; symbol: string; qty: number; price: number },
): Promise<LSOrderResult> {
  const inb = {
    COSAT00301InBlock1: {
      RecCnt: 1, OrdPtnCode: '02', OrdMktCode: p.exchcd, IsuNo: p.symbol,
      OrdQty: p.qty, OvrsOrdPrc: p.price, OrdprcPtnCode: '00', BrkTpCode: '',
    },
  };
  const { data, rspCd, rspMsg, diag } = await lsPost(token, '/overseas-stock/order', 'COSAT00301', inb);
  // 응답 주문번호 필드는 공식 카탈로그 resExample 이 비어 있어 미확정 → 있으면 OrdNo 사용, 없으면 null.
  // 확정 주문번호/체결/미체결은 COSAQ00102(계좌주문체결내역조회)로 재조회한다.
  const ob = data.COSAT00301OutBlock1 || data.COSAT00301OutBlock2 || {};
  const ordNo = ob.OrdNo != null ? String(ob.OrdNo) : null;
  return { rspCd, rspMsg, ordNo, raw: data, diag };
}

// ── 계좌 주문체결내역 조회 (COSAQ00102, /overseas-stock/accno) — 체결/미체결 확인 ──
// InBlock1(공식): RecCnt/QryTpCode/BkseqTpCode/OrdMktCode/BnsTpCode/IsuNo/SrtOrdNo/OrdDt/
//                 ExecYn/CrcyCode/ThdayBnsAppYn/LoanBalHldYn
// OutBlock3(리스트): OrdNo/OrgOrdNo/ShtnIsuNo/OrdQty/ExecQty/UnercQty/OvrsOrdPrc/OrdPtnCode/OrdprcPtnCode ...
export interface LSOrderExec { ordNo: string; orgOrdNo: string; symbol: string; ordQty: number; execQty: number; unfilledQty: number; ordPrc: number; ordPtnCode: string; trxNm: string; }
export interface LSOrderExecResult { rspCd: string; rspMsg: string; rows: LSOrderExec[]; diag: LSHttpDiag; }
export async function queryLSUSOrderExec(
  cfg: LSConfig, token: string, p: { exchcd: string; symbol?: string; ordDate: string; execYn?: '0' | '1' | '2' },
): Promise<LSOrderExecResult> {
  // ExecYn: 0=전체, 1=체결, 2=미체결 (공식 InBlock 필드). SrtOrdNo=999999999(전체). QryTpCode/BkseqTpCode=1.
  const inb = {
    COSAQ00102InBlock1: {
      RecCnt: 1, QryTpCode: '1', BkseqTpCode: '1', OrdMktCode: p.exchcd, BnsTpCode: '0',
      IsuNo: p.symbol ?? '', SrtOrdNo: 999999999, OrdDt: p.ordDate, ExecYn: p.execYn ?? '0',
      CrcyCode: '000', ThdayBnsAppYn: '0', LoanBalHldYn: '0',
    },
  };
  const { data, rspCd, rspMsg, diag } = await lsPost(token, '/overseas-stock/accno', 'COSAQ00102', inb);
  const rows: LSOrderExec[] = (data.COSAQ00102OutBlock3 || []).map((r: any) => ({
    ordNo: String(r.OrdNo ?? ''), orgOrdNo: String(r.OrgOrdNo ?? ''),
    symbol: String(r.ShtnIsuNo ?? r.IsuNo ?? ''),
    ordQty: toNum(r.OrdQty), execQty: toNum(r.ExecQty), unfilledQty: toNum(r.UnercQty),
    ordPrc: toNum(r.OvrsOrdPrc), ordPtnCode: String(r.OrdPtnCode ?? ''), trxNm: String(r.OrdTrxPtnNm ?? ''),
  }));
  return { rspCd, rspMsg, rows, diag };
}

// ── 해외 예수금/주문가능 조회 (COSOQ02701, /overseas-stock/accno) — 현금(cash-only) 주문가능 판정용 ──
// 공식 resExample(카탈로그) 확인 완료. 신용/미수/대출/증거금(레버리지) 절대 미사용. P0-15.
//   OutBlock3(통화·국가별 리스트): USD 행
//     · FcurrDps            = 외화예수금(순수 USD 현금)
//     · FcurrOrdAbleAmt     = 외화주문가능금액(USD 현금 기준 주문가능)
//     · PrexchOrdAbleAmt    = 선환전 주문가능금액(원화현금 자동환전으로 주문가능한 USD, LS가 환haircut 반영해 산출)
//     · BaseXchrat          = 기준환율(USD→KRW)
//   OutBlock4(원화 요약):
//     · WonDpsBalAmt        = 원화예수금잔고(실제 보유 KRW 현금)
//     · MnyoutAbleAmt       = 출금가능금액(전액 출금가능 == 순수현금 근거)
//     · WonPrexchAbleAmt    = 원화 선환전 가능금액(원화주문에 쓸 수 있는 KRW 현금)
//     · OvrsMgn             = 해외증거금(미수/레버리지 사용액) — 반드시 0 이어야 cash-only 로 허용
// ok = 성공코드(00000/00136 allow-list) AND USD 행 존재+FcurrDps 필드 존재 AND OutBlock4(WonDpsBalAmt) 존재.
//   블록/필드 누락 → ok=false(INVALID_RESPONSE, LIVE 차단). 메시지 문자열로 판정하지 않는다.
export interface LSUSDeposit {
  ok: boolean; rspCd: string; rspMsg: string; found: boolean; diag: LSHttpDiag;
  usdCash: number;            // OutBlock3 USD FcurrDps (순수 USD 현금예수금)
  usdOrderable: number;       // OutBlock3 USD FcurrOrdAbleAmt (USD 현금 주문가능)
  usdPrexchOrderable: number; // OutBlock3 USD PrexchOrdAbleAmt (선환전 주문가능 USD, 원화현금 환산)
  baseXchRate: number;        // OutBlock3 USD BaseXchrat (기준환율)
  krwCash: number;            // OutBlock4 WonDpsBalAmt (실제 KRW 현금예수금)
  krwWithdrawable: number;    // OutBlock4 MnyoutAbleAmt (출금가능 — 순수현금 근거)
  krwPrexchable: number;      // OutBlock4 WonPrexchAbleAmt (원화 선환전 가능 KRW 현금)
  overseasMargin: number;     // OutBlock4 OvrsMgn (해외증거금/미수 — 0 이어야 cash-only)
  usdDeposit: number;         // 하위호환: = usdCash
}
export async function getLSUSDeposit(cfg: LSConfig, token: string): Promise<LSUSDeposit> {
  const { data, rspCd, rspMsg, diag } = await lsPost(token, '/overseas-stock/accno', 'COSOQ02701', {
    COSOQ02701InBlock1: { RecCnt: 1, CrcyCode: 'ALL' },
  });
  const codeOk = (LS_SUCCESS_CODES.COSOQ02701 ?? ['00000']).includes(rspCd);   // rsp_cd allow-list 기준(00136 포함)
  const ob3: any[] = data.COSOQ02701OutBlock3 || [];
  const usd = ob3.find(r => String(r.CrcyCode).toUpperCase() === 'USD');
  const ob4: any = data.COSOQ02701OutBlock4 || null;
  const usdHasCash = !!usd && Object.prototype.hasOwnProperty.call(usd, 'FcurrDps');
  const krwHasCash = !!ob4 && Object.prototype.hasOwnProperty.call(ob4, 'WonDpsBalAmt');
  const usdCash = usdHasCash ? toNum(usd.FcurrDps) : 0;
  return {
    ok: codeOk && usdHasCash && krwHasCash,   // 성공코드 + USD현금필드 + 원화요약 모두 있어야 정상(아니면 차단)
    rspCd, rspMsg, found: !!usd, diag,
    usdCash,
    usdOrderable: usd ? toNum(usd.FcurrOrdAbleAmt) : 0,
    usdPrexchOrderable: usd ? toNum(usd.PrexchOrdAbleAmt) : 0,
    baseXchRate: usd ? toNum(usd.BaseXchrat) : 0,
    krwCash: ob4 ? toNum(ob4.WonDpsBalAmt) : 0,
    krwWithdrawable: ob4 ? toNum(ob4.MnyoutAbleAmt) : 0,
    krwPrexchable: ob4 ? toNum(ob4.WonPrexchAbleAmt) : 0,
    overseasMargin: ob4 ? toNum(ob4.OvrsMgn) : 0,
    usdDeposit: usdCash,   // 하위호환
  };
}

// ── cash-only 결제 판정 (P0-15) — USD 현금 우선, 부족 시 원화현금 선환전. 신용/미수/증거금 절대 미사용 ──
// 안전원칙: (1) overseasMargin(OvrsMgn) > 0 이면 즉시 차단(계좌에 미수/증거금 사용 흔적) →
//           (2) USD 현금(FcurrDps) 이 필요금액을 덮으면 USD 결제, (3) 아니면 원화현금 선환전:
//               · 공식 USD 선환전주문가능(PrexchOrdAbleAmt) ≥ 필요 USD  그리고
//               · 실제 원화현금(min(WonDpsBalAmt, WonPrexchAbleAmt)) ≥ 필요USD × 기준환율  둘 다 충족.
//           원화현금은 실제 예수금을 초과할 수 없도록 min 으로 캡(레버리지 유입 차단).
export type USPaymentMode = 'USD' | 'KRW' | 'NONE';
export interface USCashDecision {
  paymentMode: USPaymentMode; orderAllowed: boolean; reason: string;
  usdCash: number; krwCash: number; baseXchRate: number; overseasMargin: number;
  estimatedUsd: number; estimatedKrw: number; cashOnlyUsdCap: number;
}
// 계좌가 순수현금으로 결제 가능한 최대 USD 명목금액(레버리지 제외). 가격 무관.
export function usCashOnlyUsdCap(dep: LSUSDeposit): number {
  if (!dep.ok || dep.overseasMargin > 0) return 0;   // 미수/증거금 사용 계좌 → cash-only 불가
  const krwCashOnly = Math.min(dep.krwCash, dep.krwPrexchable);   // 실제 예수금 초과 금지(레버리지 캡)
  const krwPathUsd = (dep.baseXchRate > 0 && krwCashOnly > 0)
    ? Math.min(dep.usdPrexchOrderable, krwCashOnly / dep.baseXchRate)   // 공식 선환전가능 vs 원화현금 환산 중 작은 값
    : 0;
  return Math.max(dep.usdCash, krwPathUsd);
}
export function decideUSCashPayment(dep: LSUSDeposit, priceUsd: number, qty: number): USCashDecision {
  const estimatedUsd = priceUsd * qty;
  const base = {
    usdCash: dep.usdCash, krwCash: dep.krwCash, baseXchRate: dep.baseXchRate, overseasMargin: dep.overseasMargin,
    estimatedUsd, estimatedKrw: estimatedUsd * (dep.baseXchRate > 0 ? dep.baseXchRate : 0),
    cashOnlyUsdCap: usCashOnlyUsdCap(dep),
  };
  if (!dep.ok) return { ...base, paymentMode: 'NONE', orderAllowed: false, reason: 'INVALID_RESPONSE' };
  if (dep.overseasMargin > 0) return { ...base, paymentMode: 'NONE', orderAllowed: false, reason: 'MARGIN_PRESENT' };
  if (!(priceUsd > 0) || !(qty > 0)) return { ...base, paymentMode: 'NONE', orderAllowed: false, reason: 'INVALID_PRICE' };
  // (2) USD 현금 결제
  if (dep.usdCash >= estimatedUsd) return { ...base, paymentMode: 'USD', orderAllowed: true, reason: 'USD_CASH' };
  // (3) 원화현금 선환전 결제 — 공식 선환전가능(USD) AND 실제 원화현금(KRW) 둘 다 충족
  const krwCashOnly = Math.min(dep.krwCash, dep.krwPrexchable);
  const krwOk = dep.baseXchRate > 0 && krwCashOnly > 0
    && dep.usdPrexchOrderable >= estimatedUsd
    && krwCashOnly >= base.estimatedKrw;
  if (krwOk) return { ...base, paymentMode: 'KRW', orderAllowed: true, reason: 'KRW_PREXCH_CASH' };
  return { ...base, paymentMode: 'NONE', orderAllowed: false, reason: 'KRW_CASH_INSUFFICIENT' };
}

// ── 미체결 취소 (COSAT00311) — ⚠️ 공식 카탈로그에 필드(reqExample/InBlock) 미수록 ──
// 추측 금지 원칙상 요청 필드를 임의로 만들지 않는다. 사용자가 공식 취소 TR 스펙을 제공하기 전까지
// 이 함수는 호출 시 예외를 던지고, 실주문 게이트는 '취소 미확인'으로 LIVE 를 차단한다.
export const LS_CANCEL_TR_CONFIRMED = false;   // 공식 취소 필드 확인 시 true 로 전환
export async function cancelLSUSOrder(_cfg: LSConfig, _token: string, _p: { exchcd: string; symbol: string; ordNo: string; qty: number }): Promise<never> {
  throw new LSApiError('INVALID_RESPONSE', 'COSAT00311(미국 취소/정정) 공식 요청 필드 미확인 — 구현 보류(추측 금지). 공식 스펙 확보 후 구현 필요.');
}

// ── 해외 보유수량 조회 (COSOQ00201 OutBlock4) — 매도 전 실제 보유/매도가능수량 확인 ──
// OutBlock4(공식 resExample): ShtnIsuNo(단축종목=심볼)/AstkBalQty(잔고수량)/AstkSellAbleQty(매도가능수량).
export interface LSUSHolding { symbol: string; balQty: number; sellableQty: number; }
export async function getLSUSHoldings(cfg: LSConfig, token: string, baseDateYYYYMMDD: string): Promise<{ rspCd: string; rspMsg: string; holdings: LSUSHolding[]; diag: LSHttpDiag }> {
  const { data, rspCd, rspMsg, diag } = await lsPost(token, '/overseas-stock/accno', 'COSOQ00201', {
    COSOQ00201InBlock1: { RecCnt: 1, BaseDt: baseDateYYYYMMDD, CrcyCode: 'ALL', AstkBalTpCode: '00' },
  });
  const rows: any[] = data.COSOQ00201OutBlock4 || [];
  const holdings = rows.map(r => ({
    symbol: String(r.ShtnIsuNo ?? ''), balQty: toNum(r.AstkBalQty), sellableQty: toNum(r.AstkSellAbleQty),
  })).filter(h => h.symbol);
  return { rspCd, rspMsg, holdings, diag };
}

// ══════════════════════════════════════════════════════════════════
//  국내(현물) 주문/체결/취소 (공식 필드만 사용) — /stock/order, /stock/accno
//  ⚠️ LS_LIVE_TRADING='true' + 국내장 조건 충족 시에만 러너가 호출한다.
// ══════════════════════════════════════════════════════════════════

// 국내 종목번호(IsuNo) 는 'A' 접두 6자리(예: A005930). 유니버스 shcode(005930) → A005930.
export function krIsuNo(shcode: string): string { return /^A/i.test(shcode) ? shcode.toUpperCase() : 'A' + shcode; }

// BnsTpCode: 1=매도, 2=매수 (공식 reqExample 매수="2"). OrdprcPtnCode: 00=지정가.
export const LS_KR_BNS_BUY = '2';
export const LS_KR_BNS_SELL = '1';

// CSPAT00601 주문 성공 판정 — 성공코드(00000/00040) 또는 주문번호(OrdNo) 존재. (실계정 00040 오탐 방지)
export const KR_ORDER_SUCCESS_CODES = new Set(['00000', '00040']);
export function isKROrderSuccess(rspCd: string, ordNo: string | null | undefined): boolean {
  return (ordNo != null && ordNo !== '' && ordNo !== '(unknown)') || KR_ORDER_SUCCESS_CODES.has(rspCd);
}

// ── 현물 지정가 매수 (CSPAT00601, /stock/order) ──
// InBlock1(공식): IsuNo/OrdQty/OrdPrc/BnsTpCode/OrdprcPtnCode/MgntrnCode/LoanDt/OrdCndiTpCode/MbrNo
//   MbrNo 는 회원(거래소 라우팅) — 공식 reqExample 값 "NXT". 실주문 전 사용자 확인 필요(env 로 조정).
// 응답 OutBlock2.OrdNo = 주문번호.
export interface LSKROrderResult { rspCd: string; rspMsg: string; ordNo: string | null; raw: any; diag: LSHttpDiag; }
export async function placeLSKRBuyOrder(cfg: LSConfig, token: string, p: { shcode: string; qty: number; price: number; mbrNo?: string }): Promise<LSKROrderResult> {
  const inb = {
    CSPAT00601InBlock1: {
      IsuNo: krIsuNo(p.shcode), OrdQty: p.qty, OrdPrc: p.price, BnsTpCode: LS_KR_BNS_BUY,
      OrdprcPtnCode: '00', MgntrnCode: '000', LoanDt: '', OrdCndiTpCode: '0', MbrNo: p.mbrNo ?? 'NXT',
    },
  };
  const { data, rspCd, rspMsg, diag } = await lsPost(token, '/stock/order', 'CSPAT00601', inb);
  const ob2 = data.CSPAT00601OutBlock2 || {};
  return { rspCd, rspMsg, ordNo: ob2.OrdNo != null ? String(ob2.OrdNo) : null, raw: data, diag };
}

// ── 현물 취소주문 (CSPAT00801, /stock/order) ── InBlock1(공식): OrgOrdNo/IsuNo/OrdQty. 응답 OutBlock2.OrdNo.
export async function cancelLSKRBuyOrder(cfg: LSConfig, token: string, p: { orgOrdNo: string; shcode: string; qty: number }): Promise<LSKROrderResult> {
  const inb = { CSPAT00801InBlock1: { OrgOrdNo: Number(p.orgOrdNo), IsuNo: krIsuNo(p.shcode), OrdQty: p.qty } };
  const { data, rspCd, rspMsg, diag } = await lsPost(token, '/stock/order', 'CSPAT00801', inb);
  const ob2 = data.CSPAT00801OutBlock2 || {};
  return { rspCd, rspMsg, ordNo: ob2.OrdNo != null ? String(ob2.OrdNo) : null, raw: data, diag };
}

// ── 현물 주문체결내역 조회 (CSPAQ13700, /stock/accno) — OutBlock2 집계로 체결/부분체결 판정 ──
// InBlock1(공식): OrdMktCode/BnsTpCode/IsuNo/ExecYn/OrdDt/SrtOrdNo2/BkseqTpCode/OrdPtnCode
// OutBlock2(공식): BuyOrdQty/BuyExecQty/SellOrdQty/SellExecQty (당일 종목 집계).
//   하루 매수 1회 제한 하에서 BuyExecQty>=BuyOrdQty(>0) → 전량체결, 0<BuyExecQty<BuyOrdQty → 부분체결.
// ⚠️ OutBlock3(주문별 행) 필드는 공식 스냅샷에 없어 사용하지 않는다(추측 금지) — 집계로만 판정.
export interface LSKROrderExec { ok: boolean; rspCd: string; rspMsg: string; buyOrdQty: number; buyExecQty: number; sellOrdQty: number; sellExecQty: number; diag?: LSHttpDiag; }
export async function queryLSKROrderExec(cfg: LSConfig, token: string, p: { shcode: string; ordDate: string; bnsTpCode?: string }): Promise<LSKROrderExec> {
  const inb = { CSPAQ13700InBlock1: { OrdMktCode: '00', BnsTpCode: p.bnsTpCode ?? '0', IsuNo: krIsuNo(p.shcode), ExecYn: '0', OrdDt: p.ordDate, SrtOrdNo2: 0, BkseqTpCode: '0', OrdPtnCode: '00' } };
  try {
    const { data, rspCd, rspMsg, diag } = await lsPost(token, '/stock/accno', 'CSPAQ13700', inb);
    const o2 = data.CSPAQ13700OutBlock2 || {};
    return { ok: true, rspCd, rspMsg, buyOrdQty: toNum(o2.BuyOrdQty), buyExecQty: toNum(o2.BuyExecQty), sellOrdQty: toNum(o2.SellOrdQty), sellExecQty: toNum(o2.SellExecQty), diag };
  } catch (e) {
    // 조회 실패/빈응답은 "체결 미확인"(zeros)로 안전하게 처리 — 절대 체결완료로 오판하지 않는다.
    if (e instanceof LSApiError) return { ok: false, rspCd: e.rspCd ?? `ERR(${e.kind})`, rspMsg: e.message, buyOrdQty: 0, buyExecQty: 0, sellOrdQty: 0, sellExecQty: 0, diag: e.diag };
    return { ok: false, rspCd: 'EXCEPTION', rspMsg: String(e), buyOrdQty: 0, buyExecQty: 0, sellOrdQty: 0, sellExecQty: 0 };
  }
}
