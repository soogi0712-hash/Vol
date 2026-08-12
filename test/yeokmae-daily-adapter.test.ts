import { describe, it, expect } from 'vitest';
import { KR_DAILY_TR, US_DAILY_TR, dailyTRConfig, isDailyTRReady } from '../local-runner/yeokmae/daily-tr-config';
import { makeKRDailyFetcher, makeUSDailyFetcher } from '../local-runner/yeokmae/daily-adapter';

describe('P0-32C daily-tr-config — KR 확정 / US 봉인', () => {
  it('KR 는 probe 실측으로 확정(t8413, jdiff_vol, DATE_WINDOW)', () => {
    expect(KR_DAILY_TR.trCode).toBe('t8413');
    expect(KR_DAILY_TR.endpoint).toBe('/stock/chart');
    expect(KR_DAILY_TR.pagination).toBe('DATE_WINDOW');
    expect(KR_DAILY_TR.fieldMap.volume).toBe('jdiff_vol');
    expect(KR_DAILY_TR.fieldMap.turnover).toBe('value');
    expect(KR_DAILY_TR.successCodes).toEqual(['00000']);
    expect(typeof KR_DAILY_TR.buildInBlock).toBe('function');
    expect(isDailyTRReady(KR_DAILY_TR)).toEqual({ ready: true, reason: 'OK' });
  });
  it('KR buildInBlock — t8413InBlock 실측 필드 구성', () => {
    const ib = KR_DAILY_TR.buildInBlock!({ symbol: '005930', sdate: '20220101', edate: '20260812' }) as any;
    expect(ib.t8413InBlock.shcode).toBe('005930');
    expect(ib.t8413InBlock.gubun).toBe('2');
    expect(ib.t8413InBlock.sujung).toBe('Y');   // 수정주가 요청
    expect(ib.t8413InBlock.sdate).toBe('20220101');
    expect(ib.t8413InBlock.edate).toBe('20260812');
  });
  it('US 는 rows=0 → 여전히 미확정(봉인)', () => {
    expect(US_DAILY_TR.trCode).toBeNull();
    expect(US_DAILY_TR.buildInBlock).toBeNull();
    expect(isDailyTRReady(US_DAILY_TR)).toEqual({ ready: false, reason: 'DAILY_TR_UNCONFIRMED' });
  });
  it('dailyTRConfig(market) 라우팅', () => {
    expect(dailyTRConfig('KR')).toBe(KR_DAILY_TR);
    expect(dailyTRConfig('US')).toBe(US_DAILY_TR);
  });
});

describe('P0-32C daily-adapter — 미확정(US)이면 네트워크 호출 없이 즉시 fail-closed', () => {
  it('US fetcher.ready() 는 미확정 사유 반환', () => {
    expect(makeUSDailyFetcher().ready().ready).toBe(false);
    expect(makeUSDailyFetcher().ready().reason).toBe('DAILY_TR_UNCONFIRMED');
  });
  it('KR fetcher.ready() 는 이제 OK', () => {
    expect(makeKRDailyFetcher().ready()).toEqual({ ready: true, reason: 'OK' });
  });
  it('US fetch() 는 ready 실패 시 network 호출 없이 error 반환', async () => {
    const usf = makeUSDailyFetcher();
    const res = await usf.fetch({} as any, 'no-token', { symbol: 'AAPL', sdate: '20200101', edate: '20231231' });
    expect(res.ok).toBe(false);
    expect(res.pages).toBe(0);
    expect(res.error).toBe('DAILY_TR_UNCONFIRMED');
    expect(res.candles).toEqual([]);
  });
});
