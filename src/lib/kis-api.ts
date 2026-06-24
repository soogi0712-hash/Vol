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
 *   - 15분봉:          HHDFS76950200 /uapi/overseas-stock/v1/quotations/inquire-time-itemchartprice
 *   - 현재가:          HHDFS00000300 /uapi/overseas-stock/v1/quotations/inquire-price
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
// TR_ID: HHDFS76950200
// EXCD: NASD(나스닥) / NYSE(뉴욕) / AMEX(아멕스)
// PINC=1 → 장전+정규+장후 포함
export async function getUS15MinCandles(
  cfg: KISConfig, token: string, ticker: string,
  count = 40, exchange: ExchangeCode = 'NASD'
): Promise<Candle[]> {
  const params = new URLSearchParams({
    AUTH: '',
    EXCD: exchange,
    SYMB: ticker,
    NMIN: '15',
    PINC: '1',       // 1=장전/장후 포함
    NEXT: '',
    NREC: String(Math.min(count, 200)),
    FILL: '',
    KEYB: '',
  });

  const res = await fetch(
    `${KIS_BASE}/uapi/overseas-stock/v1/quotations/inquire-time-itemchartprice?${params}`,
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
  if (data.rt_cd !== '0') throw new Error(`KIS US 15min [${ticker}/${exchange}]: ${data.msg1}`);

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
export async function getUSPrice(
  cfg: KISConfig, token: string, ticker: string,
  exchange: ExchangeCode = 'NASD'
): Promise<number> {
  const params = new URLSearchParams({ AUTH: '', EXCD: exchange, SYMB: ticker });
  const res = await fetch(
    `${KIS_BASE}/uapi/overseas-stock/v1/quotations/inquire-price?${params}`,
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
