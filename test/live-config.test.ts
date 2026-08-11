import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadLiveConfig, isLiveSymbol } from '../local-runner/live-config';

const KEYS = ['LS_US_LIVE_SYMBOL', 'LS_US_MAX_QTY', 'LS_US_PER_TRADE_BUDGET_USD', 'LS_US_DAILY_MAX_BUYS', 'LS_US_DAILY_MAX_SELLS', 'LS_TRADING_ARMED', 'LS_LIVE_TRADING', 'LS_CANCEL_TR_CONFIRMED', 'LS_US_PENDING_TIMEOUT_SEC', 'LS_US_HTS_ORDERABLE_QTY', 'LS_US_CROSS_WON_VERIFIED'];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = {}; for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('loadLiveConfig — 오늘 실전 제한 강제', () => {
  it('기본값: NASDAQ:AAPL, maxQty=null(하드1 제거), 예산=null(미설정), 일일매수상한=10, armed/live/cancel=false', () => {
    const c = loadLiveConfig();
    expect(c).toMatchObject({ liveSymbol: 'AAPL', liveExchange: 'NASDAQ', liveExchcd: '82', maxQty: null, perTradeBudgetUsd: null, dailyMaxBuys: 10, armed: false, liveTrading: false, cancelConfirmed: false });
  });
  it('LS_US_LIVE_SYMBOL 파싱(NYSE:BA → exchcd 81)', () => {
    process.env.LS_US_LIVE_SYMBOL = 'NYSE:BA';
    const c = loadLiveConfig();
    expect(c.liveSymbol).toBe('BA'); expect(c.liveExchcd).toBe('81');
  });
  it('P0-29A: maxQty 하드1 제거 — 미설정=null, 설정 시 선택적 안전 상한(정수>0)만 반영', () => {
    expect(loadLiveConfig().maxQty).toBeNull();       // 미설정 → 예산이 상한 결정
    process.env.LS_US_MAX_QTY = '5';
    expect(loadLiveConfig().maxQty).toBe(5);
    process.env.LS_US_MAX_QTY = '0';                  // 비정상 → null
    expect(loadLiveConfig().maxQty).toBeNull();
    process.env.LS_US_MAX_QTY = '   ';
    expect(loadLiveConfig().maxQty).toBeNull();
  });
  it('P0-29A: LS_US_PER_TRADE_BUDGET_USD — 미설정=null(fail-closed), 설정 시 양수 파싱', () => {
    expect(loadLiveConfig().perTradeBudgetUsd).toBeNull();
    process.env.LS_US_PER_TRADE_BUDGET_USD = '1500';
    expect(loadLiveConfig().perTradeBudgetUsd).toBe(1500);
    process.env.LS_US_PER_TRADE_BUDGET_USD = '999.5';
    expect(loadLiveConfig().perTradeBudgetUsd).toBe(999.5);
    process.env.LS_US_PER_TRADE_BUDGET_USD = '0';     // 비정상(<=0) → null
    expect(loadLiveConfig().perTradeBudgetUsd).toBeNull();
    process.env.LS_US_PER_TRADE_BUDGET_USD = '   ';
    expect(loadLiveConfig().perTradeBudgetUsd).toBeNull();
  });
  it('P0-30A: 일일 매수 운영상한 env 반영(하루1 고정 해제) — 5 요청 시 5, 0 이면 0, 100 초과는 100 클램프', () => {
    process.env.LS_US_DAILY_MAX_BUYS = '5';
    expect(loadLiveConfig().dailyMaxBuys).toBe(5);
    process.env.LS_US_DAILY_MAX_BUYS = '0';
    expect(loadLiveConfig().dailyMaxBuys).toBe(0);        // 0 = 매수 비활성(운영선택)
    process.env.LS_US_DAILY_MAX_BUYS = '9999';
    expect(loadLiveConfig().dailyMaxBuys).toBe(100);      // 난사방지 상한
  });
  it('P0-30A: dailyMaxSells 는 게이트 미사용(청산 보장) — env 그대로 반영(정보값)', () => {
    process.env.LS_US_DAILY_MAX_SELLS = '9';
    expect(loadLiveConfig().dailyMaxSells).toBe(9);
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
  it('P0-20 crossWonVerified: 코드상수 확정 → 기본 true, kill-switch(env=false) 로 비활성', () => {
    expect(loadLiveConfig().crossWonVerified).toBe(true);
    process.env.LS_US_CROSS_WON_VERIFIED = 'false';
    expect(loadLiveConfig().crossWonVerified).toBe(false);
    process.env.LS_US_CROSS_WON_VERIFIED = 'true';
    expect(loadLiveConfig().crossWonVerified).toBe(true);
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
