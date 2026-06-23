// 한국투자증권 Open API 연동 모듈

export interface KISConfig {
  appKey: string;
  appSecret: string;
  accountNo: string;     // 계좌번호 앞 8자리
  accountSuffix: string; // 계좌번호 뒤 2자리 (상품코드)
}

export interface AccessToken {
  access_token: string;
  expires_at: number; // timestamp ms
}

export interface StockPrice {
  ticker: string;
  close: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  date: string; // YYYYMMDD
}

export interface OrderResult {
  order_no: string;
  success: boolean;
  message: string;
  raw: unknown;
}

export interface Balance {
  cash: number; // 주문가능현금
}

export interface HoldingItem {
  ticker: string;
  ticker_name: string;
  qty: number;
  avg_price: number;
  current_price: number;
  eval_profit_loss: number;
  eval_return_rate: number;
}

const KIS_BASE_URL = 'https://openapi.koreainvestment.com:9443';

// Access Token 캐시 (KV or 메모리)
let _tokenCache: AccessToken | null = null;

export async function getAccessToken(config: KISConfig, kv?: KVNamespace): Promise<string> {
  const now = Date.now();

  // KV 캐시 확인
  if (kv) {
    const cached = await kv.get('kis_access_token');
    if (cached) {
      const token = JSON.parse(cached) as AccessToken;
      if (token.expires_at > now + 60_000) {
        return token.access_token;
      }
    }
  } else if (_tokenCache && _tokenCache.expires_at > now + 60_000) {
    return _tokenCache.access_token;
  }

  // 신규 토큰 발급
  const res = await fetch(`${KIS_BASE_URL}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: config.appKey,
      appsecret: config.appSecret,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KIS Token Error: ${res.status} ${text}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  const expiresAt = now + (data.expires_in - 60) * 1000;
  const tokenObj: AccessToken = { access_token: data.access_token, expires_at: expiresAt };

  if (kv) {
    await kv.put('kis_access_token', JSON.stringify(tokenObj), {
      expirationTtl: data.expires_in - 60,
    });
  } else {
    _tokenCache = tokenObj;
  }

  return data.access_token;
}

// 일봉 OHLCV 조회 (최근 N개)
export async function getDailyCandles(
  config: KISConfig,
  token: string,
  ticker: string,
  count: number = 30
): Promise<StockPrice[]> {
  const today = new Date();
  const endDate = formatDate(today);
  // 충분히 과거 날짜 (영업일 기준 count일 이상)
  const startDate = formatDate(new Date(today.getTime() - count * 2 * 24 * 60 * 60 * 1000));

  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: 'J',
    fid_input_iscd: ticker,
    fid_input_date_1: startDate,
    fid_input_date_2: endDate,
    fid_period_div_code: 'D',
    fid_org_adj_prc: '0', // 수정주가 미반영
  });

  const res = await fetch(`${KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?${params}`, {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      appkey: config.appKey,
      appsecret: config.appSecret,
      tr_id: 'FHKST03010100',
      custtype: 'P',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KIS Daily Candle Error: ${res.status} ${text}`);
  }

  const data = await res.json() as {
    rt_cd: string;
    msg1: string;
    output2: Array<{
      stck_bsop_date: string;
      stck_clpr: string;
      stck_oprc: string;
      stck_hgpr: string;
      stck_lwpr: string;
      acml_vol: string;
    }>;
  };

  if (data.rt_cd !== '0') {
    throw new Error(`KIS API Error: ${data.msg1}`);
  }

  const candles = (data.output2 || [])
    .map((d) => ({
      ticker,
      close: parseFloat(d.stck_clpr),
      open: parseFloat(d.stck_oprc),
      high: parseFloat(d.stck_hgpr),
      low: parseFloat(d.stck_lwpr),
      volume: parseFloat(d.acml_vol),
      date: d.stck_bsop_date,
    }))
    .filter((d) => d.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date)); // 오름차순

  return candles.slice(-count);
}

// 현재가 조회
export async function getCurrentPrice(
  config: KISConfig,
  token: string,
  ticker: string
): Promise<number> {
  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: 'J',
    fid_input_iscd: ticker,
  });

  const res = await fetch(`${KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price?${params}`, {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      appkey: config.appKey,
      appsecret: config.appSecret,
      tr_id: 'FHKST01010100',
      custtype: 'P',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KIS Price Error: ${res.status} ${text}`);
  }

  const data = await res.json() as {
    rt_cd: string;
    msg1: string;
    output: { stck_prpr: string; hts_kor_isnm: string };
  };

  if (data.rt_cd !== '0') {
    throw new Error(`KIS API Error: ${data.msg1}`);
  }

  return parseFloat(data.output.stck_prpr);
}

// 주문가능 현금 조회
export async function getOrderableBalance(
  config: KISConfig,
  token: string,
  price: number
): Promise<Balance> {
  const params = new URLSearchParams({
    CANO: config.accountNo,
    ACNT_PRDT_CD: config.accountSuffix,
    PDNO: '005930', // 임의 종목 (잔고 조회용)
    ORD_UNPR: String(Math.round(price)),
    ORD_DVSN: '02', // 시장가
    CMA_EVLU_AMT_ICLD_YN: 'Y',
    OVRS_ICLD_YN: 'N',
  });

  const res = await fetch(`${KIS_BASE_URL}/uapi/domestic-stock/v1/trading/inquire-psbl-order?${params}`, {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      appkey: config.appKey,
      appsecret: config.appSecret,
      tr_id: 'TTTC8908R',
      custtype: 'P',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KIS Balance Error: ${res.status} ${text}`);
  }

  const data = await res.json() as {
    rt_cd: string;
    msg1: string;
    output: { ord_psbl_cash: string };
  };

  if (data.rt_cd !== '0') {
    throw new Error(`KIS API Error: ${data.msg1}`);
  }

  return { cash: parseFloat(data.output.ord_psbl_cash) };
}

