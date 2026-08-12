import { describe, it, expect } from 'vitest';
import { KR_DAILY_TR, US_DAILY_TR, dailyTRConfig, isDailyTRReady } from '../local-runner/yeokmae/daily-tr-config';
import { makeKRDailyFetcher, makeUSDailyFetcher } from '../local-runner/yeokmae/daily-adapter';

describe('P0-32B daily-tr-config — probe 전 전부 미확정(fail-closed)', () => {
  it('KR/US 기본 설정은 미확정', () => {
    expect(KR_DAILY_TR.trCode).toBeNull();
    expect(KR_DAILY_TR.endpoint).toBeNull();
    expect(KR_DAILY_TR.pagination).toBe('UNCONFIRMED');
    expect(US_DAILY_TR.trCode).toBeNull();
    expect(US_DAILY_TR.buildInBlock).toBeNull();
  });
  it('isDailyTRReady — 미확정 사유를 단계적으로 반환', () => {
    expect(isDailyTRReady(KR_DAILY_TR)).toEqual({ ready: false, reason: 'DAILY_TR_UNCONFIRMED' });
    // trCode/endpoint 만 채우면 다음 사유(pagination)
    const step1 = { ...KR_DAILY_TR, trCode: 't8413', endpoint: '/stock/chart' as const };
    expect(isDailyTRReady(step1).reason).toBe('PAGINATION_STRATEGY_UNCONFIRMED');
    const step2 = { ...step1, pagination: 'HEADER_CONT' as const };
    expect(isDailyTRReady(step2).reason).toBe('SUCCESS_CODE_UNCONFIRMED');
    const step3 = { ...step2, successCodes: ['00000'] };
    expect(isDailyTRReady(step3).reason).toBe('INBLOCK_BUILDER_UNCONFIRMED');
    const step4 = { ...step3, buildInBlock: () => ({}) };
    expect(isDailyTRReady(step4)).toEqual({ ready: true, reason: 'OK' });
  });
  it('dailyTRConfig(market) 라우팅', () => {
    expect(dailyTRConfig('KR')).toBe(KR_DAILY_TR);
    expect(dailyTRConfig('US')).toBe(US_DAILY_TR);
  });
});

describe('P0-32B daily-adapter — 미확정이면 네트워크 호출 없이 즉시 fail-closed', () => {
  it('fetcher.ready() 는 미확정 사유 반환', () => {
    expect(makeKRDailyFetcher().ready().ready).toBe(false);
    expect(makeUSDailyFetcher().ready().ready).toBe(false);
  });
  it('fetch() 는 ready 실패 시 network 호출 없이 error 반환', async () => {
    const kr = makeKRDailyFetcher();
    // 잘못된 token/cfg 를 넘겨도, ready()=false 이므로 네트워크에 닿기 전에 반환되어야 한다.
    const res = await kr.fetch({} as any, 'no-token', { symbol: '005930', sdate: '20200101', edate: '20231231' });
    expect(res.ok).toBe(false);
    expect(res.pages).toBe(0);
    expect(res.error).toBe('DAILY_TR_UNCONFIRMED');
    expect(res.candles).toEqual([]);
  });
});
