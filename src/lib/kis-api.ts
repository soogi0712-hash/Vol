/**
 * 한국투자증권 Open API 연동 모듈 v2
 * - 한국주식 15분봉
 * - 미국주식 15분봉 (프리마켓+정규장+애프터마켓)
 * - 현금 매수/매도 (신용·미수 완전 금지)
 */

export interface KISConfig {
  appKey: string;
  appSecret: string;
  accountNo: string;
  accountSuffix: string;
}

export interface Candle {
  ticker: string;
  market: 'KR' | 'US';
  datetime: string;   // YYYYMMDDHHMMSS (KST or EST)
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
  cash_kr: number;    // 주문가능 현금 (원화)
  cash_us: number;    // 주문가능 현금 (달러)
}

export interface HoldingItem {
  ticker: string;
  ticker_name: string;
  market: 'KR' | 'US';
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

// ─── 한국주식 15분봉 ─────────────────────────────────────────
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

  const res = await fetch(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?${params}`, {
    headers: kis_headers(cfg, token, 'FHKST03010200'),
  });
  if (!res.ok) throw new Error(`KR 15min Error ${res.status}: ${await res.text()}`);

  const data = await res.json() as {
    rt_cd: string; msg1: string;
    output2: Array<{
      stck_bsop_date: string; stck_cntg_hour: string;
      stck_oprc: string; stck_hgpr: string; stck_lwpr: string; stck_prpr: string; cntg_vol: string;
    }>;
  };
  if (data.rt_cd !== '0') throw new Error(`KIS KR 15min: ${data.msg1}`);

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

// ─── 미국주식 15분봉 ─────────────────────────────────────────
export async function getUS15MinCandles(
  cfg: KISConfig, token: string, ticker: string, count = 40
): Promise<Candle[]> {
  // 당일 기준 (장전+정규+장후 전체)
  const now = new Date();
  const todayStr = formatDate(now);

  const params = new URLSearchParams({
    AUTH: '',
    EXCD: 'NAS',          // 나스닥 (NYS=뉴욕, AMS=아멕스 시도)
    SYMB: ticker,
    NMIN: '15',           // 15분봉
    PINC: '1',            // 장전/장후 포함
    NEXT: '',
    NREC: String(count),
    FILL: '',
    KEYB: '',
  });

  const res = await fetch(`${KIS_BASE}/uapi/overseas-stock/v1/quotations/inquire-time-itemchartprice?${params}`, {
    headers: kis_headers(cfg, token, 'HHDFS76950200'),
  });
  if (!res.ok) throw new Error(`US 15min Error ${res.status}: ${await res.text()}`);

  const data = await res.json() as {
    rt_cd: string; msg1: string;
    output2: Array<{
      xymd: string; xhms: string;
      open: string; high: string; low: string; last: string; evol: string;
    }>;
  };
  if (data.rt_cd !== '0') throw new Error(`KIS US 15min: ${data.msg1}`);

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

// ─── 한국주식 현재가 ──────────────────────────────────────────
export async function getKRPrice(cfg: KISConfig, token: string, ticker: string): Promise<number> {
  const params = new URLSearchParams({ fid_cond_mrkt_div_code: 'J', fid_input_iscd: ticker });
  const res = await fetch(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?${params}`, {
    headers: kis_headers(cfg, token, 'FHKST01010100'),
  });
  if (!res.ok) throw new Error(`KR Price Error: ${await res.text()}`);
  const d = await res.json() as { rt_cd: string; msg1: string; output: { stck_prpr: string } };
  if (d.rt_cd !== '0') throw new Error(`KIS KR Price: ${d.msg1}`);
  return parseFloat(d.output.stck_prpr);
}

// ─── 미국주식 현재가 ──────────────────────────────────────────
export async function getUSPrice(cfg: KISConfig, token: string, ticker: string): Promise<number> {
  const params = new URLSearchParams({ AUTH: '', EXCD: 'NAS', SYMB: ticker });
  const res = await fetch(`${KIS_BASE}/uapi/overseas-stock/v1/quotations/inquire-price?${params}`, {
    headers: kis_headers(cfg, token, 'HHDFS00000300'),
  });
  if (!res.ok) throw new Error(`US Price Error: ${await res.text()}`);
  const d = await res.json() as { rt_cd: string; msg1: string; output: { last: string } };
  if (d.rt_cd !== '0') throw new Error(`KIS US Price: ${d.msg1}`);
  return parseFloat(d.output.last);
}

