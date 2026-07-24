/**
 * 한국투자증권 Open API 연동 모듈 v3
 * ─────────────────────────────────────────────────────────────
 * 동일 계좌(KIS_ACCOUNT_NO / KIS_ACCOUNT_SUFFIX)로
 * 국내주식과 해외주식을 모두 처리한다.
 *
 * 국내주식 (domestic-stock)
 *   - 잔고조회:        TTTC8434R  /uapi/domestic-stock/v1/trading/inquire-balance
 *   - 주문가능금액:    TTTC8908R  /uapi/domestic-stock/v1/trading/inquire-psbl-order
 *   - 시장가 매수:     TTTC0802U  /uapi/domestic-stock/v1/trading/order-cash
 *   - 시장가 매도:     TTTC0801U  /uapi/domestic-stock/v1/trading/order-cash
 *   - 15분봉:          FHKST03010200 /uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice
 *   - 현재가:          FHKST01010100 /uapi/domestic-stock/v1/quotations/inquire-price
 *
 * 해외주식 (overseas-stock) — 동일 계좌, URL/TR_ID만 다름
 *   - 잔고조회:        TTTS3012R  /uapi/overseas-stock/v1/trading/inquire-balance
 *   - 주문가능금액:    TTTS3007R  /uapi/overseas-stock/v1/trading/inquire-psamount
 *   - 시장가 매수:     TTTT1002U  /uapi/overseas-stock/v1/trading/order
 *   - 시장가 매도:     TTTT1006U  /uapi/overseas-stock/v1/trading/order
 *   - 15분봉:          HHDFS76950200 /uapi/overseas-price/v1/quotations/inquire-time-itemchartprice  ← overseas-price!
 *   - 현재가:          HHDFS00000300 /uapi/overseas-price/v1/quotations/inquire-price              ← overseas-price!
 *
 * 미국주식 거래소 코드
 *   NASD = 나스닥, NYSE = 뉴욕, AMEX = 아멕스
 */

export interface KISConfig {
  appKey: string;
  appSecret: string;
  accountNo: string;
  accountSuffix: string;
}

export type ExchangeCode = 'NASD' | 'NYSE' | 'AMEX';

/**
 * 해외 시세(quotation) 엔드포인트의 EXCD 파라미터는 주문용 코드(NASD/NYSE/AMEX)가 아니라
 * 시세용 코드(NAS/NYS/AMS)를 요구한다. 주문 코드를 그대로 넣으면 rt_cd=0(정상)이지만
 * output2 가 빈 배열로 반환된다(데이터 매칭 실패). 아래에서 시세 코드로 변환한다.
 */
const QUOTATION_EXCD: Record<ExchangeCode, string> = { NASD: 'NAS', NYSE: 'NYS', AMEX: 'AMS' };
export function toQuotationExcd(exchange: ExchangeCode): string {
  return QUOTATION_EXCD[exchange] ?? 'NAS';
}

export interface Candle {
  ticker: string;
  market: 'KR' | 'US';
  datetime: string;   // YYYYMMDDHHMMSS
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderResult {
  order_no: string;
  success: boolean;
  message: string;
  raw: unknown;
}

export interface AccountBalance {
  cash_kr: number;    // 국내주식 주문가능금액 (원)
  cash_us: number;    // 해외주식 주문가능금액 (달러)
}

export interface HoldingItem {
  ticker: string;
  ticker_name: string;
  market: 'KR' | 'US';
  exchange?: ExchangeCode;
  qty: number;
  avg_price: number;
  current_price: number;
  eval_profit_loss: number;
  eval_return_rate: number;
}

const KIS_BASE = 'https://openapi.koreainvestment.com:9443';

// ─── 토큰 관리 ──────────────────────────────────────────────
interface TokenCache { access_token: string; expires_at: number }
let _memToken: TokenCache | null = null;

export async function getAccessToken(cfg: KISConfig, kv?: KVNamespace): Promise<string> {
  const now = Date.now();
  if (kv) {
    const cached = await kv.get('kis_token_v2');
    if (cached) {
      const t = JSON.parse(cached) as TokenCache;
      if (t.expires_at > now + 60_000) return t.access_token;
    }
  } else if (_memToken && _memToken.expires_at > now + 60_000) {
    return _memToken.access_token;
  }

  const res = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: cfg.appKey, appsecret: cfg.appSecret }),
  });
  if (!res.ok) throw new Error(`Token Error ${res.status}: ${await res.text()}`);

  const d = await res.json() as { access_token: string; expires_in: number };
  const obj: TokenCache = { access_token: d.access_token, expires_at: now + (d.expires_in - 60) * 1000 };
  if (kv) await kv.put('kis_token_v2', JSON.stringify(obj), { expirationTtl: d.expires_in - 60 });
  else _memToken = obj;
  return d.access_token;
}

