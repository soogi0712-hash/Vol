// Phase 1 진단 라우트 — KR 1분봉 수집 → 15분봉 집계 → candle_history(15m) 저장
// 관찰 전용: 이 경로는 주문 함수(buyKR/sellKR/buyUS/sellUS)를 절대 호출하지 않는다.
import { Hono } from 'hono';
import {
  getAccessToken, fetchKR1MinPage,
  getKRAccountSummary, getKROrderableCash,
  getUSHoldings, getUSOrderableCash,
} from '../lib/kis-api';
import { collectKR15Min } from '../lib/kr-candles';
import { makeKisRateLimiter } from '../lib/kis-rate-limit';
import { CANDLE_HISTORY_UPSERT_SQL, candleHistoryBindings } from '../lib/indicators';

type Bindings = {
  DB: D1Database; KV: KVNamespace;
  KIS_APP_KEY: string; KIS_APP_SECRET: string;
  KIS_ACCOUNT_NO: string; KIS_ACCOUNT_SUFFIX: string;
  DIAG_SECRET?: string;   // 진단 경로 보호용 시크릿 (wrangler secret put DIAG_SECRET)
};

const diag = new Hono<{ Bindings: Bindings }>();

// ── 인증 가드: 모든 /api/diag/* 요청에 적용 ──────────────────
// DIAG_SECRET 미설정 시(=보호 불가) 또는 헤더 불일치 시 403. 시크릿 값은 로그 미출력.
diag.use('*', async (c, next) => {
  const secret = c.env.DIAG_SECRET;
  const provided = c.req.header('X-Diag-Secret');
  if (!secret || !provided || provided !== secret) {
    return c.json({ success: false, message: 'forbidden' }, 403);
  }
  await next();
});

// GET /api/diag/account — 계좌/잔고 조회 점검 (실주문 전 사전 확인용)
// 민감정보 절대 미출력: APP KEY/SECRET, 토큰 원문, 전체 계좌번호는 응답·로그에 넣지 않는다.
diag.get('/account', async (c) => {
  if (!c.env.KIS_APP_KEY) return c.json({ success: false, message: 'API 키 미설정' }, 400);

  const cfg = {
    appKey: c.env.KIS_APP_KEY, appSecret: c.env.KIS_APP_SECRET,
    accountNo: c.env.KIS_ACCOUNT_NO, accountSuffix: c.env.KIS_ACCOUNT_SUFFIX || '01',
  };
  const acc    = c.env.KIS_ACCOUNT_NO || '';
  const suffix = c.env.KIS_ACCOUNT_SUFFIX || '01';
  // 끝 4자리만 노출 (예: ******1234-01)
  const masked = '*'.repeat(Math.max(0, acc.length - 4)) + acc.slice(-4) + '-' + suffix;

  // 응답/에러 문자열에서 민감값 제거 (혹시라도 KIS 에러 본문에 섞일 경우 대비)
  // 토큰은 발급 후 sensitive 에 추가된다 (appKey/appSecret/전체계좌번호/토큰 모두 마스킹).
  const sensitive: string[] = [cfg.appKey, cfg.appSecret, acc].filter(Boolean);
  const scrub = (s: string) => {
    let out = s;
    for (const secret of sensitive) out = out.split(secret).join('***');
    return out.slice(0, 200);
  };

  let token: string;
  try {
    token = await getAccessToken(cfg, c.env.KV);   // 토큰은 사용만, 절대 출력 금지
    if (token) sensitive.push(token);
  } catch (e) {
    return c.json({ account_masked: masked, account_suffix: suffix, token_ok: false, message: scrub(String(e)) }, 200);
  }

  // ── KR ──
  let kr_balance_ok = false, kr_total_eval: number | null = null, kr_orderable_cash: number | null = null;
  let kr_error: string | null = null;
  try { kr_total_eval = (await getKRAccountSummary(cfg, token)).totalEval; kr_balance_ok = true; }
  catch (e) { kr_error = scrub(String(e)); }
  try { kr_orderable_cash = await getKROrderableCash(cfg, token); }
  catch (e) { if (!kr_error) kr_error = scrub(String(e)); }

  // ── US (총평가금액 = 보유 포지션 시가평가 합, USD) ──
  let us_balance_ok = false, us_total_eval: number | null = null, us_orderable_cash: number | null = null;
  let us_error: string | null = null;
  try {
    const hs = await getUSHoldings(cfg, token);
    us_total_eval = hs.reduce((s, h) => s + h.qty * h.current_price, 0);
    us_balance_ok = true;
  } catch (e) { us_error = scrub(String(e)); }
  try { us_orderable_cash = await getUSOrderableCash(cfg, token); }
  catch (e) { if (!us_error) us_error = scrub(String(e)); }

  return c.json({
    account_masked: masked,
    account_suffix: suffix,
    token_ok: true,
    kr_balance_ok, kr_total_eval, kr_orderable_cash,
    us_balance_ok, us_total_eval, us_orderable_cash,
    ...(kr_error || us_error ? { errors: { kr: kr_error, us: us_error } } : {}),
  });
});

