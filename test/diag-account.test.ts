import { describe, it, expect, vi, beforeEach } from 'vitest';

// /api/diag/account 가 쓰는 kis-api 함수 모킹
const kis = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  getKRAccountSummary: vi.fn(),
  getKROrderableCash: vi.fn(),
  getUSHoldings: vi.fn(),
  getUSOrderableCash: vi.fn(),
  fetchKR1MinPage: vi.fn(),
}));
vi.mock('../src/lib/kis-api', () => kis);

import diag from '../src/routes/diag';

const TOKEN = 'SECRET_TOKEN_VALUE_xyz';
function makeEnv(secret?: string) {
  const env: any = {
    DB: { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }), batch: async () => [] },
    KV: undefined,
    KIS_APP_KEY: 'APPKEY_12345', KIS_APP_SECRET: 'APPSECRET_67890',
    KIS_ACCOUNT_NO: '12345678', KIS_ACCOUNT_SUFFIX: '01',
  };
  if (secret !== undefined) env.DIAG_SECRET = secret;
  return env;
}
const req = (headers: Record<string, string>, env: any) => diag.request('/account', { headers }, env);

beforeEach(() => {
  Object.values(kis).forEach((f: any) => f.mockReset());
  kis.getAccessToken.mockResolvedValue(TOKEN);
  kis.getKRAccountSummary.mockResolvedValue({ totalEval: 1234567, deposit: 1000000 });
  kis.getKROrderableCash.mockResolvedValue(1000000);
  kis.getUSHoldings.mockResolvedValue([{ ticker: 'AAPL', ticker_name: 'Apple', market: 'US', exchange: 'NASD', qty: 2, avg_price: 180, current_price: 190, eval_profit_loss: 20, eval_return_rate: 5 }]);
  kis.getUSOrderableCash.mockResolvedValue(4800);
});

describe('/api/diag/account 인증', () => {
  it('DIAG_SECRET 미설정 → 403, KIS 미호출', async () => {
    const res = await req({ 'X-Diag-Secret': 'x' }, makeEnv(undefined));
    expect(res.status).toBe(403);
    expect(kis.getAccessToken).not.toHaveBeenCalled();
  });
  it('시크릿 불일치 → 403', async () => {
    const res = await req({ 'X-Diag-Secret': 'wrong' }, makeEnv('S3CR3T'));
    expect(res.status).toBe(403);
  });
});

describe('/api/diag/account 응답', () => {
  it('정상: 계좌 마스킹 + KR/US 잔고 OK + 총평가금액', async () => {
    const res = await req({ 'X-Diag-Secret': 'S3CR3T' }, makeEnv('S3CR3T'));
    expect(res.status).toBe(200);
    const b = await res.json() as any;
    expect(b.account_masked).toBe('****5678-01');   // 끝 4자리만
    expect(b.account_suffix).toBe('01');
    expect(b.kr_balance_ok).toBe(true);
    expect(b.kr_total_eval).toBe(1234567);
    expect(b.kr_orderable_cash).toBe(1000000);
    expect(b.us_balance_ok).toBe(true);
    expect(b.us_total_eval).toBe(380);              // 2 * 190
    expect(b.us_orderable_cash).toBe(4800);
  });

  it('민감정보(APP KEY/SECRET/토큰/전체계좌번호)는 응답에 절대 없음', async () => {
    // KR 잔고조회가 민감값이 섞인 에러를 던져도 스크럽되는지까지 확인
    kis.getKROrderableCash.mockRejectedValue(new Error('fail acct 12345678 key APPKEY_12345 tok SECRET_TOKEN_VALUE_xyz'));
    kis.getKRAccountSummary.mockRejectedValue(new Error('APPSECRET_67890 leaked'));
    const res = await req({ 'X-Diag-Secret': 'S3CR3T' }, makeEnv('S3CR3T'));
    const text = await res.text();
    expect(text).not.toContain('APPKEY_12345');
    expect(text).not.toContain('APPSECRET_67890');
    expect(text).not.toContain('SECRET_TOKEN_VALUE_xyz');
    expect(text).not.toContain('12345678');         // 전체 계좌번호
    expect(text).toContain('5678');                 // 마스킹된 끝자리는 허용
  });

  it('KR 잔고조회 실패 → kr_balance_ok=false, 에러는 스크럽되어 표기', async () => {
    kis.getKRAccountSummary.mockRejectedValue(new Error('KIS KR Account: 모의투자 미지원'));
    kis.getKROrderableCash.mockRejectedValue(new Error('KIS KR OrderableCash: 모의투자 미지원'));
    const res = await req({ 'X-Diag-Secret': 'S3CR3T' }, makeEnv('S3CR3T'));
    const b = await res.json() as any;
    expect(b.kr_balance_ok).toBe(false);
    expect(b.us_balance_ok).toBe(true);
    expect(b.errors.kr).toContain('모의투자 미지원');
  });

  it('토큰 발급 실패 → token_ok=false (KIS 잔고 미호출)', async () => {
    kis.getAccessToken.mockRejectedValue(new Error('token fail'));
    const res = await req({ 'X-Diag-Secret': 'S3CR3T' }, makeEnv('S3CR3T'));
    const b = await res.json() as any;
    expect(b.token_ok).toBe(false);
    expect(kis.getKRAccountSummary).not.toHaveBeenCalled();
  });
});