// ══════════════════════════════════════════════════════════════
//  국내주식 (domestic-stock)
// ══════════════════════════════════════════════════════════════

// ─── 국내주식 15분봉 ─────────────────────────────────────────
export async function getKR15MinCandles(
  cfg: KISConfig, token: string, ticker: string, count = 40
): Promise<Candle[]> {
  const params = new URLSearchParams({
    fid_etc_cls_code: '',
    fid_cond_mrkt_div_code: 'J',
    fid_input_iscd: ticker,
    fid_input_hour_1: '153000',
    fid_pw_data_incu_yn: 'N',
  });

  const res = await fetch(
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?${params}`,
    { headers: kis_headers(cfg, token, 'FHKST03010200') }
  );
  if (!res.ok) throw new Error(`KR 15min Error ${res.status}: ${await res.text()}`);

  const data = await res.json() as {
    rt_cd: string; msg1: string;
    output2: Array<{
      stck_bsop_date: string; stck_cntg_hour: string;
      stck_oprc: string; stck_hgpr: string; stck_lwpr: string; stck_prpr: string; cntg_vol: string;
    }>;
  };
  if (data.rt_cd !== '0') throw new Error(`KIS KR 15min [${ticker}]: ${data.msg1}`);

  return (data.output2 || [])
    .map(d => ({
      ticker, market: 'KR' as const,
      datetime: d.stck_bsop_date + d.stck_cntg_hour.padStart(6, '0'),
      open: parseFloat(d.stck_oprc), high: parseFloat(d.stck_hgpr),
      low: parseFloat(d.stck_lwpr), close: parseFloat(d.stck_prpr),
      volume: parseFloat(d.cntg_vol),
    }))
    .filter(c => c.close > 0)
    .sort((a, b) => a.datetime.localeCompare(b.datetime))
    .slice(-count);
}

// ─── 국내주식 1분봉 한 페이지 (Phase 1: 역방향 페이징용) ──────
// FHKST03010200 는 endHHMMSS 기준 과거 최대 30개 1분봉을 반환한다.
// ★ 고정 '153000' 제거: 호출측이 유효(비-미래) 시각(HHMMSS)을 전달해야 한다.
//   미래 시각을 넣으면 전 봉이 현재가로 반환되는 KIS 동작을 피한다.
export async function fetchKR1MinPage(
  cfg: KISConfig, token: string, ticker: string, endHHMMSS: string,
): Promise<Candle[]> {
  const params = new URLSearchParams({
    fid_etc_cls_code: '',
    fid_cond_mrkt_div_code: 'J',
    fid_input_iscd: ticker,
    fid_input_hour_1: endHHMMSS,
    fid_pw_data_incu_yn: 'N',
  });
  const res = await fetch(
    `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?${params}`,
    { headers: kis_headers(cfg, token, 'FHKST03010200') },
  );
  if (!res.ok) throw new Error(`KR 1min Error ${res.status}: ${await res.text()}`);
  const data = await res.json() as {
    rt_cd: string; msg1: string;
    output2: Array<{
      stck_bsop_date: string; stck_cntg_hour: string;
      stck_oprc: string; stck_hgpr: string; stck_lwpr: string; stck_prpr: string; cntg_vol: string;
    }>;
  };
  if (data.rt_cd !== '0') throw new Error(`KIS KR 1min [${ticker}]: ${data.msg1}`);
  return (data.output2 || [])
    .map(d => ({
      ticker, market: 'KR' as const,
      datetime: d.stck_bsop_date + d.stck_cntg_hour.padStart(6, '0'),
      open: parseFloat(d.stck_oprc), high: parseFloat(d.stck_hgpr),
      low: parseFloat(d.stck_lwpr), close: parseFloat(d.stck_prpr),
      volume: parseFloat(d.cntg_vol),
    }))
    .filter(c => Number.isFinite(c.close));
}

// ─── 국내주식 현재가 ─────────────────────────────────────────
export async function getKRPrice(cfg: KISConfig, token: string, ticker: string): Promise<number> {
  const params = new URLSearchParams({ fid_cond_mrkt_div_code: 'J', fid_input_iscd: ticker });
  const res = await fetch(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?${params}`, {
    headers: kis_headers(cfg, token, 'FHKST01010100'),
  });
  if (!res.ok) throw new Error(`KR Price Error: ${await res.text()}`);
  const d = await res.json() as { rt_cd: string; msg1: string; output: { stck_prpr: string } };
  if (d.rt_cd !== '0') throw new Error(`KIS KR Price [${ticker}]: ${d.msg1}`);
  return parseFloat(d.output.stck_prpr);
}