// GET /api/diag/kr-candles/:ticker  — 지정 1개 종목만
diag.get('/kr-candles/:ticker', async (c) => {
  const ticker = c.req.param('ticker');
  // 국내 종목코드 형식: 6자리 숫자만 허용
  if (!/^\d{6}$/.test(ticker)) {
    return c.json({ success: false, message: 'ticker 는 6자리 숫자여야 합니다' }, 400);
  }
  // 1회 호출 페이지 상한 (1~15)
  const maxPages = Math.max(1, Math.min(parseInt(c.req.query('maxPages') || '15', 10) || 15, 15));
  if (!c.env.KIS_APP_KEY) return c.json({ success: false, message: 'API 키 미설정' }, 400);

  try {
    const cfg = {
      appKey: c.env.KIS_APP_KEY, appSecret: c.env.KIS_APP_SECRET,
      accountNo: c.env.KIS_ACCOUNT_NO, accountSuffix: c.env.KIS_ACCOUNT_SUFFIX || '01',
    };
    const token = await getAccessToken(cfg, c.env.KV);
    // 보수적: 최소 간격 150ms (~6.6/s), 20/s 상한의 1/3 수준
    const limiter = makeKisRateLimiter({ minIntervalMs: 150, maxRetries: 3, baseBackoffMs: 300 });

    const report = await collectKR15Min({
      ticker,
      nowMs: Date.now(),
      maxPages,
      fetchPage: (endTime) => limiter.run(() => fetchKR1MinPage(cfg, token, ticker, endTime)),
      latestStoredTs: async () => {
        const r = await c.env.DB.prepare(
          `SELECT candle_ts FROM candle_history WHERE market='KR' AND symbol=? AND timeframe='15m' ORDER BY candle_ts DESC LIMIT 1`,
        ).bind(ticker).first<{ candle_ts: string }>();
        return r?.candle_ts ?? null;
      },
      upsert15m: async (bars) => {
        if (!bars.length) return { inserted: 0, updated: 0 };
        // 신규/업데이트/중복 구분: upsert 전 기존 candle_ts 집합 조회
        const before = new Set<string>();
        const rows = await c.env.DB.prepare(
          `SELECT candle_ts FROM candle_history WHERE market='KR' AND symbol=? AND timeframe='15m'`,
        ).bind(ticker).all<{ candle_ts: string }>();
        (rows.results || []).forEach(r => before.add(r.candle_ts));

        const stmt = c.env.DB.prepare(CANDLE_HISTORY_UPSERT_SQL);
        await c.env.DB.batch(bars.map(b => stmt.bind(...candleHistoryBindings('KR', ticker, '15m', b))));

        let inserted = 0, updated = 0;
        for (const b of bars) (before.has(b.datetime) ? updated++ : inserted++);
        return { inserted, updated };
      },
    });

    // 저장 후 D1 총 15분봉 개수
    const total = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM candle_history WHERE market='KR' AND symbol=? AND timeframe='15m'`,
    ).bind(ticker).first<{ n: number }>();

    return c.json({
      success: true,
      observe_only: true,       // 이 경로는 주문 함수를 호출하지 않음
      orders_submitted: 0,
      d1_total_15m: total?.n ?? 0,
      diag: report,
    });
  } catch (e) {
    return c.json({ success: false, message: String(e) }, 500);
  }
});

export default diag;
