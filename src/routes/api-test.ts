// API 연결 테스트 라우트
import { Hono } from 'hono';
import {
  getAccessToken,
  getOrderableBalance,
  getHoldings,
  getCurrentPrice,
} from '../lib/kis-api';

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
        value: accountNo,          // 계좌번호는 평문 노출 (민감도 낮음)
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
    const elapsed = Date.now() - start;
    return c.json({
      success: true,
      message: '액세스 토큰 발급 성공',
      elapsed_ms: elapsed,
      token_preview: token.slice(0, 12) + '...' + token.slice(-6),
      token_length: token.length,
    });
  } catch (e) {
    return c.json({
      success: false,
      message: String(e),
      elapsed_ms: Date.now() - start,
    }, 500);
  }
});

// ── 3. 주문가능금액 조회 ─────────────────────────────────────
test.get('/orderable', async (c) => {
  const config = buildConfig(c.env);
  const missing = checkMissing(config);
  if (missing) return c.json({ success: false, message: missing }, 400);

  const start = Date.now();
  try {
    const token = await getAccessToken(config, c.env.KV);
    const balance = await getOrderableBalance(config, token, 0);
    return c.json({
      success: true,
      message: '주문가능금액 조회 성공',
      elapsed_ms: Date.now() - start,
      data: {
        ord_psbl_cash: balance.cash,
        ord_psbl_cash_formatted: balance.cash.toLocaleString('ko-KR') + '원',
      },
    });
  } catch (e) {
    return c.json({
      success: false,
      message: String(e),
      elapsed_ms: Date.now() - start,
    }, 500);
  }
});

// ── 4. 계좌잔고 전체 조회 (output2 포함) ────────────────────
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
      rt_cd: string;
      msg_cd: string;
      msg1: string;
      output1: unknown[];
      output2: Array<{
        dnca_tot_amt: string;         // 예수금 총금액
        nxdy_excc_amt: string;        // 익일 정산금액
        prvs_rcdl_excc_amt: string;   // 가수도 정산금액
        cma_evlu_amt: string;         // CMA 평가금액
        bfdy_buy_amt: string;         // 전일 매수금액
        thdt_buyamt: string;          // 금일 매수금액
        nxdy_auto_rdpt_amt: string;   // 익일 자동상환금액
        bfdy_sll_amt: string;         // 전일 매도금액
        thdt_sll_amt: string;         // 금일 매도금액
        d2_auto_rdpt_amt: string;     // D+2 자동상환금액
        bfdy_tlex_amt: string;        // 전일 제비용금액
        thdt_tlex_amt: string;        // 금일 제비용금액
        tot_loan_amt: string;         // 총 대출금액
        scts_evlu_amt: string;        // 유가증권 평가금액
        tot_evlu_amt: string;         // 총 평가금액
        nass_amt: string;             // 순자산금액
        fncg_gld_auto_rdpt_yn: string;
        pchs_amt_smtl_amt: string;    // 매입금액 합계금액
        evlu_amt_smtl_amt: string;    // 평가금액 합계금액
        evlu_pfls_smtl_amt: string;   // 평가손익 합계금액
        tot_stln_slng_chgs: string;   // 총 대주매각대금
        bfdy_tot_asst_evlu_amt: string; // 전일 총자산 평가금액
        asst_icdc_amt: string;        // 자산 증감금액
        asst_icdc_erng_rt: string;    // 자산 증감 수익률
      }>;
    };

    if (raw.rt_cd !== '0') {
      return c.json({ success: false, message: raw.msg1, raw }, 500);
    }

    const s = raw.output2?.[0];
    const summary = s
      ? {
          예수금총금액:      { raw: s.dnca_tot_amt,       formatted: fmt(s.dnca_tot_amt) },
          유가증권평가금액:  { raw: s.scts_evlu_amt,      formatted: fmt(s.scts_evlu_amt) },
          총평가금액:        { raw: s.tot_evlu_amt,        formatted: fmt(s.tot_evlu_amt) },
          순자산금액:        { raw: s.nass_amt,            formatted: fmt(s.nass_amt) },
          매입금액합계:      { raw: s.pchs_amt_smtl_amt,   formatted: fmt(s.pchs_amt_smtl_amt) },
          평가손익합계:      { raw: s.evlu_pfls_smtl_amt,  formatted: fmt(s.evlu_pfls_smtl_amt) },
          금일매수금액:      { raw: s.thdt_buyamt,         formatted: fmt(s.thdt_buyamt) },
          금일매도금액:      { raw: s.thdt_sll_amt,        formatted: fmt(s.thdt_sll_amt) },
          자산증감수익률:    { raw: s.asst_icdc_erng_rt,   formatted: s.asst_icdc_erng_rt + '%' },
        }
      : null;

    return c.json({
      success: true,
      message: '계좌잔고 조회 성공',
      elapsed_ms: Date.now() - start,
      summary,
      holdings_count: (raw.output1 || []).length,
      rt_cd: raw.rt_cd,
      msg1: raw.msg1,
    });
  } catch (e) {
    return c.json({
      success: false,
      message: String(e),
      elapsed_ms: Date.now() - start,
    }, 500);
  }
});