// ─── 국내주식 주문가능금액 ────────────────────────────────────
// TR_ID: TTTC8908R  /uapi/domestic-stock/v1/trading/inquire-psbl-order
export async function getKROrderableCash(cfg: KISConfig, token: string): Promise<number> {
  const params = new URLSearchParams({
    CANO: cfg.accountNo,
    ACNT_PRDT_CD: cfg.accountSuffix,
    PDNO: '005930',        // 조회용 더미 종목코드
    ORD_UNPR: '0',
    ORD_DVSN: '01',        // 01=시장가
    CMA_EVLU_AMT_ICLD_YN: 'Y',
    OVRS_ICLD_YN: 'N',
  });
  const res = await fetch(
    `${KIS_BASE}/uapi/domestic-stock/v1/trading/inquire-psbl-order?${params}`,
    { headers: kis_headers(cfg, token, 'TTTC8908R') }
  );
  if (!res.ok) throw new Error(`KR OrderableCash Error: ${await res.text()}`);
  const d = await res.json() as { rt_cd: string; msg1: string; output: { ord_psbl_cash: string } };
  if (d.rt_cd !== '0') throw new Error(`KIS KR OrderableCash: ${d.msg1}`);
  return parseFloat(d.output.ord_psbl_cash);
}

// ─── 국내주식 잔고 조회 ───────────────────────────────────────
// TR_ID: TTTC8434R  /uapi/domestic-stock/v1/trading/inquire-balance
export async function getKRHoldings(cfg: KISConfig, token: string): Promise<HoldingItem[]> {
  const params = new URLSearchParams({
    CANO: cfg.accountNo, ACNT_PRDT_CD: cfg.accountSuffix,
    AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02',
    UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N',
    PRCS_DVSN: '01', CTX_AREA_FK100: '', CTX_AREA_NK100: '',
  });
  const res = await fetch(
    `${KIS_BASE}/uapi/domestic-stock/v1/trading/inquire-balance?${params}`,
    { headers: kis_headers(cfg, token, 'TTTC8434R') }
  );
  if (!res.ok) throw new Error(`KR Holdings Error: ${await res.text()}`);
  const d = await res.json() as {
    rt_cd: string; msg1: string;
    output1: Array<{
      pdno: string; prdt_name: string; hldg_qty: string; pchs_avg_pric: string;
      prpr: string; evlu_pfls_amt: string; evlu_pfls_rt: string;
    }>;
  };
  if (d.rt_cd !== '0') throw new Error(`KIS KR Holdings: ${d.msg1}`);
  return (d.output1 || []).filter(x => parseInt(x.hldg_qty) > 0).map(x => ({
    ticker: x.pdno, ticker_name: x.prdt_name, market: 'KR' as const,
    qty: parseInt(x.hldg_qty), avg_price: parseFloat(x.pchs_avg_pric),
    current_price: parseFloat(x.prpr), eval_profit_loss: parseFloat(x.evlu_pfls_amt),
    eval_return_rate: parseFloat(x.evlu_pfls_rt),
  }));
}

