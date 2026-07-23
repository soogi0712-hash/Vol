import { describe, it, expect, vi, beforeEach } from 'vitest';

// diag 라우트가 쓰는 KIS 함수만 모킹(인증 실패 시 호출 0건 검증용)
const kis = vi.hoisted(() => ({ getAccessToken: vi.fn(), fetchKR1MinPage: vi.fn() }));
vi.mock('../src/lib/kis-api', () => ({
  getAccessToken: kis.getAccessToken,
  fetchKR1MinPage: kis.fetchKR1MinPage,
}));

import diag from '../src/routes/diag';

function makeEnv(secret?: string) {
  const dbCalls = { prepare: 0, batch: 0 };
  const stmt: any = {
    bind: () => stmt,
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({}),
  };
  const DB: any = {
    prepare: () => { dbCalls.prepare++; return stmt; },
    batch: async () => { dbCalls.batch++; return []; },
  };
  const env: any = {
    DB, KV: undefined, KIS_APP_KEY: 'k', KIS_APP_SECRET: 's', KIS_ACCOUNT_NO: 'n', KIS_ACCOUNT_SUFFIX: '01',
  };
  if (secret !== undefined) env.DIAG_SECRET = secret;
  return { env, dbCalls };
}
const req = (path: string, headers: Record<string, string>, env: any) =>
  diag.request(path, { headers }, env);

beforeEach(() => {
  kis.getAccessToken.mockReset(); kis.fetchKR1MinPage.mockReset();
  kis.getAccessToken.mockResolvedValue('tok');
  kis.fetchKR1MinPage.mockResolvedValue([]);   // 빈 페이지 → 즉시 종료
});

describe('diag 인증 가드', () => {
  it('DIAG_SECRET 미설정 → 403 + KIS/DB 접근 0', async () => {
    const { env, dbCalls } = makeEnv(undefined);
    const res = await req('/kr-candles/005930', { 'X-Diag-Secret': 'anything' }, env);
    expect(res.status).toBe(403);
    expect(kis.getAccessToken).not.toHaveBeenCalled();
    expect(kis.fetchKR1MinPage).not.toHaveBeenCalled();
    expect(dbCalls.prepare).toBe(0);
    expect(dbCalls.batch).toBe(0);
  });

  it('헤더 누락 → 403 + KIS/DB 접근 0', async () => {
    const { env, dbCalls } = makeEnv('S3CR3T');
    const res = await req('/kr-candles/005930', {}, env);
    expect(res.status).toBe(403);
    expect(kis.getAccessToken).not.toHaveBeenCalled();
    expect(dbCalls.prepare).toBe(0);
  });

  it('헤더 불일치 → 403 + KIS/DB 접근 0', async () => {
    const { env, dbCalls } = makeEnv('S3CR3T');
    const res = await req('/kr-candles/005930', { 'X-Diag-Secret': 'wrong' }, env);
    expect(res.status).toBe(403);
    expect(kis.getAccessToken).not.toHaveBeenCalled();
    expect(dbCalls.prepare).toBe(0);
    expect(dbCalls.batch).toBe(0);
  });

  it('정상 secret → 통과 (KIS 호출 발생)', async () => {
    const { env } = makeEnv('S3CR3T');
    const res = await req('/kr-candles/005930', { 'X-Diag-Secret': 'S3CR3T' }, env);
    expect(res.status).toBe(200);
    expect(kis.getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('ticker 6자리 숫자 아님 → 400 (인증 통과 후, KIS 호출 없음)', async () => {
    const { env } = makeEnv('S3CR3T');
    for (const t of ['ABC', '12345', '1234567', '00593A']) {
      kis.getAccessToken.mockClear();
      const res = await req(`/kr-candles/${t}`, { 'X-Diag-Secret': 'S3CR3T' }, env);
      expect(res.status).toBe(400);
      expect(kis.getAccessToken).not.toHaveBeenCalled();
    }
  });

  it('maxPages 경계값(0/16/문자열)도 인증 통과 시 수용(200)', async () => {
    const { env } = makeEnv('S3CR3T');
    for (const mp of ['0', '16', 'abc', '-5']) {
      const res = await req(`/kr-candles/005930?maxPages=${mp}`, { 'X-Diag-Secret': 'S3CR3T' }, env);
      expect(res.status).toBe(200);
    }
  });
});