// ── 5. 보유종목 조회 ────────────────────────────────────────
test.get('/holdings', async (c) => {
  const config = buildConfig(c.env);
  const missing = checkMissing(config);
  if (missing) return c.json({ success: false, message: missing }, 400);

  const start = Date.now();
  try {
    const token = await getAccessToken(config, c.env.KV);
    const holdings = await getHoldings(config, token);

    return c.json({
      success: true,
      message: `보유종목 조회 성공 (${holdings.length}개)`,
      elapsed_ms: Date.now() - start,
      count: holdings.length,
      data: holdings.map((h) => ({
        ...h,
        avg_price_formatted:        h.avg_price.toLocaleString('ko-KR') + '원',
        current_price_formatted:    h.current_price.toLocaleString('ko-KR') + '원',
        eval_profit_loss_formatted: h.eval_profit_loss.toLocaleString('ko-KR') + '원',
        eval_return_rate_formatted: h.eval_return_rate.toFixed(2) + '%',
      })),
    });
  } catch (e) {
    return c.json({
      success: false,
      message: String(e),
      elapsed_ms: Date.now() - start,
    }, 500);
  }
});

// ── 6. 현재가 조회 (단건) ────────────────────────────────────
test.get('/price/:ticker', async (c) => {
  const ticker = c.req.param('ticker');
  const config = buildConfig(c.env);
  const missing = checkMissing(config);
  if (missing) return c.json({ success: false, message: missing }, 400);

  const start = Date.now();
  try {
    const token = await getAccessToken(config, c.env.KV);
    const price  = await getCurrentPrice(config, token, ticker);

    return c.json({
      success: true,
      message: `${ticker} 현재가 조회 성공`,
      elapsed_ms: Date.now() - start,
      data: {
        ticker,
        price,
        price_formatted: price.toLocaleString('ko-KR') + '원',
      },
    });
  } catch (e) {
    return c.json({
      success: false,
      message: String(e),
      elapsed_ms: Date.now() - start,
    }, 500);
  }
});

// ── 7. 전체 연결 상태 한번에 확인 ────────────────────────────
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
    return c.json({
      success: false,
      message: '토큰 발급 실패 — 이후 테스트 중단',
      results,
    });
  }

  // (3) 주문가능금액
  {
    const t0 = Date.now();
    try {
      const bal = await getOrderableBalance(config, token, 0);
      results.orderable = {
        success: true,
        message: `주문가능금액: ${bal.cash.toLocaleString('ko-KR')}원`,
        elapsed_ms: Date.now() - t0,
        data: bal,
      };
    } catch (e) {
      results.orderable = { success: false, message: String(e), elapsed_ms: Date.now() - t0 };
    }
  }

  // (4) 보유종목
  {
    const t0 = Date.now();
    try {
      const holdings = await getHoldings(config, token);
      results.holdings = {
        success: true,
        message: `보유종목 ${holdings.length}개`,
        elapsed_ms: Date.now() - t0,
        data: holdings,
      };
    } catch (e) {
      results.holdings = { success: false, message: String(e), elapsed_ms: Date.now() - t0 };
    }
  }

  const allOk = Object.values(results).every((r) => r.success);
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
  const n = parseFloat(s || '0');
  return n.toLocaleString('ko-KR') + '원';
}

export default test;