// ─── 국내주식 시장가 매수 ─────────────────────────────────────
// TR_ID: TTTC0802U  /uapi/domestic-stock/v1/trading/order-cash
export async function buyKR(
  cfg: KISConfig, token: string, ticker: string, qty: number
): Promise<OrderResult> {
  const body = {
    CANO: cfg.accountNo, ACNT_PRDT_CD: cfg.accountSuffix,
    PDNO: ticker,
    ORD_DVSN: '01',        // 01=시장가
    ORD_QTY: String(qty),
    ORD_UNPR: '0',
  };
  return postOrderKR(cfg, token, body, 'TTTC0802U');
}

// ─── 국내주식 시장가 전량 매도 ────────────────────────────────
// TR_ID: TTTC0801U  /uapi/domestic-stock/v1/trading/order-cash
export async function sellKR(
  cfg: KISConfig, token: string, ticker: string, qty: number
): Promise<OrderResult> {
  const body = {
    CANO: cfg.accountNo, ACNT_PRDT_CD: cfg.accountSuffix,
    PDNO: ticker,
    ORD_DVSN: '01',        // 01=시장가
    ORD_QTY: String(qty),
    ORD_UNPR: '0',
  };
  return postOrderKR(cfg, token, body, 'TTTC0801U');
}

// ══════════════════════════════════════════════════════════════
//  해외주식 (overseas-stock) — 동일 계좌번호 사용
// ══════════════════════════════════════════════════════════════

// ─── 해외주식 15분봉 ─────────────────────────────────────────
// TR_ID: HHDFS76950200  경로: /uapi/overseas-price/v1/quotations/inquire-time-itemchartprice
// EXCD(시세 코드): NAS(나스닥) / NYS(뉴욕) / AMS(아멕스)  ※ 주문 코드 NASD/NYSE/AMEX 아님
// NMIN=15(분갭) · PINC=1(전일 포함 → 40개 확보) · NEXT/FILL/KEYB="" · NREC≤120(요청 건수)
// ※ 시세조회는 overseas-stock이 아닌 overseas-price 경로 사용
export async function getUS15MinCandles(
  cfg: KISConfig, token: string, ticker: string,
  count = 40, exchange: ExchangeCode = 'NASD'
): Promise<Candle[]> {
  const excd = toQuotationExcd(exchange);   // NASD→NAS 등 시세 코드로 변환
  const params = new URLSearchParams({
    AUTH: '',
    EXCD: excd,
    SYMB: ticker,
    NMIN: '15',
    PINC: '1',       // 1=전일 포함(당일 봉이 부족해도 과거 봉으로 40개 확보)
    NEXT: '',
    NREC: String(Math.min(count, 120)),   // 요청 건수 최대 120
    FILL: '',
    KEYB: '',
  });

  const res = await fetch(
    `${KIS_BASE}/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice?${params}`,
    { headers: kis_headers(cfg, token, 'HHDFS76950200') }
  );
  if (!res.ok) throw new Error(`US 15min Error ${res.status}: ${await res.text()}`);

  const data = await res.json() as {
    rt_cd: string; msg1: string;
    output2: Array<{
      xymd: string; xhms: string;
      open: string; high: string; low: string; last: string; evol: string;
    }>;
  };
  // 배포 후 output2 개수 확인용(원본 전체 덤프 아님, 민감정보 없음)
  console.log("US15MIN", ticker, excd, "rt_cd", data.rt_cd, "output2", (data.output2 || []).length);
  if (data.rt_cd !== '0') throw new Error(`KIS US 15min [${ticker}/${excd}]: ${data.msg1}`);

  return (data.output2 || [])
    .map(d => ({
      ticker, market: 'US' as const,
      datetime: d.xymd + d.xhms.padStart(6, '0'),
      open: parseFloat(d.open), high: parseFloat(d.high),
      low: parseFloat(d.low), close: parseFloat(d.last),
      volume: parseFloat(d.evol),
    }))
    .filter(c => c.close > 0)
    .sort((a, b) => a.datetime.localeCompare(b.datetime))
    .slice(-count);
}