// ─── 주문가능 현금 (KR) ──────────────────────────────────────
export async function getKROrderableCash(cfg: KISConfig, token: string): Promise<number> {
  const params = new URLSearchParams({
    CANO: cfg.accountNo, ACNT_PRDT_CD: cfg.accountSuffix,
    PDNO: '005930', ORD_UNPR: '50000', ORD_DVSN: '01',
    CMA_EVLU_AMT_ICLD_YN: 'Y', OVRS_ICLD_YN: 'N',
  });
  const res = await fetch(`${KIS_BASE}/uapi/domestic-stock/v1/trading/inquire-psbl-order?${params}`, {
    headers: kis_headers(cfg, token, 'TTTC8908R'),
  });
  if (!res.ok) throw new Error(`KR Cash Error: ${await res.text()}`);
  const d = await res.json() as { rt_cd: string; msg1: string; output: { ord_psbl_cash: string } };
  if (d.rt_cd !== '0') throw new Error(`KIS KR Cash: ${d.msg1}`);
  return parseFloat(d.output.ord_psbl_cash);
}

// ─── 주문가능 현금 (US) ──────────────────────────────────────
export async function getUSOrderableCash(cfg: KISConfig, token: string): Promise<number> {
  const params = new URLSearchParams({
    CANO: cfg.accountNo, ACNT_PRDT_CD: cfg.accountSuffix,
    OVRS_ICLD_YN: 'Y', TR_CRCY_CD: 'USD',
    CTX_AREA_FK200: '', CTX_AREA_NK200: '',
  });
  const res = await fetch(`${KIS_BASE}/uapi/overseas-stock/v1/trading/inquire-present-balance?${params}`, {
    headers: kis_headers(cfg, token, 'CTRP6504R'),
  });
  if (!res.ok) throw new Error(`US Cash Error: ${await res.text()}`);
  const d = await res.json() as {
    rt_cd: string; msg1: string;
    output2: Array<{ crcy_cd: string; frcr_dncl_amt_2: string }>;
  };
  if (d.rt_cd !== '0') throw new Error(`KIS US Cash: ${d.msg1}`);
  const usd = (d.output2 || []).find(r => r.crcy_cd === 'USD');
  return parseFloat(usd?.frcr_dncl_amt_2 || '0');
}

