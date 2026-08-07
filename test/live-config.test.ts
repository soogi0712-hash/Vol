import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadLiveConfig, isLiveSymbol } from '../local-runner/live-config';

const KEYS = ['LS_US_LIVE_SYMBOL', 'LS_US_MAX_QTY', 'LS_US_DAILY_MAX_BUYS', 'LS_US_DAILY_MAX_SELLS', 'LS_TRADING_ARMED', 'LS_LIVE_TRADING', 'LS_CANCEL_TR_CONFIRMED', 'LS_US_PENDING_TIMEOUT_SEC', 'LS_US_HTS_ORDERABLE_QTY'];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = {}; for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('loadLiveConfig — 오늘 실전 제한 강제', () => {
  it('기본값: NASDAQ:AAPL, 1주, 하루 1/1, armed/live/cancel=false', () => {
    const c = loadLiveConfig();
    expect(c).toMatchObject({ liveSymbol: 'AAPL', liveExchange: 'NASDAQ', liveExchcd: '82', maxQty: 1, dailyMaxBuys: 1, dailyMaxSells: 1, armed: false, liveTrading: false, cancelConfirmed: false });
  });
  it('LS_US_LIVE_SYMBOL 파싱(NYSE:BA → exchcd 81)', () => {
    process.env.LS_US_LIVE_SYMBOL = 'NYSE:BA';
    const c = loadLiveConfig();
    expect(c.liveSymbol).toBe('BA'); expect(c.liveExchcd).toBe('81');
  });
  it('maxQty 는 1로 상한 강제(2 요청해도 1)', () => {
    process.env.LS_US_MAX_QTY = '2';
    expect(loadLiveConfig().maxQty).toBe(1);
  });
  it('일일 매수/매도 상한 1로 강제', () => {
    process.env.LS_US_DAILY_MAX_BUYS = '5';
    process.env.LS_US_DAILY_MAX_SELLS = '9';
    const c = loadLiveConfig();
    expect(c.dailyMaxBuys).toBe(1); expect(c.dailyMaxSells).toBe(1);
  });
  it('armed/live/cancel env 반영', () => {
    process.env.LS_TRADING_ARMED = 'true';
    process.env.LS_LIVE_TRADING = 'true';
    process.env.LS_CANCEL_TR_CONFIRMED = 'true';
    const c = loadLiveConfig();
    expect(c.armed).toBe(true); expect(c.liveTrading).toBe(true); expect(c.cancelConfirmed).toBe(true);
  });
  it('LS_US_HTS_ORDERABLE_QTY — 미설정=null, 설정 시 정수 파싱(HTS 교차검증값)', () => {
    expect(loadLiveConfig().htsOrderableQty).toBeNull();
    process.env.LS_US_HTS_ORDERABLE_QTY = '2';
    expect(loadLiveConfig().htsOrderableQty).toBe(2);
    process.env.LS_US_HTS_ORDERABLE_QTY = '0';
    expect(loadLiveConfig().htsOrderableQty).toBe(0);
    process.env.LS_US_HTS_ORDERABLE_QTY = '   ';
    expect(loadLiveConfig().htsOrderableQty).toBeNull();
  });
  it('거래소 미확인 심볼 → 예외(추측 금지)', () => {
    process.env.LS_US_LIVE_SYMBOL = 'LSE:VOD';   // 미확인 거래소
    expect(() => loadLiveConfig()).toThrow();
  });
  it('isLiveSymbol — 대상 1종목만 true', () => {
    const c = loadLiveConfig();
    expect(isLiveSymbol(c, 'AAPL')).toBe(true);
    expect(isLiveSymbol(c, 'aapl')).toBe(true);
    expect(isLiveSymbol(c, 'TSLA')).toBe(false);
  });
});