// ─── 해외주식 현재가 ─────────────────────────────────────────
// TR_ID: HHDFS00000300
// ※ 시세조회는 overseas-price 경로 사용
export async function getUSPrice(
  cfg: KISConfig, token: string, ticker: string,
  exchange: ExchangeCode = 'NASD'
): Promise<number> {
  const params = new URLSearchParams({ AUTH: '', EXCD: toQuotationExcd(exchange), SYMB: ticker });
  const res = await fetch(
    `${KIS_BASE}/uapi/overseas-price/v1/quotations/inquire-price?${params}`,
    { headers: kis_headers(cfg, token, 'HHDFS00000300') }
  );
  if (!res.ok) throw new Error(`US Price Error: ${await res.text()}`);
  const d = await res.json() as { rt_cd: string; msg1: string; output: { last: string } };
  if (d.rt_cd !== '0') throw new Error(`KIS US Price [${ticker}]: ${d.msg1}`);
  return parseFloat(d.output.last);
}

// ─── 해외주식 주문가능금액 (달러) ─────────────────────────────
// TR_ID: TTTS3007R  /uapi/overseas-stock/v1/trading/inquire-psamount
// 동일 계좌번호 사용, 통화 USD 지정
export async function getUSOrderableCash(cfg: KISConfig, token: string): Promise<number> {
  const params = new URLSearchParams({
    CANO: cfg.accountNo,
    ACNT_PRDT_CD: cfg.accountSuffix,
    OVRS_EXCG_CD: 'NASD',   // 거래소 (조회용, 잔고는 공통)
    OVRS_ORD_UNPR: '0',     // 주문단가 0=시장가용
    ITEM_CD: 'AAPL',        // 조회용 더미 종목
    TR_CRCY_CD: 'USD',
  });
  const res = await fetch(
    `${KIS_BASE}/uapi/overseas-stock/v1/trading/inquire-psamount?${params}`,
    { headers: kis_headers(cfg, token, 'TTTS3007R') }
  );
  if (!res.ok) throw new Error(`US OrderableCash HTTP Error: ${await res.text()}`);
  const d = await res.json() as {
    rt_cd: string; msg1: string;
    output: { frcr_ord_psbl_amt1: string };
  };
  if (d.rt_cd !== '0') throw new Error(`KIS US OrderableCash: ${d.msg1}`);
  return parseFloat(d.output?.frcr_ord_psbl_amt1 || '0');
}

