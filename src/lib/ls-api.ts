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
 *   COSOQ00201: 00000 정상 / 00001 "조회가 완료되었습니다."(실계정 실측, 잔고 있음/없음 무관 정상완료)
 *               / 02679 "조회내역이 없습니다."(빈 잔고 = 정상)
 *   ⚠️ 이 코드들은 TR별 목록으로만 성공처리(전역 금지) + envelope/OutBlock 정상 파싱 시에만 성공(호출측 재검증).
 */
export const LS_SUCCESS_CODES: Record<string, string[]> = {
  CSPAQ12200: ['00000', '00136'],
  // P0-30E: 실계정 COSOQ00201 이 rsp_cd=00001 "조회가 완료되었습니다" 를 반환(보유 정상 조회) — TR별 성공코드로 등록.
  COSOQ00201: ['00000', '00001', '02679'],
  COSOQ02701: ['00000', '00136'],   // 해외 예수금 — 00136 "조회가 완료되었습니다."(실계정 확인) = 정상

  CSPAT00601: ['00000', '00040'],   // 현물주문 — 00040 "매수 주문이 완료되었습니다."(실계정 확인) = 정상
  CSPAT00801: ['00000', '00156'],   // 현물취소주문 — 00156(취소 접수) 도 정상(공식 resExample)
  // P0-35US6: 미국시장주문 — 00000 외 00040 "매수 주문이 완료되었습니다."(실계정 PRGO 실측, HTS 주문 존재 확인) = 정상.
  //   ⚠️ COSAT00301 한정(전역/타 TR 금지). KR 현물 CSPAT00601 과 동일 메시지·코드 패턴. 그 외 코드+OrdNo 는 isUSOrderSuccess 로 판정.
  COSAT00301: ['00000', '00040'],
};
/** 정상이나 데이터가 없는(빈 결과) 코드 — 잔고 0 으로 처리한다. */
export const LS_EMPTY_CODES: Record<string, string[]> = {
  COSOQ00201: ['02679'],
  // P0-35P5: CSPAQ13700(현물 주문체결내역) 실측 — rsp_cd=00200 "조회내역이 없습니다."(HTTP200+envelope+rows0) = 정상 0건.
  //   ⚠️ 이 TR 한정. 다른 TR 전역 적용 금지. rows>0/malformed envelope 이면 EMPTY 아님(fail-closed).
  CSPAQ13700: ['00200'],
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
/** 현재 공용 limiter 최소간격(ms) — capacity/ETA 계산용(추측 금지, 실제 값 사용). */
export function getLSMinIntervalMs(): number { return _lim.minIntervalMs; }
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
// soft=true (읽기전용 조회 TR 전용): HTTP 200 + 정상 JSON 이면 성공코드 목록에 없는 업무 rsp_cd(예: "조회할 자료가
//   없습니다")여도 throw 하지 않고 그대로 반환한다(호출측이 queryOk/rows 로 "0건 정상" vs "API 실패"를 구분).
//   ⚠️ 전송(주문) TR 에는 절대 쓰지 않는다. 네트워크/timeout/빈응답/JSON오류/HTTP>=400/429 는 soft 여도 그대로 throw.
async function lsPost(token: string, path: string, trCd: string, inBlock: Record<string, unknown>, cont: { trCont?: string; trContKey?: string; timeoutMs?: number; soft?: boolean } = {}): Promise<LSResult> {
  const trCont = cont.trCont ?? 'N';
  const trContKey = cont.trContKey ?? '';
  const timeoutMs = cont.timeoutMs ?? 15000;   // ⚠️ fetch 무한대기 방지 — 모든 LS REST 호출에 기본 15s 타임아웃
  const reqHeaders = { tr_cd: trCd, tr_cont: trCont, tr_cont_key: trContKey, content_type: 'application/json; charset=UTF-8' };
  return runLimited(async () => {
    let res: Response;
    // AbortController 로 타임아웃(응답 헤더/본문 스트림 모두 취소). timeout 이면 명확한 오류로 던져 무한대기 차단.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      try {
        res = await fetch(`${LS_BASE}${path}`, {
          method: 'POST',
          headers: lsHeaders(token, trCd, trCont, trContKey),
          body: JSON.stringify(inBlock),
          signal: ac.signal,
        });
      } catch (e) {
        if (ac.signal.aborted) throw new LSApiError('NETWORK', `LS ${trCd} 타임아웃(${timeoutMs}ms 초과) — 요청 중단`);
        throw new LSApiError('NETWORK', `LS ${trCd} 네트워크 오류: ${e instanceof Error ? e.message : String(e)}`);
      }
    // JSON 파싱 전에 HTTP 원문 진단을 캡처(req 1). 본문 스트림도 타임아웃(abort) 대상.
    let text: string;
    try { text = await res.text(); }
    catch (e) {
      if (ac.signal.aborted) throw new LSApiError('NETWORK', `LS ${trCd} 타임아웃(${timeoutMs}ms 초과) — 본문 수신 중단`);
      throw new LSApiError('NETWORK', `LS ${trCd} 본문 수신 오류: ${e instanceof Error ? e.message : String(e)}`);
    }
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
    const rspOk = !rspCd || ok.includes(rspCd);
    if (res.status >= 400 || !rspOk) {
      const rl = LS_RATE_LIMIT_CODES.has(rspCd) || /제한|초과|traffic|quota/i.test(rspMsg);
      // soft(읽기 조회 TR): HTTP 200 + 정상 JSON + rate-limit 아님 → 업무 rsp_cd(0건 등)여도 throw 안 함(호출측이 판정).
      if (cont.soft && res.status < 400 && !rl) return { data, rspCd, rspMsg, empty: true, diag };
      throw new LSApiError(rl ? 'RATE_LIMIT' : 'API', `LS ${trCd} rsp_cd=${rspCd || res.status} msg=${rspMsg}`, rspCd, diag);
    }
    const empty = (LS_EMPTY_CODES[trCd] ?? []).includes(rspCd);
    return { data, rspCd, rspMsg, empty, diag };
    } finally { clearTimeout(timer); }
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

// ── 국내 종목마스터 (t8436, /stock/etc) — KOSPI+KOSDAQ 전 종목 자동 로드 ──
// 공식 resExample OutBlock: shcode/hname/gubun(시장구분)/spac_gubun(SPAC)/etfgubun(ETF)/bu12gubun/memedan/
//   jnilclose(전일종가)/uplmtprice(상한)/dnlmtprice(하한)/recprice(기준가)/expcode(ISIN).
// 요청 gubun: '1'=코스피(공식 예제 확인), '2'=코스닥(LS 표준). 응답 row.gubun 으로도 시장을 분류한다.
// ⚠️ 공식 전송한도 t8436 = 초당 2건(개인)/5건(법인) — 시작 시 1~2회만 호출.
export interface LSKRMasterRow {
  shcode: string; hname: string; market: 'KOSPI' | 'KOSDAQ' | 'ETC'; gubunRaw: string;
  spac: boolean; etf: boolean; etfgubun: string;
  prevClose: number; upperLimit: number; lowerLimit: number; basePrice: number; memedan: string; expcode: string;
}
export const LS_KR_MASTER_KOSPI = '1';   // 공식 예제로 확인(gubun='1' → KOSPI 종목 반환)
export const LS_KR_MASTER_KOSDAQ = '2';  // LS 표준(코스닥)
function marketFromGubun(g: string): 'KOSPI' | 'KOSDAQ' | 'ETC' {
  return g === '1' ? 'KOSPI' : g === '2' ? 'KOSDAQ' : 'ETC';
}
export async function getLSKRStockMaster(cfg: LSConfig, token: string, gubun: string): Promise<{ rspCd: string; rspMsg: string; rows: LSKRMasterRow[]; diag: LSHttpDiag }> {
  const { data, rspCd, rspMsg, diag } = await lsPost(token, '/stock/etc', 't8436', { t8436InBlock: { gubun } });
  const raw: any[] = data.t8436OutBlock || [];
  const rows: LSKRMasterRow[] = raw.map(r => {
    const gRaw = String(r.gubun ?? '');
    return {
      shcode: String(r.shcode ?? ''),
      hname: String(r.hname ?? ''),
      market: marketFromGubun(gRaw),
      gubunRaw: gRaw,
      spac: String(r.spac_gubun ?? 'N').toUpperCase() === 'Y',
      etf: String(r.etfgubun ?? '0') !== '0',   // etfgubun '0'=일반, 그 외=ETF/ETN
      etfgubun: String(r.etfgubun ?? '0'),
      prevClose: toNum(r.jnilclose),
      upperLimit: toNum(r.uplmtprice),
      lowerLimit: toNum(r.dnlmtprice),
      basePrice: toNum(r.recprice),
      memedan: String(r.memedan ?? ''),
      expcode: String(r.expcode ?? ''),
    };
  });
  return { rspCd, rspMsg, rows, diag };
}

// ── 해외 종목마스터 (g3190, /overseas-stock/market-data) — 미국(NASDAQ/NYSE/AMEX) 전 종목 자동 로드 ──
// 공식 resExample OutBlock1: keysymbol/exchcd(82=NASDAQ,81=NYSE/AMEX)/symbol/korname/engname/currency/
//   clos(전일종가)/pcls/suspend(거래정지 N/Y)/sellonly(정리매매/매도전용 '0'=정상)/listed_date/expire_date(상폐예정,
//   '00000000'=없음)/marketcap/share. OutBlock.cts_value 로 페이징(연속조회).
// 요청: delaygb/natcode(US)/exgubun/readcnt/cts_value. exgubun 값 의미는 공식 카탈로그 미기재(추측 금지) →
//   호출측이 exgubun 을 주입하고, 시장분류는 각 row 의 공식 exchcd 로 한다.
// ⚠️ 공식 전송한도 g3190 = 초당 10건(개인)/50건(법인).
export interface LSUSMasterRow {
  keysymbol: string; symbol: string; exchcd: string; market: 'NASDAQ' | 'NYSE_AMEX' | 'ETC';
  engname: string; korname: string; currency: string;
  prevClose: number; suspend: boolean; sellOnly: boolean; delisting: boolean; expireDate: string;
  listedDate: string; marketcap: number;
}
function usMarketFromExchcd(exchcd: string): 'NASDAQ' | 'NYSE_AMEX' | 'ETC' {
  return exchcd === '82' ? 'NASDAQ' : exchcd === '81' ? 'NYSE_AMEX' : 'ETC';
}
// market(라벨) → exchcd 역매핑(P0-35US2) — usMarketFromExchcd 의 정확한 역(추측 아님). ETC/미상은 null.
export function usExchcdFromMarket(market: string): string | null {
  return market === 'NASDAQ' ? '82' : market === 'NYSE_AMEX' ? '81' : null;
}
export function parseLSUSMasterRow(r: any): LSUSMasterRow {
  const exchcd = String(r.exchcd ?? '');
  const expire = String(r.expire_date ?? '00000000');
  return {
    keysymbol: String(r.keysymbol ?? ''),
    symbol: String(r.symbol ?? ''),
    exchcd,
    market: usMarketFromExchcd(exchcd),
    engname: String(r.engname ?? ''),
    korname: String(r.korname ?? ''),
    currency: String(r.currency ?? ''),
    prevClose: toNum(r.clos) || toNum(r.pcls),
    suspend: String(r.suspend ?? 'N').toUpperCase() === 'Y',
    sellOnly: String(r.sellonly ?? '0') !== '0',
    delisting: expire !== '00000000' && expire !== '' && expire !== '0',
    expireDate: expire,
    listedDate: String(r.listed_date ?? ''),
    marketcap: toNum(r.marketcap),
  };
}
// 한 페이지(readcnt) 조회. ⚠️ LS REST 연속조회는 HTTP 헤더 tr_cont='Y' + tr_cont_key(이전 응답 헤더) 방식이
//   공식(g3203 과 동일, 라인 493 확인). body cts_value 는 응답값을 echo(보조). 응답 헤더 tr_cont/tr_cont_key 로 종료판정.
export async function getLSUSStockMasterPage(cfg: LSConfig, token: string, p: { natcode?: string; exgubun: string; readcnt?: number; ctsValue?: string; trCont?: string; trContKey?: string; delaygb?: string; timeoutMs?: number }): Promise<{ rspCd: string; rspMsg: string; rows: LSUSMasterRow[]; ctsValue: string; recCount: number; resTrCont: string; resTrContKey: string; diag: LSHttpDiag }> {
  const { data, rspCd, rspMsg, diag } = await lsPost(token, '/overseas-stock/market-data', 'g3190', {
    g3190InBlock: { delaygb: p.delaygb ?? 'R', natcode: p.natcode ?? 'US', exgubun: p.exgubun, readcnt: p.readcnt ?? 500, cts_value: p.ctsValue ?? '' },
  }, { trCont: p.trCont ?? 'N', trContKey: p.trContKey ?? '', timeoutMs: p.timeoutMs ?? 10000 });   // 공식 헤더 연속조회 + 10s 타임아웃
  const raw: any[] = data.g3190OutBlock1 || [];
  const ob = data.g3190OutBlock || {};
  return { rspCd, rspMsg, rows: raw.map(parseLSUSMasterRow), ctsValue: String(ob.cts_value ?? ''), recCount: toNum(ob.rec_count), resTrCont: diag.trCont, resTrContKey: diag.trContKey, diag };
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

// ── P0-28: g3203 과거방향(older-than) 조회 — storeOldest 보다 오래된 확정봉 확보 ──────────────
// ⚠️ 근본원인: 공식 g3203InBlock 은 [delaygb,keysymbol,exchcd,symbol,ncnt,qrycnt,comp_yn,sdate,edate] 뿐이고
//    cts_date/cts_time 은 **output 전용**(blocks.json 확인). tr_cont 헤더 연속조회는 실계정에서 page2 rows=0 으로
//    과거로 진행하지 못한다(실측). 따라서 최근 5봉만 반복 조회되던 것 → edate(종료일)를 **하루씩 과거로 이동**해
//    각 날짜의 확정봉(qrycnt=5 비압축 상한)을 모아 storeOldest 이전(=timestamp 더 작은) 봉을 확보한다(추측 없음, 공식 필드만).
export function prevYmd(ymd: string): string {
  const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6), d = +ymd.slice(6, 8);
  const dt = new Date(Date.UTC(y, m - 1, d) - 86400_000);
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`;
}
export interface LSChartOlder {
  candles: LSCandle[];        // storeOldest 보다 오래된(=datetime < before) 확정봉, 중복제거·오름차순
  olderCount: number;         // olderThanStoreOldest count (req5·6)
  responseNewest: string;     // 응답 전체에서 관측된 최신 datetime ('' 없음)
  responseOldest: string;     // 응답 전체에서 관측된 최고(最古) datetime
  requestEdateFirst: string;  // 최초 요청 edate (req4)
  requestSdate: string;       // 요청 sdate (floor)
  calls: number;
  pages: Array<{ edate: string; rawCount: number; resTrCont: string; oldest: string; newest: string; olderAdded: number }>;
}
export async function getLSUS15MinOlderThan(
  cfg: LSConfig, token: string, symbol: string, exchcd: string, delaygb: string,
  opts: { beforeYmdHms: string; target?: number; maxCalls?: number; ncnt?: number; lookbackDays?: number },
): Promise<LSChartOlder> {
  const before = opts.beforeYmdHms;              // 이보다 오래된 봉만 채택(strict <)
  const target = Math.max(1, opts.target ?? 8);  // 이번 호출에서 확보 목표 older 봉 수
  const maxCalls = Math.max(1, opts.maxCalls ?? 6);
  const ncnt = opts.ncnt ?? 15;
  const lookbackDays = Math.max(1, opts.lookbackDays ?? 10);
  const beforeDate = before.slice(0, 8);
  const sdateOf = (edate: string) => { let s = edate; for (let i = 0; i < lookbackDays; i++) s = prevYmd(s); return s; };
  const seen = new Set<string>();
  const older: LSCandle[] = [];
  const pages: LSChartOlder['pages'] = [];
  let respNewest = ''; let respOldest = '';
  let edateCursor = beforeDate;                  // 시작: storeOldest 날짜(그 날의 더 이른 봉 포함 가능)
  const requestEdateFirst = edateCursor;
  const requestSdate = sdateOf(edateCursor);
  let calls = 0;
  while (calls < maxCalls && older.length < target) {
    const sdate = sdateOf(edateCursor);
    const r = await getLSUS15Min(cfg, token, symbol, exchcd, delaygb, { ncnt, qrycnt: LS_G3203_MAX_QRYCNT_UNCOMPRESSED, sdate, edate: edateCursor });
    calls++;
    const dts = r.rows.map(c => c.datetime).sort();
    const pageOldest = dts[0] ?? '';
    const pageNewest = dts[dts.length - 1] ?? '';
    let olderAdded = 0;
    for (const c of r.rows) if (c.datetime < before && !seen.has(c.datetime)) { seen.add(c.datetime); older.push(c); olderAdded++; }
    pages.push({ edate: edateCursor, rawCount: r.rows.length, resTrCont: r.resTrCont, oldest: pageOldest, newest: pageNewest, olderAdded });
    if (pageNewest && (!respNewest || pageNewest > respNewest)) respNewest = pageNewest;
    if (pageOldest && (!respOldest || pageOldest < respOldest)) respOldest = pageOldest;
    // 다음 edate: 이번 응답 최고(最古) 봉의 하루 전(반드시 과거로 진행 → 무한루프 방지). 빈 응답이면 현재 edate 하루 전.
    const nextBase = pageOldest ? pageOldest.slice(0, 8) : edateCursor;
    let nextEdate = prevYmd(nextBase);
    if (nextEdate >= edateCursor) nextEdate = prevYmd(edateCursor);
    edateCursor = nextEdate;
  }
  older.sort((a, b) => a.datetime.localeCompare(b.datetime));
  return { candles: older, olderCount: older.length, responseNewest: respNewest, responseOldest: respOldest, requestEdateFirst, requestSdate, calls, pages };
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
// 국내 차트 원문 프로브(진단 전용, P0-32A) — 임의 TR(t8410/t8413/t8412 등)을 그대로 호출해 원문 필드 확인용.
//   ⚠️ 필드 매핑을 추측하지 않기 위한 도구: OutBlock1 의 실제 키/샘플행을 그대로 반환한다.
export async function lsDomesticChartRaw(
  token: string, trCd: string, inBlock: Record<string, unknown>, cont: { trCont?: string; trContKey?: string } = {},
): Promise<{ rspCd: string; rspMsg: string; out1: any[]; outBlock: any; diag: LSHttpDiag }> {
  const { data, rspCd, rspMsg, diag } = await lsPost(token, '/stock/chart', trCd, inBlock, cont);
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

// COSAT00301 주문 성공 판정 — 성공코드(00000/00040) 또는 주문번호(OrdNo) 존재.
//   P0-35US6: 00040 "매수 주문이 완료되었습니다."(실계정 PRGO 실측) 을 COSAT00301 성공코드로 등록.
//   ⚠️ 이 Set 은 COSAT00301(isUSOrderSuccess) 전용 — 전역/타 TR 성공판정에 쓰지 않는다.
export const US_ORDER_SUCCESS_CODES = new Set(['00000', '00040']);
export function isUSOrderSuccess(rspCd: string, ordNo: string | null | undefined): boolean {
  return (ordNo != null && ordNo !== '' && ordNo !== '(unknown)') || US_ORDER_SUCCESS_CODES.has(rspCd);
}

// ── COSAT00301 InBlock1 OrdPtnCode(주문유형코드) — LS 공식 Open API 문서 확정(P0-30D) ──
//   01 = 매도주문, 02 = 매수주문, 08 = 취소주문.
// ── COSAT00301 InBlock1 OrdprcPtnCode(호가유형) — 공식: 00=지정가 / (매도확대) 03=시장가, M3=MOO, M4=MOC ──
export const LS_US_ORDPTN_BUY = '02';    // 매수(공식)
export const LS_US_ORDPTN_SELL = '01';   // 매도(공식, P0-30D 확정)
export const LS_US_ORDPTN_CANCEL = '08'; // 취소(공식)
export const LS_US_ORDPRC_PTN_LIMIT = '00';    // 지정가(공식)
export const LS_US_ORDPRC_PTN_MARKET = '03';   // 시장가(공식, 매도)
// P0-30D: 매도 OrdPtnCode='01' 공식 문서로 확정 → 봉인 해제. 실 SELL POST 는 이 코드상수 AND env kill-switch
//   AND LS_LIVE_TRADING 셋 다일 때만(러너 SELL_REAL_ORDER_ENABLED). 호가유형은 지정가('00') 유지(시장가 OvrsOrdPrc
//   규약 미확정 — 아래 placeLSUSSellOrder 주석 참조, 추측 금지).
export const LS_US_SELL_ORDPTN = LS_US_ORDPTN_SELL;
export const LS_US_SELL_TR_CONFIRMED = true;

async function placeLSUSOrderRaw(
  token: string, p: { exchcd: string; symbol: string; qty: number; price: number; ordPtnCode: string },
): Promise<LSOrderResult> {
  const inb = {
    COSAT00301InBlock1: {
      RecCnt: 1, OrdPtnCode: p.ordPtnCode, OrdMktCode: p.exchcd, IsuNo: p.symbol,
      OrdQty: p.qty, OvrsOrdPrc: p.price, OrdprcPtnCode: '00', BrkTpCode: '',
    },
  };
  const { data, rspCd, rspMsg, diag } = await lsPost(token, '/overseas-stock/order', 'COSAT00301', inb);
  // 응답 주문번호 필드는 공식 카탈로그 resExample 이 비어 있어 미확정 → OrdNo 를 담은 OutBlock 을 우선 선택(둘 다 확인).
  //   P0-35US6: OutBlock1 이 존재해도 OrdNo 가 OutBlock2 에 있을 수 있어 'OrdNo 보유 블록' 을 우선한다(단순 || 는 놓칠 수 있음).
  //   확정 주문번호/체결/미체결은 COSAQ00102(계좌주문체결내역조회)로 재조회해 최종 복원한다.
  const b1 = data.COSAT00301OutBlock1, b2 = data.COSAT00301OutBlock2;
  const ob = (b1 && b1.OrdNo != null) ? b1 : (b2 && b2.OrdNo != null) ? b2 : (b1 || b2 || {});
  const ordNo = ob.OrdNo != null ? String(ob.OrdNo) : null;
  return { rspCd, rspMsg, ordNo, raw: data, diag };
}

export async function placeLSUSBuyOrder(
  cfg: LSConfig, token: string, p: { exchcd: string; symbol: string; qty: number; price: number },
): Promise<LSOrderResult> {
  return placeLSUSOrderRaw(token, { ...p, ordPtnCode: LS_US_ORDPTN_BUY });
}

// ── 미국 지정가 매도 주문 (COSAT00301, OrdPtnCode='01'=매도, 공식 확정 P0-30D) ──
// 호가유형은 지정가('00') 유지. ⚠️ 시장가 매도('03')는 공식적으로 정의돼 있으나 OvrsOrdPrc 에 넣을 값(0 등) 규약이
//   공식 문서/기존 코드에서 확인되지 않음(추측 금지) → 시장가는 미구현. 전량청산은 지정가(=bid)로 안전 전송.
export async function placeLSUSSellOrder(
  cfg: LSConfig, token: string, p: { exchcd: string; symbol: string; qty: number; price: number },
): Promise<LSOrderResult> {
  // OrdprcPtnCode 는 placeLSUSOrderRaw 내부 '00'(지정가) 고정. 매도유형 OrdPtnCode='01'.
  return placeLSUSOrderRaw(token, { ...p, ordPtnCode: LS_US_SELL_ORDPTN });
}

// ── 계좌 주문체결내역 조회 (COSAQ00102, /overseas-stock/accno) — 체결/미체결 확인 ──
// InBlock1(공식): RecCnt/QryTpCode/BkseqTpCode/OrdMktCode/BnsTpCode/IsuNo/SrtOrdNo/OrdDt/
//                 ExecYn/CrcyCode/ThdayBnsAppYn/LoanBalHldYn
// OutBlock3(리스트): OrdNo/OrgOrdNo/ShtnIsuNo/OrdQty/ExecQty/UnercQty/OvrsOrdPrc/OrdPtnCode/OrdprcPtnCode ...
export interface LSOrderExec { ordNo: string; orgOrdNo: string; symbol: string; ordQty: number; execQty: number; unfilledQty: number; ordPrc: number; ordPtnCode: string; trxNm: string; }

// ── P0-27a: COSAQ00102 응답 분류(fail-closed) ──────────────────────────────────
// queryOk 를 "HTTP200+JSM" 으로만 판정하지 않는다. 실제 업무오류를 "주문 0건" 으로 오인하면 신규 주문이 잘못 통과되므로
// 아래 4분류로 엄격 판정하고, POST 허용은 호출측이 SUCCESS/EMPTY 에서만 한다.
//   SUCCESS         = rspCd 가 공식 성공코드(00000 등) → rows 신뢰
//   EMPTY           = rspCd 가 "실계정 실측 확인된 자료없음" 코드 → rows=0 정상
//   BUSINESS_ERROR  = HTTP200+JSON 이나 성공/empty 목록에 없는 unknown 업무코드 → fail-closed 차단
//   TRANSPORT_ERROR = network/timeout/HTTP>=400/빈응답/parse/호출제한 → 차단
export type OrderExecClassification = 'SUCCESS' | 'EMPTY' | 'BUSINESS_ERROR' | 'TRANSPORT_ERROR';
// ── P0-27b: COSAQ00102 "정상 자료없음" EMPTY 코드 기본값 — 실계정 실측 확정분 ──
//   02679 "조회내역이 없습니다." = 오늘 주문 0건 상태의 정상 응답(HTTP200·envelope 존재·rawRows=0, 실측 확인).
//   ⚠️ 이 목록의 코드는 rows=0 + 정상 envelope 일 때만 EMPTY. rows>0/비정상 envelope 이면 fail-closed(BUSINESS_ERROR).
export const LS_US_ORDEREXEC_EMPTY_CODES: string[] = ['02679'];
export function classifyOrderExec(input: { transportError?: boolean; rspCd: string; successCodes: string[]; emptyCodes: string[]; rowCount?: number; hasEnvelope?: boolean }): OrderExecClassification {
  if (input.transportError) return 'TRANSPORT_ERROR';
  if (input.successCodes.includes(input.rspCd)) return 'SUCCESS';   // 공식 성공코드 — rows 신뢰(주문 있으면 rows>0 정상)
  if (input.emptyCodes.includes(input.rspCd)) {
    // EMPTY 코드는 "자료없음" 이 응답구조로도 일치할 때만 통과: rows=0 + envelope 정상. 아니면 fail-closed.
    if ((input.rowCount ?? 0) === 0 && input.hasEnvelope !== false) return 'EMPTY';
    return 'BUSINESS_ERROR';   // 02679 인데 rows>0 또는 envelope 비정상 → 통과 금지
  }
  return 'BUSINESS_ERROR';   // 그 밖의 unknown non-success → 절대 통과 금지(fail-closed)
}
// queryOk 는 SUCCESS/EMPTY 에서만 true. (POST 허용은 호출측이 classification 으로 재확인)
export interface LSOrderExecResult {
  queryOk: boolean; classification: OrderExecClassification;
  rspCd: string; rspMsg: string; rows: LSOrderExec[]; hasEnvelope: boolean;
  diag: LSHttpDiag; kind?: LSErrorKind; httpStatus?: number;
}
export async function queryLSUSOrderExec(
  cfg: LSConfig, token: string, p: { exchcd: string; symbol?: string; ordDate: string; execYn?: '0' | '1' | '2' },
  opts: { emptyCodes?: string[] } = {},
): Promise<LSOrderExecResult> {
  // ExecYn: 0=전체, 1=체결, 2=미체결 (공식 InBlock 필드). SrtOrdNo=999999999(전체). QryTpCode/BkseqTpCode=1.
  const inb = {
    COSAQ00102InBlock1: {
      RecCnt: 1, QryTpCode: '1', BkseqTpCode: '1', OrdMktCode: p.exchcd, BnsTpCode: '0',
      IsuNo: p.symbol ?? '', SrtOrdNo: 999999999, OrdDt: p.ordDate, ExecYn: p.execYn ?? '0',
      CrcyCode: '000', ThdayBnsAppYn: '0', LoanBalHldYn: '0',
    },
  };
  const successCodes = LS_SUCCESS_CODES['COSAQ00102'] ?? ['00000'];
  // 실측 확정 기본값(02679) 은 항상 포함 + 사용자 env 추가분 병합(req1·6 — 별도 설정 없어도 02679 적용).
  const emptyCodes = [...LS_US_ORDEREXEC_EMPTY_CODES, ...(opts.emptyCodes ?? [])];
  try {
    // soft=true: HTTP 200 이면 업무코드여도 throw 없이 반환(호출측 classifyOrderExec 로 엄격 분류). transport 오류는 여전히 throw.
    const { data, rspCd, rspMsg, diag } = await lsPost(token, '/overseas-stock/accno', 'COSAQ00102', inb, { soft: true });
    const outBlock3 = data.COSAQ00102OutBlock3;
    const hasEnvelope = data != null && (rspCd !== '' || outBlock3 !== undefined);
    const rows: LSOrderExec[] = (outBlock3 || []).map((r: any) => ({
      ordNo: String(r.OrdNo ?? ''), orgOrdNo: String(r.OrgOrdNo ?? ''),
      symbol: String(r.ShtnIsuNo ?? r.IsuNo ?? ''),
      ordQty: toNum(r.OrdQty), execQty: toNum(r.ExecQty), unfilledQty: toNum(r.UnercQty),
      ordPrc: toNum(r.OvrsOrdPrc), ordPtnCode: String(r.OrdPtnCode ?? ''), trxNm: String(r.OrdTrxPtnNm ?? ''),
    }));
    // rows/envelope 를 함께 판정 — 02679 라도 rows>0/비정상 envelope 이면 EMPTY 아님(fail-closed, req3).
    const classification = classifyOrderExec({ rspCd, successCodes, emptyCodes, rowCount: rows.length, hasEnvelope });
    const queryOk = classification === 'SUCCESS' || classification === 'EMPTY';
    // BUSINESS_ERROR(unknown 코드/불일치)면 rows 를 신뢰하지 않는다(비워서 반환) — 잘못된 0건 통과 방지.
    return { queryOk, classification, rspCd, rspMsg, rows: queryOk ? rows : [], hasEnvelope, diag, httpStatus: diag.status };
  } catch (e) {
    // 여기 도달 = transport 실패(네트워크/timeout/빈응답/JSON오류/HTTP>=400/호출제한). 안전차단.
    const kind: LSErrorKind = e instanceof LSApiError ? e.kind : 'INVALID_RESPONSE';
    const rspCd = e instanceof LSApiError ? (e.rspCd ?? `ERR(${e.kind})`) : 'EXCEPTION';
    const diag = (e instanceof LSApiError ? e.diag : undefined) ?? ({} as LSHttpDiag);
    return { queryOk: false, classification: 'TRANSPORT_ERROR', rspCd, rspMsg: e instanceof Error ? e.message : String(e), rows: [], hasEnvelope: false, diag, kind, httpStatus: diag.status };
  }
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
  // ── 후보 필드(P0-18) — HTS "타통화+원화 가능수량" 결정 필드 실측대조용 ──
  t4FcurrDps: number;         // OutBlock3 USD T4FcurrDps (T+4 외화예수금)
  fcurrOrdAmt: number;        // OutBlock3 USD FcurrOrdAmt (외화주문금액)
  fcurrMxchgAbleAmt: number;  // OutBlock3 USD FcurrMxchgAbleAmt (외화환전가능금액)
  fcurrPldgAmt: number;       // OutBlock3 USD FcurrPldgAmt (외화담보금액 — 담보/증거금 성격)
  loanAmt: number;            // OutBlock3 USD LoanAmt (대출금액 — 있으면 cash-only 아님)
  usdDeposit: number;         // 하위호환: = usdCash
  rawMasked: any;             // 민감정보(AcntNo/Pwd 등) 마스킹한 COSOQ02701 전체 응답(진단 출력용)
}
// LS 응답에서 계좌번호/비밀번호 등 민감 키를 재귀적으로 마스킹.
const LS_SENSITIVE_KEY = /acntno|passwd|\bpwd\b|password|account/i;
export function maskLSResponse(obj: any): any {
  if (Array.isArray(obj)) return obj.map(maskLSResponse);
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) out[k] = LS_SENSITIVE_KEY.test(k) ? '****' : maskLSResponse(v);
    return out;
  }
  return obj;
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
    t4FcurrDps: usd ? toNum(usd.T4FcurrDps) : 0,
    fcurrOrdAmt: usd ? toNum(usd.FcurrOrdAmt) : 0,
    fcurrMxchgAbleAmt: usd ? toNum(usd.FcurrMxchgAbleAmt) : 0,
    fcurrPldgAmt: usd ? toNum(usd.FcurrPldgAmt) : 0,
    loanAmt: usd ? toNum(usd.LoanAmt) : 0,
    usdDeposit: usdCash,   // 하위호환
    rawMasked: maskLSResponse(data),
  };
}

// ── cash-only 주문가능수량 판정 (P0-16 재검토) — 확인된 필드만 사용, 나머지는 하드 차단 ──
// 확정(실계정 결정적 일치):
//   · "거래국가 통화 가능수량" = FcurrOrdAbleAmt(외화주문가능, USD 현금만) ÷ 주문가. 실계정 0 == HTS 0(정확일치).
// 미확정(⚠️ 추측 금지 — LIVE 하드 차단):
//   · "타통화+원화 가능수량"(통합증거금/선환전)을 결정하는 공식 필드는 아직 실측 확인 안 됨. 사용자가 올린 "2" 는
//     조회결과가 아니라 주문창 수량 입력값(버튼 라벨 오해)이었다. PrexchOrdAbleAmt(선환전주문가능)를 그 값으로 단정
//     불가: 실계정 PrexchOrdAbleAmt=97.29USD 인데 AAPL≈311USD → 정수주 0. 통합증거금 신청 후 값이 바뀌는지,
//     HTS 버튼을 실제로 눌렀을 때 어떤 필드/팝업이 수량을 결정하는지 사용자 실측 확인 전까지 이 경로는 신뢰하지 않는다.
//   · OvrsMgn==0 은 '현재 미수 잔액 없음' 을 뜻할 수 있어도, PrexchOrdAbleAmt 가 전체 통합증거금 주문가능액이라는
//     근거가 되지 못한다(별개 사실). 따라서 코드상수로 봉인한다.
// ── P0-20: 실계정 실측 검증 완료 → 통합증거금(타통화+원화) 경로 확정 ──
// HTS "타통화+원화 가능수량"=2 와 프로그램 WonDpsBalAmt/MnyoutAbleAmt/WonCashMin qty=2 정확 일치 확인.
// cashOnly=true(OvrsMgn=0/LoanAmt=0). 안전 우선으로 WonCashMin=min(WonDpsBalAmt,MnyoutAbleAmt) 채택.
//   → LS_US_CROSS_WON_TR_CONFIRMED=true 전환. CROSS_WON_ADOPTED_FIELD='WonCashMin'(아래).
// 통합증거금이라도 신용/미수/대출 금지·현금 범위만: OvrsMgn/LoanAmt 중 하나라도 >0 이면 차단.
// ⚠️ P0-29B: 외화담보(FcurrPldgAmt)는 차단 기준에서 제외(진단만). 담보는 대응 차입이 있어야 레버리지인데
//    OvrsMgn/LoanAmt=0 이면 차입이 없어 레버리지가 아니다(체결 후 정상 결제/보유 금액). isCashOnly() 참조.
export const LS_US_CROSS_WON_TR_CONFIRMED = true;   // 실측 검증 완료(P0-20)
export type USPaymentMode = 'USD' | 'KRW' | 'NONE';
export interface USCashDecision {
  paymentMode: USPaymentMode; orderAllowed: boolean; reason: string;
  usdCash: number; krwCash: number; baseXchRate: number; overseasMargin: number;
  estimatedUsd: number; estimatedKrw: number; cashOnlyUsdCap: number;
  qtyCountry: number;    // "거래국가 통화 가능수량"(USD 현금만) = floor(FcurrOrdAbleAmt / price) [확정]
  qtyCrossWon: number;   // 참고표시용: floor(PrexchOrdAbleAmt / price) [미확정 — LIVE 판정에 미사용]
  crossWonVerified: boolean;   // 타통화+원화 경로 실측확인 여부(=env AND 코드상수). false 면 해당 경로 LIVE 차단.
}
// 계좌가 순수현금으로 결제 가능한 최대 USD 명목금액. OvrsMgn>0 → 0.
// 기본: USD 현금(FcurrOrdAbleAmt)만. 타통화+원화(채택필드) 는 실측확인(crossWonVerified)된 경우에만 USD환산 포함.
//   trader 의 USD 명목 현금게이트가 통합증거금(KRW) 결제 능력을 과소평가해 정상주문을 막지 않도록 채택필드 USD환산치를 합산.
export function usCashOnlyUsdCap(dep: LSUSDeposit, opts: { crossWonVerified?: boolean } = {}): number {
  if (!dep.ok || dep.overseasMargin > 0) return 0;   // 미수/증거금 사용 계좌 → cash-only 불가
  const verified = !!opts.crossWonVerified && LS_US_CROSS_WON_TR_CONFIRMED;
  return verified ? Math.max(dep.usdOrderable, crossWonAdoptedUsdCap(dep)) : dep.usdOrderable;
}
// 진단표시용 주문가능수량(거래국가/타통화+원화). qtyCrossWon 은 참고용일 뿐 LIVE 판정 근거가 아니다.
export function usOrderableQty(dep: LSUSDeposit, priceUsd: number): { qtyCountry: number; qtyCrossWon: number } {
  if (!dep.ok || dep.overseasMargin > 0 || !(priceUsd > 0)) return { qtyCountry: 0, qtyCrossWon: 0 };
  return {
    qtyCountry: Math.floor(dep.usdOrderable / priceUsd),        // 거래국가 통화(USD 현금) [확정]
    qtyCrossWon: Math.floor(dep.usdPrexchOrderable / priceUsd), // 타통화+원화 선환전 [미확정·참고]
  };
}
// ── 미국장 세션 판정 (P0-35US3) — IANA America/New_York(DST 자동) 로 ET 시각/세션을 결정. 추측 없음. ──
//   orderableQty(예수금 COSOQ02701 기반)는 세션과 무관(현금 기반)이지만, '장전이라 0' 오해를 진단으로 배제하기 위해 노출.
//   세션 경계(ET): PRE_MARKET 04:00–09:30 · REGULAR 09:30–16:00 · AFTER_HOURS 16:00–20:00 · 그 외 CLOSED · 주말 CLOSED_WEEKEND.
export type USMarketSession = 'PRE_MARKET' | 'REGULAR' | 'AFTER_HOURS' | 'CLOSED' | 'CLOSED_WEEKEND';
export function usEtSession(now: Date): { etTime: string; session: USMarketSession; minutesEt: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const p: Record<string, string> = {};
  for (const x of parts) p[x.type] = x.value;
  const hh = Number(p.hour) % 24;   // 일부 런타임이 자정을 '24' 로 반환 → 0 으로 정규화
  const mm = Number(p.minute);
  const minutesEt = hh * 60 + mm;
  const wd = p.weekday;
  const etTime = `${p.year}-${p.month}-${p.day} ${String(hh).padStart(2, '0')}:${p.minute} ET(${wd})`;
  let session: USMarketSession;
  if (wd === 'Sat' || wd === 'Sun') session = 'CLOSED_WEEKEND';
  else if (minutesEt < 4 * 60) session = 'CLOSED';
  else if (minutesEt < 9 * 60 + 30) session = 'PRE_MARKET';
  else if (minutesEt < 16 * 60) session = 'REGULAR';
  else if (minutesEt < 20 * 60) session = 'AFTER_HOURS';
  else session = 'CLOSED';
  return { etTime, session, minutesEt };
}
export function decideUSCashPayment(dep: LSUSDeposit, priceUsd: number, qty: number, opts: { crossWonVerified?: boolean } = {}): USCashDecision {
  const estimatedUsd = priceUsd * qty;
  const { qtyCountry, qtyCrossWon } = usOrderableQty(dep, priceUsd);
  const crossWonVerified = !!opts.crossWonVerified && LS_US_CROSS_WON_TR_CONFIRMED;   // 코드상수로 최종 봉인
  const base = {
    usdCash: dep.usdCash, krwCash: dep.krwCash, baseXchRate: dep.baseXchRate, overseasMargin: dep.overseasMargin,
    estimatedUsd, estimatedKrw: estimatedUsd * (dep.baseXchRate > 0 ? dep.baseXchRate : 0),
    cashOnlyUsdCap: usCashOnlyUsdCap(dep, { crossWonVerified }), qtyCountry, qtyCrossWon, crossWonVerified,
  };
  if (!dep.ok) return { ...base, paymentMode: 'NONE', orderAllowed: false, reason: 'INVALID_RESPONSE' };
  if (dep.overseasMargin > 0) return { ...base, paymentMode: 'NONE', orderAllowed: false, reason: 'MARGIN_PRESENT' };
  if (!(priceUsd > 0) || !(qty > 0)) return { ...base, paymentMode: 'NONE', orderAllowed: false, reason: 'INVALID_PRICE' };
  // (2) 거래국가 통화(USD 현금) 로 필요수량 결제 가능 — 확정 경로만 LIVE 허용
  if (qtyCountry >= qty) return { ...base, paymentMode: 'USD', orderAllowed: true, reason: 'USD_CASH' };
  // (3) 타통화+원화 선환전 — 실측확인(crossWonVerified) 전까지 절대 허용 금지(하드 차단)
  if (qtyCrossWon >= qty && crossWonVerified) return { ...base, paymentMode: 'KRW', orderAllowed: true, reason: 'CROSS_WON_PREXCH_VERIFIED' };
  if (qtyCrossWon >= qty && !crossWonVerified) return { ...base, paymentMode: 'NONE', orderAllowed: false, reason: 'CROSS_WON_UNVERIFIED' };
  return { ...base, paymentMode: 'NONE', orderAllowed: false, reason: 'ORDERABLE_QTY_INSUFFICIENT' };
}

// ── P0-29A/B: 미국 실거래 주문수량 산정 (maxQty=1 하드제한 없음 → 통합증거금 orderableQty + 1회 거래예산 결합) ──
// 원칙(안전 최우선):
//   · 전량매수 금지: qty=orderableQty(가용 전량) 로 사지 않는다. 1회 거래예산(perTradeBudgetUsd)으로 상한을 둔다.
//   · fail-closed: 예산(LS_US_PER_TRADE_BUDGET_USD) 미설정/비정상(<=0) 이면 주문 금지(finalQty=0, allowed=false).
//   · P0-29B 근본수정: orderableQty 는 호출측이 산정한 '통합증거금(crossWon) 기준 매수가능 주수'를 그대로 받는다.
//     USD현금(FcurrOrdAbleAmt)=0 이라는 이유로 orderableQty 를 0 으로 만들지 않는다(체결 후 차단 버그 제거).
//   · finalQty = min(orderableQty, floor(perTradeBudgetUsd / bestAsk)) [설정 시 maxQty 상한 추가 적용].
//   · eligibleForLiveSelection: 이 종목이 '실주문 후보'로 유효한가 = 예산으로 최소 1주 이상 살 수 있고 현금여력도 ≥1주.
//     예산보다 1주가 비싼 종목(budgetQty=0)은 false → 러너가 다음 BUY 후보로 넘어간다(SIZE_GATE 무한반복 방지).
export interface USQtyDecision {
  allowed: boolean;
  finalQty: number;
  orderableQty: number;   // 통합증거금(crossWon) 기준 매수가능 주수(호출측 산정)
  budgetQty: number;      // 1회 거래예산 기준 주수 = floor(perTradeBudgetUsd / bestAsk)
  eligibleForLiveSelection: boolean;   // 예산으로 ≥1주 && 현금여력 ≥1주 && 가격>0 && 예산설정
  reason: string;         // 'OK' | 'PRICE_UNAVAILABLE' | 'BUDGET_UNSET' | 'CASH_INSUFFICIENT' | 'BUDGET_TOO_SMALL'
}
export function computeUSOrderQty(p: {
  perTradeBudgetUsd: number | null;   // LS_US_PER_TRADE_BUDGET_USD. null/<=0 = 미설정 → fail-closed
  orderableQty: number;               // 통합증거금(crossWon) 기준 매수가능 주수 — 호출측이 evaluateCrossWon.programQty 등으로 산정
  bestAsk: number;                    // 매수 지정가(=GSH ask) USD
  maxQty?: number | null;             // 선택적 안전 상한(설정 시). 미설정=null → 예산이 상한을 결정
}): USQtyDecision {
  const orderableQty = Math.max(0, Math.floor(p.orderableQty));
  const zero = { finalQty: 0, orderableQty, budgetQty: 0, eligibleForLiveSelection: false };
  if (!(p.bestAsk > 0)) return { ...zero, allowed: false, reason: 'PRICE_UNAVAILABLE' };
  // fail-closed: 예산 미설정/비정상 → 절대 주문하지 않는다(전량매수 방지의 핵심 장치).
  if (p.perTradeBudgetUsd == null || !(p.perTradeBudgetUsd > 0)) return { ...zero, allowed: false, reason: 'BUDGET_UNSET' };
  const budgetQty = Math.max(0, Math.floor(p.perTradeBudgetUsd / p.bestAsk));
  if (orderableQty < 1) return { finalQty: 0, orderableQty, budgetQty, eligibleForLiveSelection: false, allowed: false, reason: 'CASH_INSUFFICIENT' };
  if (budgetQty < 1) return { finalQty: 0, orderableQty, budgetQty, eligibleForLiveSelection: false, allowed: false, reason: 'BUDGET_TOO_SMALL' };
  let finalQty = Math.min(orderableQty, budgetQty);
  if (p.maxQty != null && p.maxQty > 0) finalQty = Math.min(finalQty, Math.floor(p.maxQty));
  const ok = finalQty >= 1;
  return { finalQty, orderableQty, budgetQty, eligibleForLiveSelection: ok, allowed: ok, reason: ok ? 'OK' : 'QTY_ZERO' };
}
// [US-SIZE] 수량산정 진단 로그 한 줄(요구 형식).
export function formatUSSize(symbol: string, d: USQtyDecision, p: { perTradeBudgetUsd: number | null; bestAsk: number }): string {
  return `[US-SIZE ${symbol}] bestAsk=${p.bestAsk.toFixed(2)} perTradeBudgetUSD=${p.perTradeBudgetUsd == null ? '미설정' : p.perTradeBudgetUsd.toFixed(2)}`
    + ` crossWonOrderableQty=${d.orderableQty} budgetQty=${d.budgetQty} finalQty=${d.finalQty}`
    + ` eligibleForLiveSelection=${d.eligibleForLiveSelection} reason=${d.reason}`;
}

// ── P0-30A: 미국장 실전용 일일 BUY 가드 (하루 1회 테스트 제한 해제 → 운영상한 기반) ──
// 계정 단위 '오늘 매수 횟수(buyCount)' 가 운영상한(buyLimit) 미만이어야 신규 BUY 허용.
//   · buyLimit 은 LS_US_DAILY_MAX_BUYS(운영상한). 코드가 ===1 을 필수조건으로 요구하지 않는다(무제한 난사만 금지).
//   · 실제 신규매수 총 가드는 이것 외에도 1회예산(P0-29)/통합증거금 수량/동일종목 재진입 금지/동일 candle 중복 POST 금지/
//     pending 중복 금지가 각각 독립적으로 작동한다(여기서는 '일일 계정 매수횟수'만 판정).
//   · SELL(보유청산/손절/익절)은 이 가드와 무관 — 절대 횟수로 막지 않는다(별도: 보유수량/pending SELL/체결상태).
export interface USDailyBuyGate { buyCount: number; buyLimit: number; canNewBuy: boolean; reason: string; }
export function computeUSDailyBuyGate(p: { buyCount: number; buyLimit: number }): USDailyBuyGate {
  const buyCount = Math.max(0, Math.floor(p.buyCount));
  const buyLimit = Math.floor(p.buyLimit);
  if (!(buyLimit > 0)) return { buyCount, buyLimit, canNewBuy: false, reason: 'BUY_DISABLED(limit<=0)' };
  if (buyCount >= buyLimit) return { buyCount, buyLimit, canNewBuy: false, reason: 'DAILY_BUY_LIMIT_REACHED' };
  return { buyCount, buyLimit, canNewBuy: true, reason: 'OK' };
}
// [US-DAILY-GUARD] — 신규 BUY 허용/차단 근거를 한 줄로. realizedPnL/dailyTarget/dailyLossLimit 은 현재 미구현(n/a).
//   (일일 목표수익/손실한도 로직은 미국 LS 러너에 존재하지 않음 — 임의구현 금지, 값 있으면 그대로 표시)
export function formatUSDailyGuard(o: {
  buyCount: number; buyLimit: number; sellCount: number;
  realizedPnL: number | null; dailyTarget: number | null; dailyLossLimit: number | null;
  canNewBuy: boolean; reason: string;
}): string {
  const na = (v: number | null) => v == null ? 'n/a(미구현)' : String(v);
  return `[US-DAILY-GUARD] buyCount=${o.buyCount} buyLimit=${o.buyLimit} sellCount=${o.sellCount}`
    + ` realizedPnL=${na(o.realizedPnL)} dailyTarget=${na(o.dailyTarget)} dailyLossLimit=${na(o.dailyLossLimit)}`
    + ` canNewBuy=${o.canNewBuy} reason=${o.reason}`;
}

// ── ARMED cashOrderable 한 줄 로그 (P0-17) — 항상 캐시 기준. "미조회" 는 절대 출력하지 않는다 ──
// 성공(ok): `cashOrderable=<금액> USD (rsp_cd=...)`. 실패: `cashOrderable=조회실패 rsp_cd=... rsp_msg=...`.
// rspMsg 는 호출측에서 마스킹(scrub) 후 넘긴다.
export function formatCashOrderableLine(s: { ok: boolean; cash: number; rspCd: string; rspMsg: string }): string {
  return s.ok
    ? `cashOrderable=${s.cash.toFixed(2)} USD (rsp_cd=${s.rspCd})`
    : `cashOrderable=조회실패 rsp_cd=${s.rspCd} rsp_msg=${s.rspMsg}`;
}

// ── 통합증거금(타통화+원화) 주문가능수량 실측대조 엔진 (P0-18/19/20) ──
// P0-20 실측 검증 완료: HTS "타통화+원화 가능수량"=2 ↔ WonDpsBalAmt/MnyoutAbleAmt/WonCashMin qty=2 정확 일치.
//   안전 우선 WonCashMin=min(WonDpsBalAmt,MnyoutAbleAmt) 채택(초과주문 방지). cashOnly=true 확인.
// cash-only 원칙: 신용/미수/대출/증거금(담보) 잔액이 하나라도 >0 이면 cashOnly=false → 주문 금지.
export type CrossWonFieldKey =
  | 'FcurrOrdAbleAmt' | 'PrexchOrdAbleAmt' | 'FcurrOrdAmt' | 'FcurrMxchgAbleAmt' | 'T4FcurrDps'
  | 'WonPrexchAbleAmt' | 'WonDpsBalAmt' | 'MnyoutAbleAmt' | 'WonCashMin';
export interface CrossWonCandidate {
  key: CrossWonFieldKey; label: string; basis: 'USD' | 'KRW';
  amount: number; perShareCost: number; qty: number; match: boolean | null;
}
export interface CrossWonEval {
  bestAsk: number; baseXchRate: number; htsQty: number | null;
  candidates: CrossWonCandidate[];
  adoptedField: CrossWonFieldKey | null;
  programQty: number;              // 채택 필드 기준(미채택이면 0)
  matchedKeys: CrossWonFieldKey[]; // htsQty 와 정확히 일치한 후보들(실측 대조 결과)
  match: boolean | null;           // htsQty!=null && 채택필드 있음 && programQty===htsQty
  cashOnly: boolean;               // P0-29B: 미수(OvrsMgn)/대출(LoanAmt) 전부 0(=차입 없음)
  cashOnlyBlockers: string[];      // cashOnly=false 사유(필드=값) — 미수/대출만
  pledgeNote: string;              // P0-29B: 외화담보(FcurrPldgAmt) 진단 메모(차단 아님). 없으면 ''
  crossWonConfirmed: boolean;      // 코드상수(공식 필드 확정) — false 면 절대 허용 금지
  orderAllowed: boolean;
  reason: string;
}
// P0-20: 실측 검증 완료 → 안전 우선 WonCashMin(=min(WonDpsBalAmt,MnyoutAbleAmt)) 채택.
export const CROSS_WON_ADOPTED_FIELD: CrossWonFieldKey | null = 'WonCashMin';

// ── P0-29B: cash-only(레버리지 없음) 판정 — 미수/대출만 권위 기준 ──
// 권위 필드: OvrsMgn(해외증거금/미수) 와 LoanAmt(대출). 둘 중 하나라도 >0 이면 차입/레버리지 사용 → cash-only 아님.
// 외화담보(FcurrPldgAmt)는 '대응 차입을 뒷받침하는 담보' 성격이라 차입(OvrsMgn/LoanAmt)이 0 이면 레버리지가 될 수 없다.
//   실계정에서 소액 체결 후 FcurrPldgAmt>0 이 나타나도(OvrsMgn=0/LoanAmt=0) 정상 결제/보유 관련 금액이므로
//   단독으로 cash-only 를 깨지 않는다(추측 아님 — 담보는 차입 잔액이 있어야 레버리지라는 결정적 관계). 진단으로만 노출.
export function isCashOnly(dep: LSUSDeposit): boolean {
  return dep.overseasMargin <= 0 && dep.loanAmt <= 0;
}

// 채택 필드의 금액(원자료)과 통화기준. usCashOnlyUsdCap 이 trader USD 명목게이트용으로 USD 환산에 사용.
export function crossWonAdoptedAmount(dep: LSUSDeposit): { amount: number; basis: 'USD' | 'KRW' } | null {
  switch (CROSS_WON_ADOPTED_FIELD) {
    case 'FcurrOrdAbleAmt': return { amount: dep.usdOrderable, basis: 'USD' };
    case 'PrexchOrdAbleAmt': return { amount: dep.usdPrexchOrderable, basis: 'USD' };
    case 'FcurrOrdAmt': return { amount: dep.fcurrOrdAmt, basis: 'USD' };
    case 'FcurrMxchgAbleAmt': return { amount: dep.fcurrMxchgAbleAmt, basis: 'USD' };
    case 'T4FcurrDps': return { amount: dep.t4FcurrDps, basis: 'USD' };
    case 'WonPrexchAbleAmt': return { amount: dep.krwPrexchable, basis: 'KRW' };
    case 'WonDpsBalAmt': return { amount: dep.krwCash, basis: 'KRW' };
    case 'MnyoutAbleAmt': return { amount: dep.krwWithdrawable, basis: 'KRW' };
    case 'WonCashMin': return { amount: Math.min(dep.krwCash, dep.krwWithdrawable), basis: 'KRW' };
    default: return null;
  }
}
// 채택 통합증거금 경로의 cash-only USD 환산 상한. 확정(코드상수)·cashOnly 아니면 0.
// P0-29B: cash-only 판정은 미수(OvrsMgn)/대출(LoanAmt) 만 기준. 외화담보(FcurrPldgAmt)는 대응 차입이 있어야
//   레버리지이므로 단독으로 상한을 0 으로 만들지 않는다(isCashOnly 참조). 이 필드 때문에 crossWon 상한이 사라져
//   실주문 여력이 있는데도 차단되던 버그(체결 후 FcurrPldgAmt>0)를 수정.
export function crossWonAdoptedUsdCap(dep: LSUSDeposit): number {
  if (!dep.ok || !isCashOnly(dep)) return 0;   // cash-only(미수/대출 0) 아니면 0
  if (!LS_US_CROSS_WON_TR_CONFIRMED || CROSS_WON_ADOPTED_FIELD == null) return 0;
  const a = crossWonAdoptedAmount(dep);
  if (!a) return 0;
  return a.basis === 'USD' ? a.amount : (dep.baseXchRate > 0 ? a.amount / dep.baseXchRate : 0);
}

export function evaluateCrossWon(dep: LSUSDeposit, bestAsk: number, htsQty: number | null): CrossWonEval {
  const rate = dep.baseXchRate;
  const usdCost = bestAsk;                 // USD 기준 1주 비용
  const krwCost = bestAsk * rate;          // KRW 기준 1주 비용(환산)
  const mk = (key: CrossWonFieldKey, label: string, basis: 'USD' | 'KRW', amount: number): CrossWonCandidate => {
    const perShareCost = basis === 'USD' ? usdCost : krwCost;
    const qty = (dep.ok && perShareCost > 0) ? Math.floor(amount / perShareCost) : 0;
    return { key, label, basis, amount, perShareCost, qty, match: htsQty == null ? null : qty === htsQty };
  };
  const candidates: CrossWonCandidate[] = [
    mk('FcurrOrdAbleAmt', '외화주문가능(거래국가 통화·USD현금)', 'USD', dep.usdOrderable),
    mk('PrexchOrdAbleAmt', '선환전 주문가능(USD)', 'USD', dep.usdPrexchOrderable),
    mk('FcurrOrdAmt', '외화주문금액(USD)', 'USD', dep.fcurrOrdAmt),
    mk('FcurrMxchgAbleAmt', '외화환전가능(USD)', 'USD', dep.fcurrMxchgAbleAmt),
    mk('T4FcurrDps', 'T+4 외화예수금(USD)', 'USD', dep.t4FcurrDps),
    mk('WonPrexchAbleAmt', '원화 선환전 가능(KRW)', 'KRW', dep.krwPrexchable),
    mk('WonDpsBalAmt', '원화예수금잔고(KRW)', 'KRW', dep.krwCash),
    mk('MnyoutAbleAmt', '출금가능(KRW)', 'KRW', dep.krwWithdrawable),
    // 안전 우선 합성 후보 — 실제현금 두 지표 중 작은 값(초과주문 방지). 공식 근거 확인 전 임의 채택 금지.
    mk('WonCashMin', '원화현금 한도 min(WonDpsBalAmt,MnyoutAbleAmt)', 'KRW', Math.min(dep.krwCash, dep.krwWithdrawable)),
  ];
  const matchedKeys = htsQty == null ? [] : candidates.filter(c => c.qty === htsQty).map(c => c.key);
  // P0-29B cash-only: 미수(OvrsMgn)/대출(LoanAmt) 잔액만 권위 차단 기준(둘 다 0 이어야 cash-only).
  //   외화담보(FcurrPldgAmt)는 차입이 있어야 레버리지 → OvrsMgn/LoanAmt=0 이면 단독으로 차단하지 않고 진단만 노출.
  const cashOnlyBlockers: string[] = [];
  if (dep.overseasMargin > 0) cashOnlyBlockers.push(`OvrsMgn=${dep.overseasMargin}`);
  if (dep.loanAmt > 0) cashOnlyBlockers.push(`LoanAmt=${dep.loanAmt}`);
  const cashOnly = isCashOnly(dep);   // = cashOnlyBlockers.length === 0 (미수/대출 기준). FcurrPldgAmt 는 진단전용.
  const pledgeNote = dep.fcurrPldgAmt > 0 ? `FcurrPldgAmt=${dep.fcurrPldgAmt}(외화담보·차입0이면 정상보유)` : '';

  const adoptedField = CROSS_WON_ADOPTED_FIELD;
  const adopted = adoptedField ? candidates.find(c => c.key === adoptedField) ?? null : null;
  const programQty = adopted ? adopted.qty : 0;
  const match = (htsQty != null && adopted != null) ? programQty === htsQty : null;
  const crossWonConfirmed = LS_US_CROSS_WON_TR_CONFIRMED;

  // P0-20 게이트: 확정(코드상수)+채택필드 이후에는 HTS 값 제공 시에만 불일치 차단(BUY 게이트는 qty>=1 && cashOnly).
  let reason = 'OK';
  if (!dep.ok) reason = 'INVALID_RESPONSE';
  else if (!(bestAsk > 0)) reason = 'PRICE_UNAVAILABLE';
  else if (!crossWonConfirmed) reason = 'CROSS_WON_UNCONFIRMED';   // 코드상수 미확정 → 하드차단
  else if (adopted == null) reason = 'NO_ADOPTED_FIELD';
  else if (htsQty != null && programQty !== htsQty) reason = 'HTS_QTY_MISMATCH';   // 제공된 경우에만 불일치 차단
  else if (!cashOnly) reason = 'NOT_CASH_ONLY';                    // 신용/미수/대출/담보 잔액 있으면 차단
  else if (programQty < 1) reason = 'CROSS_WON_INSUFFICIENT';      // 가능수량 0 → 차단
  const orderAllowed = reason === 'OK';

  return {
    bestAsk, baseXchRate: rate, htsQty, candidates, adoptedField, programQty,
    matchedKeys, match, cashOnly, cashOnlyBlockers, pledgeNote, crossWonConfirmed, orderAllowed, reason,
  };
}
// [CROSS-WON-CHECK] 최종 로그 라인(요구 형식).
export function formatCrossWonCheck(symbol: string, e: CrossWonEval): string {
  return `[CROSS-WON-CHECK ${symbol}] bestAsk=${e.bestAsk.toFixed(2)} HTS orderableQty=${e.htsQty == null ? '미입력' : e.htsQty}`
    + ` PROGRAM orderableQty=${e.adoptedField ? e.programQty : '미채택'} MATCH=${e.match == null ? 'N/A' : e.match}`
    + ` paymentMode=CROSS_WON cashOnly=${e.cashOnly} orderAllowed=${e.orderAllowed}${e.orderAllowed ? '' : ` (${e.reason})`}`;
}
// [US-LIVE-GATE] — 최종 실거래 게이트 로그(P0-20 활성화). POST_ALLOWED 는 실제 주문 허용 최종 판정.
//   POST_ALLOWED = LS_LIVE_TRADING && US_LIVE_READY && CROSS_WON_VERIFIED && evaluateCrossWon.orderAllowed(qty>=1&&cashOnly).
export function formatUSLiveGate(symbol: string, o: { liveTrading: boolean; usLiveReady: boolean; crossWonVerified: boolean; e: CrossWonEval }): string {
  const postAllowed = o.liveTrading && o.usLiveReady && o.crossWonVerified && o.e.orderAllowed;
  return `[US-LIVE-GATE ${symbol}] LS_LIVE_TRADING=${o.liveTrading} US_LIVE_READY=${o.usLiveReady}`
    + ` CROSS_WON_VERIFIED=${o.crossWonVerified} HTS_QTY=${o.e.htsQty == null ? '미입력' : o.e.htsQty}`
    + ` PROGRAM_QTY=${o.e.programQty} cashOnly=${o.e.cashOnly} paymentMode=CROSS_WON`
    + ` POST_ALLOWED=${postAllowed}${postAllowed ? '' : ` (${o.e.orderAllowed ? 'GATE_OFF' : o.e.reason})`}`;
}
// [CROSS-WON-LIVE-CAND] — 최초 유효 bestAsk>0 수신 직후, 실계정 후보별 수량을 실측 대조용으로 출력(P0-19).
export function formatCrossWonLiveCand(symbol: string, e: CrossWonEval): string {
  const lines = [`[CROSS-WON-LIVE-CAND ${symbol}]`, `bestAsk=${e.bestAsk.toFixed(2)}`, `BaseXchrat=${e.baseXchRate.toFixed(2)}`];
  for (const c of e.candidates) lines.push(`${c.key}=${c.amount} → qty=${c.qty}${c.match === true ? ' ✓HTS일치' : ''}`);
  lines.push(`HTS=${e.htsQty == null ? '미입력' : e.htsQty}`);
  if (e.htsQty != null) lines.push(`HTS(${e.htsQty})일치후보=[${e.matchedKeys.join(', ') || '없음'}]`);
  return lines.join('\n');
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
// P0-30E fail-closed: rsp_cd 가 TR별 성공코드(00000/00001/02679) 이고 envelope(rsp_cd 또는 OutBlock 존재)가 정상일 때만
//   ok=true. network/timeout/HTTP/JSON오류/unknown 업무코드는 lsPost 가 throw(비-soft) → 호출측 catch=실패.
//   rsp_cd 결측(빈 envelope) 이나 OutBlock4 가 배열 아님 → ok=false(malformed, 잘못된 '보유 0' 오인 방지).
export interface LSUSHolding { symbol: string; balQty: number; sellableQty: number; }
export interface LSUSHoldingsResult { ok: boolean; rspCd: string; rspMsg: string; hasEnvelope: boolean; holdings: LSUSHolding[]; rawRows: number; diag: LSHttpDiag; }
export async function getLSUSHoldings(cfg: LSConfig, token: string, baseDateYYYYMMDD: string): Promise<LSUSHoldingsResult> {
  const { data, rspCd, rspMsg, diag } = await lsPost(token, '/overseas-stock/accno', 'COSOQ00201', {
    COSOQ00201InBlock1: { RecCnt: 1, BaseDt: baseDateYYYYMMDD, CrcyCode: 'ALL', AstkBalTpCode: '00' },
  });
  const ob4 = data?.COSOQ00201OutBlock4;
  // envelope 정상: rsp_cd 존재 또는 어떤 OutBlock 이라도 존재. OutBlock4 는 있으면 배열이어야 정상.
  const anyBlock = data && (data.COSOQ00201OutBlock1 !== undefined || data.COSOQ00201OutBlock2 !== undefined || data.COSOQ00201OutBlock3 !== undefined || ob4 !== undefined);
  const ob4Valid = ob4 === undefined || Array.isArray(ob4);   // 없으면(빈 보유) 정상, 있으면 배열이어야
  const hasEnvelope = (rspCd !== '' || anyBlock) && ob4Valid;
  const success = (LS_SUCCESS_CODES['COSOQ00201'] ?? ['00000']).includes(rspCd);   // 00000/00001/02679 (TR별)
  const ok = success && hasEnvelope;
  const rows: any[] = Array.isArray(ob4) ? ob4 : [];
  const holdings = ok ? rows.map(r => ({
    symbol: String(r.ShtnIsuNo ?? ''), balQty: toNum(r.AstkBalQty), sellableQty: toNum(r.AstkSellAbleQty),
  })).filter(h => h.symbol && h.balQty > 0) : [];
  return { ok, rspCd, rspMsg, hasEnvelope, holdings, rawRows: rows.length, diag };
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
// ── KR MbrNo(거래소 라우팅) 공용 resolver (P0-35P8) — 모든 KR 주문경로(ls-kr-scan/ls-trade/PILOT)가 공유 ──
//   ⚠️ repo 에 LS 공식 catalog(MbrNo 허용값 목록)이 없다. 확인 가능한 것은 CSPAT00601 reqExample 값 'NXT'(=넥스트레이드 ATS)뿐.
//   따라서 KRX/빈문자열이 정규거래소를 의미하는지 '추측 금지'. env 미설정 시 문서 예제값 'NXT' 유지.
//   env 를 명시 설정하면(빈 문자열 포함) 그 값을 그대로 전송 → 사용자가 LS 공식값을 확인해 라우팅을 조정할 수 있게 한다.
export interface KRMbrNoResolution { value: string; source: 'ENV' | 'DEFAULT_REQEXAMPLE'; envValue: string | null }
export const KR_MBRNO_DEFAULT_REQEXAMPLE = 'NXT';   // LS 공식 reqExample 값(넥스트레이드 ATS). repo 내 유일 확정근거.
export function resolveKRMbrNo(rawEnv: string | undefined | null): KRMbrNoResolution {
  if (rawEnv === undefined || rawEnv === null) return { value: KR_MBRNO_DEFAULT_REQEXAMPLE, source: 'DEFAULT_REQEXAMPLE', envValue: null };
  return { value: rawEnv.trim().toUpperCase(), source: 'ENV', envValue: rawEnv };   // 빈 문자열도 그대로(사용자 명시 테스트 허용)
}

// CSPAT00601 매수 InBlock 빌더(공식 필드) — placeLSKRBuyOrder 와 진단로그가 '동일 소스' 사용(드리프트 방지, P0-35P7).
//   민감정보(계좌/비번/토큰) 없음. MbrNo 는 거래소 라우팅(NXT=넥스트레이드 ATS / KRX 등) — 호출측이 env 로 주입.
export function buildKRBuyInBlock(p: { shcode: string; qty: number; price: number; mbrNo?: string }): { CSPAT00601InBlock1: Record<string, unknown> } {
  return {
    CSPAT00601InBlock1: {
      IsuNo: krIsuNo(p.shcode), OrdQty: p.qty, OrdPrc: p.price, BnsTpCode: LS_KR_BNS_BUY,
      OrdprcPtnCode: '00', MgntrnCode: '000', LoanDt: '', OrdCndiTpCode: '0', MbrNo: p.mbrNo ?? 'NXT',
    },
  };
}
export async function placeLSKRBuyOrder(cfg: LSConfig, token: string, p: { shcode: string; qty: number; price: number; mbrNo?: string }): Promise<LSKROrderResult> {
  const inb = buildKRBuyInBlock(p);
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
export interface LSKROrderExec { ok: boolean; rspCd: string; rspMsg: string; buyOrdQty: number; buyExecQty: number; sellOrdQty: number; sellExecQty: number; diag?: LSHttpDiag; classification?: OrderExecClassification; }

// ── KR 주문체결 대사 '분류형' 조회 (P0-35P4) — US(COSAQ00102)와 대칭. soft 조회로 raw rsp_cd 를 잡아 SUCCESS/EMPTY/
//   BUSINESS_ERROR/TRANSPORT_ERROR 로 분류(추측 금지). '0건 정상'과 'API 실패'를 절대 혼동하지 않는다.
//   ⚠️ 기존 queryLSKROrderExec(kr-trader 사용)는 변경하지 않는다(별도 함수).
export interface LSKROrderExecClassified {
  queryOk: boolean; classification: OrderExecClassification;
  rspCd: string; rspMsg: string;
  buyOrdQty: number; buyExecQty: number; sellOrdQty: number; sellExecQty: number;
  hasEnvelope: boolean; httpStatus: number | null; kind?: LSErrorKind; diag?: LSHttpDiag;
}
// 순수 분류 — successCodes/emptyCodes 는 실측·문서 확정분만(추측 금지). 그 외 HTTP200 업무코드=BUSINESS_ERROR.
//   EMPTY 확정 조건(P0-35P5): httpStatus=200 + envelope 정상 + rawRows=0. 하나라도 어긋나면 fail-closed(BUSINESS_ERROR).
export function classifyKROrderExec(p: { rspCd: string; httpStatus: number | null; hasEnvelope: boolean; rowCount: number; successCodes: string[]; emptyCodes: string[] }): OrderExecClassification {
  if (p.httpStatus !== 200) return 'BUSINESS_ERROR';         // 200 아니면 통과 금지(엄격)
  if (p.emptyCodes.includes(p.rspCd)) {
    // 예: CSPAQ13700 00200 "조회내역 없음" — 반드시 envelope 정상 + rows=0 일 때만 EMPTY.
    return (p.hasEnvelope && p.rowCount === 0) ? 'EMPTY' : 'BUSINESS_ERROR';
  }
  if (p.successCodes.includes(p.rspCd)) {
    if (!p.hasEnvelope) return 'BUSINESS_ERROR';             // 성공코드인데 envelope 없음 → 이상 → fail-closed
    return p.rowCount > 0 ? 'SUCCESS' : 'EMPTY';
  }
  return 'BUSINESS_ERROR';   // 미확정 업무코드 → fail-closed
}
// PILOT 통일 대사 (P0-35P6) — classified(strict) 결과를 LSKROrderExec 형태로 반환.
//   ok = queryOk(SUCCESS/EMPTY strict: httpStatus200+envelope+rows0). classification 을 함께 실어 executor 진단에 사용.
//   ⚠️ preflight 와 '동일 strict classifier' 공유 → 이중판정(preflight=true/executor=false) 제거. safety 완화 아님.
export async function queryLSKROrderExecUnified(cfg: LSConfig, token: string, p: { shcode: string; ordDate: string; bnsTpCode?: string }): Promise<LSKROrderExec> {
  const r = await queryLSKROrderExecClassified(cfg, token, p);
  return { ok: r.queryOk, rspCd: r.rspCd, rspMsg: r.rspMsg, buyOrdQty: r.buyOrdQty, buyExecQty: r.buyExecQty, sellOrdQty: r.sellOrdQty, sellExecQty: r.sellExecQty, diag: r.diag, classification: r.classification };
}
export async function queryLSKROrderExecClassified(cfg: LSConfig, token: string, p: { shcode: string; ordDate: string; bnsTpCode?: string }): Promise<LSKROrderExecClassified> {
  const inb = { CSPAQ13700InBlock1: { OrdMktCode: '00', BnsTpCode: p.bnsTpCode ?? '0', IsuNo: krIsuNo(p.shcode), ExecYn: '0', OrdDt: p.ordDate, SrtOrdNo2: 0, BkseqTpCode: '0', OrdPtnCode: '00' } };
  const successCodes = LS_SUCCESS_CODES['CSPAQ13700'] ?? ['00000'];   // 미등록이면 00000 만(추측으로 코드 추가 금지)
  const emptyCodes = LS_EMPTY_CODES['CSPAQ13700'] ?? [];
  try {
    // soft: HTTP200 이면 업무코드여도 throw 없이 반환 → 아래에서 엄격 분류. transport 오류는 여전히 throw.
    const { data, rspCd, rspMsg, diag } = await lsPost(token, '/stock/accno', 'CSPAQ13700', inb, { soft: true });
    const o2 = data?.CSPAQ13700OutBlock2;
    const hasEnvelope = o2 != null;
    const buyOrdQty = toNum(o2?.BuyOrdQty), buyExecQty = toNum(o2?.BuyExecQty), sellOrdQty = toNum(o2?.SellOrdQty), sellExecQty = toNum(o2?.SellExecQty);
    const rowCount = buyOrdQty + buyExecQty + sellOrdQty + sellExecQty;   // 주문/체결 내역 유무(0=조회내역 없음)
    const classification = classifyKROrderExec({ rspCd, httpStatus: diag.status, hasEnvelope, rowCount, successCodes, emptyCodes });
    const queryOk = classification === 'SUCCESS' || classification === 'EMPTY';
    return {
      queryOk, classification, rspCd, rspMsg,
      buyOrdQty, buyExecQty, sellOrdQty, sellExecQty,
      hasEnvelope, httpStatus: diag.status, diag,
    };
  } catch (e) {
    // 여기 도달 = transport 실패(네트워크/timeout/빈응답/JSON오류/HTTP>=400/호출제한). 안전차단.
    const kind: LSErrorKind = e instanceof LSApiError ? e.kind : 'INVALID_RESPONSE';
    const diag = e instanceof LSApiError ? e.diag : undefined;
    return {
      queryOk: false, classification: 'TRANSPORT_ERROR', rspCd: e instanceof LSApiError ? (e.rspCd ?? `ERR(${e.kind})`) : 'EXCEPTION',
      rspMsg: e instanceof Error ? e.message : String(e),
      buyOrdQty: 0, buyExecQty: 0, sellOrdQty: 0, sellExecQty: 0, hasEnvelope: false, httpStatus: diag?.status ?? null, kind, diag,
    };
  }
}
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