// ─── 보유 종목 (KR) ──────────────────────────────────────────
export async function getKRHoldings(cfg: KISConfig, token: string): Promise<HoldingItem[]> {
  const params = new URLSearchParams({
    CANO: cfg.accountNo, ACNT_PRDT_CD: cfg.accountSuffix,
    AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02',
    UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N',
    PRCS_DVSN: '01', CTX_AREA_FK100: '', CTX_AREA_NK100: '',
  });
  const res = await fetch(`${KIS_BASE}/uapi/domestic-stock/v1/trading/inquire-balance?${params}`, {
    headers: kis_headers(cfg, token, 'TTTC8434R'),
  });
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

// ─── 보유 종목 (US) ──────────────────────────────────────────
export async function getUSHoldings(cfg: KISConfig, token: string): Promise<HoldingItem[]> {
  const params = new URLSearchParams({
    CANO: cfg.accountNo, ACNT_PRDT_CD: cfg.accountSuffix,
    OVRS_EXCG_CD: '', TR_CRCY_CD: '',
    CTX_AREA_FK200: '', CTX_AREA_NK200: '',
  });
  const res = await fetch(`${KIS_BASE}/uapi/overseas-stock/v1/trading/inquire-balance?${params}`, {
    headers: kis_headers(cfg, token, 'TTTS3012R'),
  });
  if (!res.ok) throw new Error(`US Holdings Error: ${await res.text()}`);
  const d = await res.json() as {
    rt_cd: string; msg1: string;
    output1: Array<{
      ovrs_pdno: string; ovrs_item_name: string; ovrs_cblc_qty: string;
      pchs_avg_pric: string; now_pric2: string; frcr_evlu_pfls_amt: string; evlu_pfls_rt: string;
    }>;
  };
  if (d.rt_cd !== '0') throw new Error(`KIS US Holdings: ${d.msg1}`);
  return (d.output1 || []).filter(x => parseFloat(x.ovrs_cblc_qty) > 0).map(x => ({
    ticker: x.ovrs_pdno, ticker_name: x.ovrs_item_name, market: 'US' as const,
    qty: parseInt(x.ovrs_cblc_qty), avg_price: parseFloat(x.pchs_avg_pric),
    current_price: parseFloat(x.now_pric2), eval_profit_loss: parseFloat(x.frcr_evlu_pfls_amt),
    eval_return_rate: parseFloat(x.evlu_pfls_rt),
  }));
}

// ─── 한국주식 시장가 매수 ─────────────────────────────────────
export async function buyKR(cfg: KISConfig, token: string, ticker: string, qty: number): Promise<OrderResult> {
  const body = {
    CANO: cfg.accountNo, ACNT_PRDT_CD: cfg.accountSuffix,
    PDNO: ticker, ORD_DVSN: '01', ORD_QTY: String(qty), ORD_UNPR: '0',
  };
  return postOrder(cfg, token, body, 'TTTC0802U');
}

// ─── 한국주식 시장가 전량 매도 ────────────────────────────────
export async function sellKR(cfg: KISConfig, token: string, ticker: string, qty: number): Promise<OrderResult> {
  const body = {
    CANO: cfg.accountNo, ACNT_PRDT_CD: cfg.accountSuffix,
    PDNO: ticker, ORD_DVSN: '01', ORD_QTY: String(qty), ORD_UNPR: '0',
  };
  return postOrder(cfg, token, body, 'TTTC0801U');
}

// ─── 미국주식 시장가 매수 ─────────────────────────────────────
export async function buyUS(
  cfg: KISConfig, token: string, ticker: string, qty: number, exchange = 'NAS'
): Promise<OrderResult> {
  const body = {
    CANO: cfg.accountNo, ACNT_PRDT_CD: cfg.accountSuffix,
    OVRS_EXCG_CD: exchange, PDNO: ticker,
    ORD_DVSN: '00', FT_ORD_QTY: String(qty), FT_ORD_UNPR3: '0',
  };
  return postOrder(cfg, token, body, 'TTTT1002U', true);
}

// ─── 미국주식 시장가 전량 매도 ────────────────────────────────
export async function sellUS(
  cfg: KISConfig, token: string, ticker: string, qty: number, exchange = 'NAS'
): Promise<OrderResult> {
  const body = {
    CANO: cfg.accountNo, ACNT_PRDT_CD: cfg.accountSuffix,
    OVRS_EXCG_CD: exchange, PDNO: ticker,
    ORD_DVSN: '00', FT_ORD_QTY: String(qty), FT_ORD_UNPR3: '0',
  };
  return postOrder(cfg, token, body, 'TTTT1006U', true);
}

// ─── 내부 헬퍼 ────────────────────────────────────────────────
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

async function postOrder(
  cfg: KISConfig, token: string, body: Record<string, string>,
  trId: string, isUS = false
): Promise<OrderResult> {
  const url = isUS
    ? `${KIS_BASE}/uapi/overseas-stock/v1/trading/order`
    : `${KIS_BASE}/uapi/domestic-stock/v1/trading/order-cash`;
  const res = await fetch(url, {
    method: 'POST',
    headers: kis_headers(cfg, token, trId),
    body: JSON.stringify(body),
  });
  const d = await res.json() as { rt_cd: string; msg1: string; output?: { ODNO?: string } };
  if (d.rt_cd !== '0') return { order_no: '', success: false, message: d.msg1, raw: d };
  return { order_no: d.output?.ODNO || '', success: true, message: d.msg1, raw: d };
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}