// ─── 해외주식 잔고 조회 ───────────────────────────────────────
// TR_ID: TTTS3012R  /uapi/overseas-stock/v1/trading/inquire-balance
// 동일 계좌번호 사용
export async function getUSHoldings(cfg: KISConfig, token: string): Promise<HoldingItem[]> {
  const params = new URLSearchParams({
    CANO: cfg.accountNo,
    ACNT_PRDT_CD: cfg.accountSuffix,
    OVRS_EXCG_CD: '',      // 전체 거래소
    TR_CRCY_CD: '',
    CTX_AREA_FK200: '',
    CTX_AREA_NK200: '',
  });
  const res = await fetch(
    `${KIS_BASE}/uapi/overseas-stock/v1/trading/inquire-balance?${params}`,
    { headers: kis_headers(cfg, token, 'TTTS3012R') }
  );
  if (!res.ok) throw new Error(`US Holdings Error: ${await res.text()}`);
  const d = await res.json() as {
    rt_cd: string; msg1: string;
    output1: Array<{
      ovrs_pdno: string; ovrs_item_name: string;
      ovrs_excg_cd: string;          // 거래소 코드
      ovrs_cblc_qty: string;
      pchs_avg_pric: string; now_pric2: string;
      frcr_evlu_pfls_amt: string; evlu_pfls_rt: string;
    }>;
  };
  if (d.rt_cd !== '0') throw new Error(`KIS US Holdings: ${d.msg1}`);
  return (d.output1 || []).filter(x => parseFloat(x.ovrs_cblc_qty) > 0).map(x => ({
    ticker: x.ovrs_pdno, ticker_name: x.ovrs_item_name, market: 'US' as const,
    exchange: (x.ovrs_excg_cd as ExchangeCode) || 'NASD',
    qty: parseInt(x.ovrs_cblc_qty), avg_price: parseFloat(x.pchs_avg_pric),
    current_price: parseFloat(x.now_pric2), eval_profit_loss: parseFloat(x.frcr_evlu_pfls_amt),
    eval_return_rate: parseFloat(x.evlu_pfls_rt),
  }));
}

// ─── 해외주식 시장가 매수 ─────────────────────────────────────
// TR_ID: TTTT1002U  /uapi/overseas-stock/v1/trading/order
// ORD_DVSN: 00=지정가, 시장가는 거래소별로 다름
// NASD/NYSE/AMEX 일반 시장가: ORD_DVSN='00', FT_ORD_UNPR3='0'
export async function buyUS(
  cfg: KISConfig, token: string, ticker: string, qty: number,
  exchange: ExchangeCode = 'NASD'
): Promise<OrderResult> {
  const body = {
    CANO: cfg.accountNo,
    ACNT_PRDT_CD: cfg.accountSuffix,
    OVRS_EXCG_CD: exchange,   // NASD / NYSE / AMEX
    PDNO: ticker,
    ORD_DVSN: '00',           // 00=지정가(미국주식은 지정가=시장가에 가장 가까운 방식)
    FT_ORD_QTY: String(qty),
    FT_ORD_UNPR3: '0',        // 시장가 지정 시 0
  };
  return postOrderUS(cfg, token, body, 'TTTT1002U');
}

// ─── 해외주식 시장가 전량 매도 ────────────────────────────────
// TR_ID: TTTT1006U  /uapi/overseas-stock/v1/trading/order
export async function sellUS(
  cfg: KISConfig, token: string, ticker: string, qty: number,
  exchange: ExchangeCode = 'NASD'
): Promise<OrderResult> {
  const body = {
    CANO: cfg.accountNo,
    ACNT_PRDT_CD: cfg.accountSuffix,
    OVRS_EXCG_CD: exchange,
    PDNO: ticker,
    ORD_DVSN: '00',
    FT_ORD_QTY: String(qty),
    FT_ORD_UNPR3: '0',
  };
  return postOrderUS(cfg, token, body, 'TTTT1006U');
}

// ══════════════════════════════════════════════════════════════
//  KIS 종목 마스터 파일 다운로드 & 파싱
//  URL: https://new.real.download.dws.co.kr/common/master/
//  KR:  kospi_code.mst.zip, kosdaq_code.mst.zip
//  US:  nasmst.cod.zip, nysmst.cod.zip, amsmst.cod.zip
// ══════════════════════════════════════════════════════════════

export interface MasterStock {
  ticker: string;
  ticker_name: string;
  market: 'KR' | 'US';
  exchange: 'KOSPI' | 'KOSDAQ' | 'NASD' | 'NYSE' | 'AMEX';
}

const MASTER_BASE = 'https://new.real.download.dws.co.kr/common/master';

