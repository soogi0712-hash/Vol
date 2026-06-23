// API 연결 테스트 라우트 v2
import { Hono } from 'hono';
import {
  getAccessToken,
  getKROrderableCash,
  getUSOrderableCash,
  getKRHoldings,
  getUSHoldings,
  getKRPrice,
  getUSPrice,
  getKR15MinCandles,
  getUS15MinCandles,
} from '../lib/kis-api';
import { calcBB, getBBSignal } from '../lib/bollinger';

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  KIS_APP_KEY: string;
  KIS_APP_SECRET: string;
  KIS_ACCOUNT_NO: string;
  KIS_ACCOUNT_SUFFIX: string;
};

const test = new Hono<{ Bindings: Bindings }>();

// ── 1. 환경변수 상태 확인 ────────────────────────────────────
test.get('/env', (c) => {
  const appKey    = c.env.KIS_APP_KEY    ?? '';
  const appSecret = c.env.KIS_APP_SECRET ?? '';
  const accountNo = c.env.KIS_ACCOUNT_NO ?? '';
  const suffix    = c.env.KIS_ACCOUNT_SUFFIX ?? '';

  const mask = (s: string) =>
    s.length > 8 ? s.slice(0, 4) + '****' + s.slice(-4) : s ? '****' : '';

  return c.json({
    success: true,
    env: {
      KIS_APP_KEY: {
        set: appKey.length > 0,
        length: appKey.length,
        preview: mask(appKey),
        is_placeholder: appKey === 'your_app_key_here',
      },
      KIS_APP_SECRET: {
        set: appSecret.length > 0,
        length: appSecret.length,
        preview: mask(appSecret),
        is_placeholder: appSecret === 'your_app_secret_here',
      },
      KIS_ACCOUNT_NO: {
        set: accountNo.length > 0,
        value: accountNo,
        is_placeholder: accountNo.length === 0 || accountNo === '12345678',
      },
      KIS_ACCOUNT_SUFFIX: {
        set: suffix.length > 0,
        value: suffix,
        is_placeholder: suffix.length === 0,
      },
    },
    all_set:
      appKey.length > 0 && appKey !== 'your_app_key_here' &&
      appSecret.length > 0 && appSecret !== 'your_app_secret_here' &&
      accountNo.length > 0,
  });
});

// ── 2. 액세스 토큰 발급 테스트 ───────────────────────────────
test.get('/token', async (c) => {
  const config = buildConfig(c.env);
  const missing = checkMissing(config);
  if (missing) return c.json({ success: false, message: missing }, 400);

  const start = Date.now();
  try {
    const token = await getAccessToken(config, c.env.KV);
    return c.json({
      success: true,
      message: '액세스 토큰 발급 성공',
      elapsed_ms: Date.now() - start,
      token_preview: token.slice(0, 12) + '...' + token.slice(-6),
      token_length: token.length,
    });
  } catch (e) {
    return c.json({ success: false, message: String(e), elapsed_ms: Date.now() - start }, 500);
  }
});

// ── 3. KR 주문가능금액 조회 ──────────────────────────────────
test.get('/orderable', async (c) => {
  const config = buildConfig(c.env);
  const missing = checkMissing(config);
  if (missing) return c.json({ success: false, message: missing }, 400);

  const start = Date.now();
  try {
    const token = await getAccessToken(config, c.env.KV);
    const krCash = await getKROrderableCash(config, token);
    let usCash = 0;
    try { usCash = await getUSOrderableCash(config, token); } catch {}
    return c.json({
      success: true,
      message: 'KR+US 주문가능금액 조회 성공',
      elapsed_ms: Date.now() - start,
      data: {
        kr_cash: krCash,
        kr_cash_formatted: krCash.toLocaleString('ko-KR') + '원',
        us_cash: usCash,
        us_cash_formatted: '$' + usCash.toFixed(2),
      },
    });
  } catch (e) {
    return c.json({ success: false, message: String(e), elapsed_ms: Date.now() - start }, 500);
  }
});

