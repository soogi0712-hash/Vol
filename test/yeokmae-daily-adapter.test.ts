import { describe, it, expect } from 'vitest';
import { KR_DAILY_TR, US_DAILY_TR, dailyTRConfig, isDailyTRReady, EMPTY_DAILY_FIELD_MAP_CONFIG } from '../local-runner/yeokmae/daily-tr-config';

describe('P0-32D daily-tr-config — KR/US 모두 확정', () => {
  it('KR 확정(t8413, jdiff_vol, DATE_WINDOW)', () => {
    expect(KR_DAILY_TR.trCode).toBe('t8413');
    expect(KR_DAILY_TR.endpoint).toBe('/stock/chart');
    expect(KR_DAILY_TR.pagination).toBe('DATE_WINDOW');
    expect(KR_DAILY_TR.fieldMap.volume).toBe('jdiff_vol');
    expect(KR_DAILY_TR.fieldMap.turnover).toBe('value');
    expect(isDailyTRReady(KR_DAILY_TR)).toEqual({ ready: true, reason: 'OK' });
  });
  it('KR buildInBlock — t8413InBlock 실측 필드', () => {
    const ib = KR_DAILY_TR.buildInBlock!({ symbol: '005930', sdate: '20220101', edate: '20260812' }) as any;
    expect(ib.t8413InBlock.shcode).toBe('005930');
    expect(ib.t8413InBlock.gubun).toBe('2');
    expect(ib.t8413InBlock.sujung).toBe('Y');
  });
  it('US 확정(g3204, gubun=2, volume=volume, turnover=amount)', () => {
    expect(US_DAILY_TR.trCode).toBe('g3204');
    expect(US_DAILY_TR.endpoint).toBe('/overseas-stock/chart');
    expect(US_DAILY_TR.pagination).toBe('DATE_WINDOW');
    expect(US_DAILY_TR.fieldMap.volume).toBe('volume');
    expect(US_DAILY_TR.fieldMap.turnover).toBe('amount');
    expect(US_DAILY_TR.successCodes).toEqual(['00000']);
    expect(isDailyTRReady(US_DAILY_TR)).toEqual({ ready: true, reason: 'OK' });
  });
  it('US buildInBlock — g3204InBlock plain symbol + 런타임 exchcd/delaygb', () => {
    const ib = US_DAILY_TR.buildInBlock!({ symbol: 'AAPL', exchcd: '82', delaygb: 'R', sdate: '20240101', edate: '20260812' }) as any;
    expect(ib.g3204InBlock.symbol).toBe('AAPL');          // plain (82AAPL 은 rows=0)
    expect(ib.g3204InBlock.keysymbol).toBe('82AAPL');     // keysymbol 만 prefixed
    expect(ib.g3204InBlock.exchcd).toBe('82');
    expect(ib.g3204InBlock.gubun).toBe('2');
    expect(ib.g3204InBlock.delaygb).toBe('R');
  });
  it('dailyTRConfig(market) 라우팅', () => {
    expect(dailyTRConfig('KR')).toBe(KR_DAILY_TR);
    expect(dailyTRConfig('US')).toBe(US_DAILY_TR);
  });
});

describe('P0-32D daily-tr-config — 미확정 config 는 여전히 fail-closed', () => {
  it('빈 field map/미확정 config → isDailyTRReady 단계별 사유', () => {
    expect(isDailyTRReady(EMPTY_DAILY_FIELD_MAP_CONFIG).ready).toBe(false);
    expect(isDailyTRReady(EMPTY_DAILY_FIELD_MAP_CONFIG).reason).toBe('DAILY_TR_UNCONFIRMED');
    const step1 = { ...EMPTY_DAILY_FIELD_MAP_CONFIG, trCode: 'x', endpoint: '/stock/chart' as const };
    expect(isDailyTRReady(step1).reason).toBe('PAGINATION_STRATEGY_UNCONFIRMED');
    const step2 = { ...step1, pagination: 'DATE_WINDOW' as const };
    expect(isDailyTRReady(step2).reason).toBe('SUCCESS_CODE_UNCONFIRMED');
    const step3 = { ...step2, successCodes: ['00000'] };
    expect(isDailyTRReady(step3).reason).toBe('INBLOCK_BUILDER_UNCONFIRMED');
    const step4 = { ...step3, buildInBlock: () => ({}) };
    expect(isDailyTRReady(step4)).toEqual({ ready: true, reason: 'OK' });
  });
});