/**
 * KIS KOSPI/KOSDAQ 종목 마스터 파일 다운로드 & 파싱
 * 파일 포맷: 고정 바이너리 혼합 텍스트 (CP949)
 *   - 단축코드 9바이트 (0~8)
 *   - 표준코드 12바이트 (9~20)
 *   - 한글명 가변 (21 ~ len-228)
 *   - 나머지 228바이트: 재무 등 부가정보
 * 
 * Cloudflare Workers에서는 unzip을 직접 못하므로
 * pako(inflate) 또는 DecompressionStream 사용
 */
export async function fetchKRMasterStocks(
  exchange: 'KOSPI' | 'KOSDAQ'
): Promise<MasterStock[]> {
  const fname = exchange === 'KOSPI' ? 'kospi_code.mst.zip' : 'kosdaq_code.mst.zip';
  const url = `${MASTER_BASE}/${fname}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`KR Master fetch failed: ${res.status} ${url}`);

  const zipBuf = await res.arrayBuffer();
  // ZIP 파싱: Central Directory를 찾아 첫 번째 Local File을 deflate 해제
  const mstBuf = await extractFirstFileFromZip(zipBuf);
  return parseKRMaster(mstBuf, exchange);
}

/**
 * KIS 미국 종목 마스터 파일 다운로드 & 파싱
 * 파일 포맷: 탭 구분 텍스트 (CP949)
 *   컬럼: National code, Exchange id, Exchange code, Exchange name,
 *          Symbol(4), realtime symbol(5), Korea name(6), English name(7),
 *          Security type(8): 1=Index, 2=Stock, 3=ETP(ETF), 4=Warrant
 */
export async function fetchUSMasterStocks(
  exchange: 'NASD' | 'NYSE' | 'AMEX',
  includeETF = true
): Promise<MasterStock[]> {
  const codeMap = { NASD: 'nas', NYSE: 'nys', AMEX: 'ams' };
  const val = codeMap[exchange];
  const url = `${MASTER_BASE}/${val}mst.cod.zip`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`US Master fetch failed: ${res.status} ${url}`);

  const zipBuf = await res.arrayBuffer();
  const codBuf = await extractFirstFileFromZip(zipBuf);
  return parseUSMaster(codBuf, exchange, includeETF);
}

// ── ZIP 파싱: 첫 번째 로컬 파일을 deflate 해제 ───────────────
async function extractFirstFileFromZip(zipBuf: ArrayBuffer): Promise<ArrayBuffer> {
  const view = new DataView(zipBuf);
  const bytes = new Uint8Array(zipBuf);

  // Local File Header signature: PK\x03\x04 (0x04034b50)
  if (view.getUint32(0, true) !== 0x04034b50) {
    throw new Error('Invalid ZIP: no local file header');
  }

  const compression   = view.getUint16(8, true);   // 0=stored, 8=deflate
  const compressedSz  = view.getUint32(18, true);
  const fileNameLen   = view.getUint16(26, true);
  const extraLen      = view.getUint16(28, true);
  const dataOffset    = 30 + fileNameLen + extraLen;

  const compressedData = bytes.slice(dataOffset, dataOffset + compressedSz);

  if (compression === 0) {
    // Stored (no compression)
    return compressedData.buffer;
  } else if (compression === 8) {
    // Deflate — use DecompressionStream (Web API, supported in CF Workers)
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(compressedData);
    writer.close();

    const chunks: Uint8Array[] = [];
    let totalLen = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLen += value.length;
    }
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result.buffer;
  } else {
    throw new Error(`Unsupported ZIP compression: ${compression}`);
  }
}

// ── KR 마스터 파싱 (고정 바이너리 혼합 텍스트, CP949) ─────────
function parseKRMaster(buf: ArrayBuffer, exchange: 'KOSPI' | 'KOSDAQ'): MasterStock[] {
  const decoder = new TextDecoder('euc-kr');
  const bytes   = new Uint8Array(buf);
  const results: MasterStock[] = [];

  let pos = 0;
  while (pos < bytes.length) {
    // 줄 끝(\r\n 또는 \n) 찾기
    let lineEnd = pos;
    while (lineEnd < bytes.length && bytes[lineEnd] !== 0x0A) lineEnd++;
    if (lineEnd >= bytes.length) break;

    const lineLen = lineEnd - pos + 1;
    if (lineLen < 30) { pos = lineEnd + 1; continue; }

    const line = bytes.slice(pos, lineEnd);
    pos = lineEnd + 1;

    try {
      // 단축코드: 첫 9바이트
      const code = decoder.decode(line.slice(0, 9)).trim();
      // 6자리 숫자 = 일반 주식 (우선주 포함)
      if (!/^\d{6}$/.test(code)) continue;

      // 한글명: 21 ~ (len-228) 바이트 구간
      const trailingLen = Math.min(228, line.length - 21);
      const nameEnd = line.length - trailingLen;
      const name = decoder.decode(line.slice(21, nameEnd)).trim();
      if (!name) continue;

      results.push({ ticker: code, ticker_name: name, market: 'KR', exchange });
    } catch (_) { /* skip */ }
  }
  return results;
}

// ── US 마스터 파싱 (탭 구분, CP949) ──────────────────────────
function parseUSMaster(buf: ArrayBuffer, exchange: 'NASD' | 'NYSE' | 'AMEX', includeETF: boolean): MasterStock[] {
  const decoder = new TextDecoder('euc-kr');
  const text    = decoder.decode(new Uint8Array(buf));
  const results: MasterStock[] = [];

  for (const line of text.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 9) continue;

    const symbol   = parts[4]?.trim();
    const krName   = parts[6]?.trim();
    const enName   = parts[7]?.trim();
    const secType  = parts[8]?.trim();

    if (!symbol || symbol.length === 0) continue;
    // type: 2=Stock, 3=ETF/ETP
    const isStock = secType === '2';
    const isETF   = secType === '3';
    if (!isStock && !(includeETF && isETF)) continue;

    // 티커에 특수문자 포함된 경우 스킵 (KIS 주문 불가)
    if (/[^A-Z0-9.]/.test(symbol)) continue;

    results.push({
      ticker: symbol,
      ticker_name: krName || enName || symbol,
      market: 'US',
      exchange,
    });
  }
  return results;
}

// ══════════════════════════════════════════════════════════════
//  내부 헬퍼
// ══════════════════════════════════════════════════════════════

function kis_headers(cfg: KISConfig, token: string, trId: string) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    appkey: cfg.appKey,
    appsecret: cfg.appSecret,
    tr_id: trId,
    custtype: 'P',
  };
}

// 국내주식 주문 (order-cash)
async function postOrderKR(
  cfg: KISConfig, token: string,
  body: Record<string, string>, trId: string
): Promise<OrderResult> {
  const res = await fetch(`${KIS_BASE}/uapi/domestic-stock/v1/trading/order-cash`, {
    method: 'POST',
    headers: kis_headers(cfg, token, trId),
    body: JSON.stringify(body),
  });
  const d = await res.json() as { rt_cd: string; msg1: string; output?: { ODNO?: string } };
  if (d.rt_cd !== '0') return { order_no: '', success: false, message: d.msg1, raw: d };
  return { order_no: d.output?.ODNO || '', success: true, message: d.msg1, raw: d };
}

// 해외주식 주문 (overseas order)
async function postOrderUS(
  cfg: KISConfig, token: string,
  body: Record<string, string>, trId: string
): Promise<OrderResult> {
  const res = await fetch(`${KIS_BASE}/uapi/overseas-stock/v1/trading/order`, {
    method: 'POST',
    headers: kis_headers(cfg, token, trId),
    body: JSON.stringify(body),
  });
  const d = await res.json() as { rt_cd: string; msg1: string; output?: { ODNO?: string } };
  if (d.rt_cd !== '0') return { order_no: '', success: false, message: d.msg1, raw: d };
  return { order_no: d.output?.ODNO || '', success: true, message: d.msg1, raw: d };
}