// 보유 종목 조회
export async function getHoldings(
  config: KISConfig,
  token: string
): Promise<HoldingItem[]> {
  const params = new URLSearchParams({
    CANO: config.accountNo,
    ACNT_PRDT_CD: config.accountSuffix,
    AFHR_FLPR_YN: 'N',
    OFL_YN: '',
    INQR_DVSN: '02',
    UNPR_DVSN: '01',
    FUND_STTL_ICLD_YN: 'N',
    FNCG_AMT_AUTO_RDPT_YN: 'N',
    PRCS_DVSN: '01',
    CTX_AREA_FK100: '',
    CTX_AREA_NK100: '',
  });

  const res = await fetch(`${KIS_BASE_URL}/uapi/domestic-stock/v1/trading/inquire-balance?${params}`, {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      appkey: config.appKey,
      appsecret: config.appSecret,
      tr_id: 'TTTC8434R',
      custtype: 'P',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KIS Holdings Error: ${res.status} ${text}`);
  }

  const data = await res.json() as {
    rt_cd: string;
    msg1: string;
    output1: Array<{
      pdno: string;
      prdt_name: string;
      hldg_qty: string;
      pchs_avg_pric: string;
      prpr: string;
      evlu_pfls_amt: string;
      evlu_pfls_rt: string;
    }>;
  };

  if (data.rt_cd !== '0') {
    throw new Error(`KIS API Error: ${data.msg1}`);
  }

  return (data.output1 || [])
    .filter((d) => parseInt(d.hldg_qty) > 0)
    .map((d) => ({
      ticker: d.pdno,
      ticker_name: d.prdt_name,
      qty: parseInt(d.hldg_qty),
      avg_price: parseFloat(d.pchs_avg_pric),
      current_price: parseFloat(d.prpr),
      eval_profit_loss: parseFloat(d.evlu_pfls_amt),
      eval_return_rate: parseFloat(d.evlu_pfls_rt),
    }));
}

// 매수 주문 (시장가)
export async function placeBuyOrder(
  config: KISConfig,
  token: string,
  ticker: string,
  qty: number
): Promise<OrderResult> {
  const body = {
    CANO: config.accountNo,
    ACNT_PRDT_CD: config.accountSuffix,
    PDNO: ticker,
    ORD_DVSN: '01', // 시장가
    ORD_QTY: String(qty),
    ORD_UNPR: '0',
  };

  const res = await fetch(`${KIS_BASE_URL}/uapi/domestic-stock/v1/trading/order-cash`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      appkey: config.appKey,
      appsecret: config.appSecret,
      tr_id: 'TTTC0802U', // 현금 매수
      custtype: 'P',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json() as {
    rt_cd: string;
    msg1: string;
    output: { KRX_FWDG_ORD_ORGNO: string; ODNO: string };
  };

  if (data.rt_cd !== '0') {
    return { order_no: '', success: false, message: data.msg1, raw: data };
  }

  return {
    order_no: data.output?.ODNO || '',
    success: true,
    message: data.msg1,
    raw: data,
  };
}

// 매도 주문 (시장가)
export async function placeSellOrder(
  config: KISConfig,
  token: string,
  ticker: string,
  qty: number
): Promise<OrderResult> {
  const body = {
    CANO: config.accountNo,
    ACNT_PRDT_CD: config.accountSuffix,
    PDNO: ticker,
    ORD_DVSN: '01', // 시장가
    ORD_QTY: String(qty),
    ORD_UNPR: '0',
  };

  const res = await fetch(`${KIS_BASE_URL}/uapi/domestic-stock/v1/trading/order-cash`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      appkey: config.appKey,
      appsecret: config.appSecret,
      tr_id: 'TTTC0801U', // 현금 매도
      custtype: 'P',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json() as {
    rt_cd: string;
    msg1: string;
    output: { KRX_FWDG_ORD_ORGNO: string; ODNO: string };
  };

  if (data.rt_cd !== '0') {
    return { order_no: '', success: false, message: data.msg1, raw: data };
  }

  return {
    order_no: data.output?.ODNO || '',
    success: true,
    message: data.msg1,
    raw: data,
  };
}

// 날짜 포맷 YYYYMMDD
function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
