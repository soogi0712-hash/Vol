import { describe, it, expect, vi, beforeEach } from 'vitest';

const ls = vi.hoisted(() => ({
  getLSAccessToken: vi.fn(),
  getLSKRBalance: vi.fn(),
  getLSUSBalance: vi.fn(),
}));
vi.mock('../src/lib/ls-api', () => ls);

import diag from '../src/routes/diag';

const TOKEN = 'LS_TOKEN_SECRET_xyz';
function makeEnv(secret?: string, over: Record<string, any> = {}) {
  const env: any = {
    DB: { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }), batch: async () => [] },
    KV: undefined,
    LS_APP_KEY: 'LSKEY_123', LS_APP_SECRET: 'LSSECRET_456',
    LS_ACCOUNT_NO: '5551234567', LS_ACCOUNT_SUFFIX: '01',
    ...over,
  };
  if (secret !== undefined) env.DIAG_SECRET = secret;
  return env;
}
const req = (headers: Record<string, string>, env: any) => diag.request('/ls-account', { headers }, env);

beforeEach(() => {
  Object.values(ls).forEach((f: any) => f.mockReset());
  ls.getLSAccessToken.mockResolvedValue(TOKEN);
  ls.getLSKRBalance.mockResolvedValue({ orderableCash: 1000000, totalEval: 1234567, balEval: 234567, deposit: 1000000, accountNo: '5551234567' });
  ls.getLSUSBalance.mockResolvedValue({ totalEvalKRW: 5000000, wonDeposit: 2000000, accountNo: '5551234567' });
});

describe('/api/diag/ls-account 인증', () => {
  it('DIAG_SECRET 미설정 → 403, LS 미호출', async () => {
    const res = await req({ 'X-Diag-Secret': 'x' }, makeEnv(undefined));
    expect(res.status).toBe(403);
    expect(ls.getLSAccessToken).not.toHaveBeenCalled();
  });
  it('시크릿 불일치 → 403', async () => {
    const res = await req({ 'X-Diag-Secret': 'nope' }, makeEnv('S3CR3T'));
    expect(res.status).toBe(403);
  });
  it('LS 키 미설정 → 400', async () => {
    const res = await req({ 'X-Diag-Secret': 'S3CR3T' }, makeEnv('S3CR3T', { LS_APP_KEY: '' }));
    expect(res.status).toBe(400);
  });
});

describe('/api/diag/ls-account 응답', () => {
  it('정상: 마스킹 + KR/US 잔고 OK + 총평가, observe_only', async () => {
    const res = await req({ 'X-Diag-Secret': 'S3CR3T' }, makeEnv('S3CR3T'));
    expect(res.status).toBe(200);
    const b = await res.json() as any;
    expect(b.broker).toBe('LS');
    expect(b.observe_only).toBe(true);
    expect(b.orders_submitted).toBe(0);
    expect(b.account_masked).toBe('******4567-01');   // 끝 4자리 + suffix
    expect(b.account_suffix).toBe('01');
    expect(b.kr_balance_ok).toBe(true);
    expect(b.kr_total_eval).toBe(1234567);
    expect(b.kr_orderable_cash).toBe(1000000);
    expect(b.us_balance_ok).toBe(true);
    expect(b.us_total_eval_krw).toBe(5000000);
  });

  it('APP KEY/SECRET·토큰·전체 계좌번호는 응답에 없음', async () => {
    ls.getLSKRBalance.mockRejectedValue(new Error('fail key LSKEY_123 secret LSSECRET_456 tok LS_TOKEN_SECRET_xyz acct 5551234567'));
    const res = await req({ 'X-Diag-Secret': 'S3CR3T' }, makeEnv('S3CR3T'));
    const text = await res.text();
    expect(text).not.toContain('LSKEY_123');
    expect(text).not.toContain('LSSECRET_456');
    expect(text).not.toContain('LS_TOKEN_SECRET_xyz');
    expect(text).not.toContain('5551234567');       // 전체 계좌번호
    expect(text).toContain('4567');                 // 마스킹 끝자리는 허용
  });

  it('KR 잔고 실패 → kr_balance_ok=false, US 는 정상, 에러 스크럽', async () => {
    ls.getLSKRBalance.mockRejectedValue(new Error('LS CSPAQ12200 rsp_cd=IZAA001 msg=권한없음'));
    const res = await req({ 'X-Diag-Secret': 'S3CR3T' }, makeEnv('S3CR3T'));
    const b = await res.json() as any;
    expect(b.kr_balance_ok).toBe(false);
    expect(b.us_balance_ok).toBe(true);
    expect(b.errors.kr).toContain('IZAA001');
  });

  it('토큰 발급 실패 → token_ok=false, 잔고 미호출', async () => {
    ls.getLSAccessToken.mockRejectedValue(new Error('token refusal'));
    const res = await req({ 'X-Diag-Secret': 'S3CR3T' }, makeEnv('S3CR3T'));
    const b = await res.json() as any;
    expect(b.token_ok).toBe(false);
    expect(ls.getLSKRBalance).not.toHaveBeenCalled();
  });
});