// ── 4. 계좌잔고 전체 조회 ────────────────────────────────────
test.get('/balance', async (c) => {
  const config = buildConfig(c.env);
  const missing = checkMissing(config);
  if (missing) return c.json({ success: false, message: missing }, 400);

  const start = Date.now();
  try {
    const token = await getAccessToken(config, c.env.KV);

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

    const res = await fetch(
      `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/trading/inquire-balance?${params}`,
      {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          appkey: config.appKey,
          appsecret: config.appSecret,
          tr_id: 'TTTC8434R',
          custtype: 'P',
        },
      }
    );

    const raw = await res.json() as {
      rt_cd: string; msg_cd: string; msg1: string;
      output1: unknown[];
      output2: Array<{
        dnca_tot_amt: string; nxdy_excc_amt: string;
        scts_evlu_amt: string; tot_evlu_amt: string; nass_amt: string;
        pchs_amt_smtl_amt: string; evlu_pfls_smtl_amt: string;
        thdt_buyamt: string; thdt_sll_amt: string; asst_icdc_erng_rt: string;
      }>;
    };

    if (raw.rt_cd !== '0') return c.json({ success: false, message: raw.msg1, raw }, 500);

    const s = raw.output2?.[0];
    const summary = s ? {
      예수금총금액:     { raw: s.dnca_tot_amt,      formatted: fmt(s.dnca_tot_amt) },
      유가증권평가금액: { raw: s.scts_evlu_amt,     formatted: fmt(s.scts_evlu_amt) },
      총평가금액:       { raw: s.tot_evlu_amt,       formatted: fmt(s.tot_evlu_amt) },
      순자산금액:       { raw: s.nass_amt,           formatted: fmt(s.nass_amt) },
      매입금액합계:     { raw: s.pchs_amt_smtl_amt,  formatted: fmt(s.pchs_amt_smtl_amt) },
      평가손익합계:     { raw: s.evlu_pfls_smtl_amt, formatted: fmt(s.evlu_pfls_smtl_amt) },
      금일매수금액:     { raw: s.thdt_buyamt,        formatted: fmt(s.thdt_buyamt) },
      금일매도금액:     { raw: s.thdt_sll_amt,       formatted: fmt(s.thdt_sll_amt) },
      자산증감수익률:   { raw: s.asst_icdc_erng_rt,  formatted: s.asst_icdc_erng_rt + '%' },
    } : null;

    return c.json({
      success: true,
      message: '계좌잔고 조회 성공',
      elapsed_ms: Date.now() - start,
      summary,
      holdings_count: (raw.output1 || []).length,
    });
  } catch (e) {
    return c.json({ success: false, message: String(e), elapsed_ms: Date.now() - start }, 500);
  }
});

// ── 5. KR 보유종목 조회 (v2) ────────────────────────────────
test.get('/holdings', async (c) => {
  const config = buildConfig(c.env);
  const missing = checkMissing(config);
  if (missing) return c.json({ success: false, message: missing }, 400);

  const start = Date.now();
  try {
    const token = await getAccessToken(config, c.env.KV);
    const [krH, usH] = await Promise.all([
      getKRHoldings(config, token).catch(() => []),
      getUSHoldings(config, token).catch(() => []),
    ]);
    const all = [...krH, ...usH];
    return c.json({
      success: true,
      message: `KR ${krH.length}개 + US ${usH.length}개 보유종목 조회 성공`,
      elapsed_ms: Date.now() - start,
      count: all.length,
      kr_count: krH.length,
      us_count: usH.length,
      data: all.map(h => ({
        ...h,
        avg_price_formatted:        h.market === 'KR' ? h.avg_price.toLocaleString('ko-KR') + '원' : '$' + h.avg_price.toFixed(2),
        current_price_formatted:    h.market === 'KR' ? h.current_price.toLocaleString('ko-KR') + '원' : '$' + h.current_price.toFixed(2),
        eval_profit_loss_formatted: h.market === 'KR' ? h.eval_profit_loss.toLocaleString('ko-KR') + '원' : '$' + h.eval_profit_loss.toFixed(2),
        eval_return_rate_formatted: h.eval_return_rate.toFixed(2) + '%',
      })),
    });
  } catch (e) {
    return c.json({ success: false, message: String(e), elapsed_ms: Date.now() - start }, 500);
  }
});

// ── 6. 현재가 조회 (:market/:ticker) ────────────────────────
test.get('/price/:market/:ticker', async (c) => {
  const market = (c.req.param('market') || 'KR').toUpperCase() as 'KR' | 'US';
  const ticker = c.req.param('ticker').toUpperCase();
  const config = buildConfig(c.env);
  const missing = checkMissing(config);
  if (missing) return c.json({ success: false, message: missing }, 400);

  const start = Date.now();
  try {
    const token = await getAccessToken(config, c.env.KV);
    const price = market === 'KR'
      ? await getKRPrice(config, token, ticker)
      : await getUSPrice(config, token, ticker);

    return c.json({
      success: true,
      message: `[${market}] ${ticker} 현재가 조회 성공`,
      elapsed_ms: Date.now() - start,
      data: {
        ticker, market, price,
        price_formatted: market === 'KR' ? price.toLocaleString('ko-KR') + '원' : '$' + price.toFixed(2),
      },
    });
  } catch (e) {
    return c.json({ success: false, message: String(e), elapsed_ms: Date.now() - start }, 500);
  }
});

// ── 하위 호환: /price/:ticker (KR 기본) ─────────────────────
test.get('/price/:ticker', async (c) => {
  const ticker = c.req.param('ticker').toUpperCase();
  const config = buildConfig(c.env);
  const missing = checkMissing(config);
  if (missing) return c.json({ success: false, message: missing }, 400);

  const start = Date.now();
  try {
    const token = await getAccessToken(config, c.env.KV);
    const price = await getKRPrice(config, token, ticker);
    return c.json({
      success: true,
      message: `[KR] ${ticker} 현재가 조회 성공`,
      elapsed_ms: Date.now() - start,
      data: { ticker, market: 'KR', price, price_formatted: price.toLocaleString('ko-KR') + '원' },
    });
  } catch (e) {
    return c.json({ success: false, message: String(e), elapsed_ms: Date.now() - start }, 500);
  }
});

// ── 7. 15분봉 + BB 신호 테스트 ──────────────────────────────
test.get('/bb/:market/:ticker', async (c) => {
  const market = (c.req.param('market') || 'KR').toUpperCase() as 'KR' | 'US';
  const ticker = c.req.param('ticker').toUpperCase();
  const config = buildConfig(c.env);
  const missing = checkMissing(config);
  if (missing) return c.json({ success: false, message: missing }, 400);

  const start = Date.now();
  try {
    const token = await getAccessToken(config, c.env.KV);
    const candles = market === 'KR'
      ? await getKR15MinCandles(config, token, ticker, 40)
      : await getUS15MinCandles(config, token, ticker, 40);

    const closes = candles.map(c => c.close);
    const dts    = candles.map(c => c.datetime);
    const bands  = calcBB(closes, dts);
    const signal = getBBSignal(bands, false, false);
    const recent = bands.slice(-5);

    return c.json({
      success: true,
      message: `[${market}] ${ticker} 15분봉 BB 테스트 성공`,
      elapsed_ms: Date.now() - start,
      candle_count: candles.length,
      signal: signal.action,
      reason: signal.reason,
      current_band: signal.current,
      prev_band: signal.prev,
      recent_bands: recent,
    });
  } catch (e) {
    return c.json({ success: false, message: String(e), elapsed_ms: Date.now() - start }, 500);
  }
});

// ── 8. 전체 연결 상태 한번에 확인 ────────────────────────────
test.get('/all', async (c) => {
  const config = buildConfig(c.env);
  const results: Record<string, { success: boolean; message: string; elapsed_ms: number; data?: unknown }> = {};

  // (1) 환경변수
  results.env = {
    success: !!(
      config.appKey && config.appKey !== 'your_app_key_here' &&
      config.appSecret && config.appSecret !== 'your_app_secret_here' &&
      config.accountNo
    ),
    message: '',
    elapsed_ms: 0,
  };
  results.env.message = results.env.success ? '환경변수 정상' : '환경변수 미설정/플레이스홀더 감지';

  // (2) 토큰
  let token = '';
  {
    const t0 = Date.now();
    try {
      token = await getAccessToken(config, c.env.KV);
      results.token = { success: true, message: '토큰 발급 성공', elapsed_ms: Date.now() - t0 };
    } catch (e) {
      results.token = { success: false, message: String(e), elapsed_ms: Date.now() - t0 };
    }
  }

  if (!token) {
    return c.json({ success: false, message: '토큰 발급 실패 — 이후 테스트 중단', results });
  }

  // (3) KR 주문가능금액
  {
    const t0 = Date.now();
    try {
      const cash = await getKROrderableCash(config, token);
      results.kr_orderable = {
        success: true,
        message: `KR 주문가능금액: ${cash.toLocaleString('ko-KR')}원`,
        elapsed_ms: Date.now() - t0,
        data: { cash },
      };
    } catch (e) {
      results.kr_orderable = { success: false, message: String(e), elapsed_ms: Date.now() - t0 };
    }
  }

  // (4) US 주문가능금액
  {
    const t0 = Date.now();
    try {
      const cash = await getUSOrderableCash(config, token);
      results.us_orderable = {
        success: true,
        message: `US 주문가능금액: $${cash.toFixed(2)}`,
        elapsed_ms: Date.now() - t0,
        data: { cash },
      };
    } catch (e) {
      results.us_orderable = { success: false, message: String(e), elapsed_ms: Date.now() - t0 };
    }
  }

  // (5) KR 보유종목
  {
    const t0 = Date.now();
    try {
      const holdings = await getKRHoldings(config, token);
      results.kr_holdings = {
        success: true,
        message: `KR 보유종목 ${holdings.length}개`,
        elapsed_ms: Date.now() - t0,
        data: holdings,
      };
    } catch (e) {
      results.kr_holdings = { success: false, message: String(e), elapsed_ms: Date.now() - t0 };
    }
  }

  // (6) US 보유종목
  {
    const t0 = Date.now();
    try {
      const holdings = await getUSHoldings(config, token);
      results.us_holdings = {
        success: true,
        message: `US 보유종목 ${holdings.length}개`,
        elapsed_ms: Date.now() - t0,
        data: holdings,
      };
    } catch (e) {
      results.us_holdings = { success: false, message: String(e), elapsed_ms: Date.now() - t0 };
    }
  }

  const allOk = Object.values(results).every(r => r.success);
  return c.json({ success: allOk, message: allOk ? '전체 연결 정상' : '일부 항목 실패', results });
});

// ── 헬퍼 ─────────────────────────────────────────────────────
function buildConfig(env: Bindings) {
  return {
    appKey:        env.KIS_APP_KEY        ?? '',
    appSecret:     env.KIS_APP_SECRET     ?? '',
    accountNo:     env.KIS_ACCOUNT_NO     ?? '',
    accountSuffix: env.KIS_ACCOUNT_SUFFIX ?? '01',
  };
}

function checkMissing(cfg: ReturnType<typeof buildConfig>): string | null {
  if (!cfg.appKey || cfg.appKey === 'your_app_key_here')       return 'KIS_APP_KEY가 설정되지 않았습니다.';
  if (!cfg.appSecret || cfg.appSecret === 'your_app_secret_here') return 'KIS_APP_SECRET이 설정되지 않았습니다.';
  if (!cfg.accountNo)                                              return 'KIS_ACCOUNT_NO가 설정되지 않았습니다.';
  return null;
}

function fmt(s: string): string {
  return parseFloat(s || '0').toLocaleString('ko-KR') + '원';
}

export default test;
