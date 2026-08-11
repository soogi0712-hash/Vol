import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { computeUSP0Checklist } from '../local-runner/us-live-checklist';
import { loadLiveConfig } from '../local-runner/live-config';

const KEYS = ['LS_US_LIVE_SYMBOL', 'LS_US_MAX_QTY', 'LS_US_PER_TRADE_BUDGET_USD', 'LS_US_DAILY_MAX_BUYS', 'LS_US_DAILY_MAX_SELLS', 'LS_TRADING_ARMED', 'LS_LIVE_TRADING', 'LS_CANCEL_TR_CONFIRMED', 'LS_AUTO_CANCEL_MODE', 'LS_US_CROSS_WON_VERIFIED'];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = {}; for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  // P0-29A: 실전 준비는 1회 거래예산 설정을 요구한다(fail-closed). 기본 테스트는 예산을 설정한 상태로 둔다.
  process.env.LS_US_PER_TRADE_BUDGET_USD = '1000';
});
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('P0-10 최종 체크리스트', () => {
  it('P0-29A 기본 설정(하루1 + 예산설정) → 타통화+원화 실측확인 완료 → US_LIVE_READY=true', () => {
    const c = computeUSP0Checklist(loadLiveConfig());
    expect(c).toEqual({
      MANUAL_CANCEL_MODE: true,
      AUTO_CANCEL_MODE: false,
      US_ORDER_POST_IDEMPOTENT: true,
      US_CASH_ONLY_GATE: true,
      US_PENDING_REORDER_BLOCKED: true,
      US_RESTART_RECONCILIATION: true,
      US_AS_EVENT_LINKED: true,
      US_SINGLE_POST_PER_CANDLE: true,
      US_DAILY_BUY_LIMIT: true,
      US_PER_TRADE_BUDGET_SET: true,  // P0-29A: 1회 거래예산 설정됨
      US_CROSS_WON_VERIFIED: true,    // P0-20: 실측 검증 완료(코드상수+채택필드)
      US_LIVE_READY: true,            // 전 안전장치 + 예산설정 + 통합증거금 확정 → 실전 가능(단, LS_LIVE_TRADING=true 필요)
    });
  });
  it('P0-29A fail-closed: 1회 거래예산 미설정 → US_PER_TRADE_BUDGET_SET=false, US_LIVE_READY=false', () => {
    delete process.env.LS_US_PER_TRADE_BUDGET_USD;
    const c = computeUSP0Checklist(loadLiveConfig());
    expect(c.US_PER_TRADE_BUDGET_SET).toBe(false);
    expect(c.US_LIVE_READY).toBe(false);
  });
  it('P0-29A fail-closed: 예산 <=0(비정상) → US_PER_TRADE_BUDGET_SET=false, US_LIVE_READY=false', () => {
    process.env.LS_US_PER_TRADE_BUDGET_USD = '0';
    const c = computeUSP0Checklist(loadLiveConfig());
    expect(c.US_PER_TRADE_BUDGET_SET).toBe(false);
    expect(c.US_LIVE_READY).toBe(false);
  });
  it('LS_AUTO_CANCEL_MODE=true 여도 코드상수(취소TR 미확인)로 자동취소 불가 → 수동모드 유지', () => {
    process.env.LS_AUTO_CANCEL_MODE = 'true';
    const c = computeUSP0Checklist(loadLiveConfig());
    expect(c.AUTO_CANCEL_MODE).toBe(false);
    expect(c.MANUAL_CANCEL_MODE).toBe(true);
    expect(c.US_CROSS_WON_VERIFIED).toBe(true);
    expect(c.US_LIVE_READY).toBe(true);   // 수동취소 모드 + 예산설정 + 통합증거금 확정
  });
  it('P0-20 kill-switch: LS_US_CROSS_WON_VERIFIED=false → US_CROSS_WON_VERIFIED=false, US_LIVE_READY=false', () => {
    process.env.LS_US_CROSS_WON_VERIFIED = 'false';
    const c = computeUSP0Checklist(loadLiveConfig());
    expect(c.US_CROSS_WON_VERIFIED).toBe(false);
    expect(c.US_LIVE_READY).toBe(false);
  });
  it('P0-23: 종목 하드코딩 제거 — TSLA 여도 하루1+예산설정 이면 US_LIVE_READY=true(AAPL 강제 아님)', () => {
    process.env.LS_US_LIVE_SYMBOL = 'NASDAQ:TSLA';
    const c = computeUSP0Checklist(loadLiveConfig());
    expect(c.US_DAILY_BUY_LIMIT).toBe(true);   // 종목 무관, 하루 BUY 1회만 확인
    expect(c.US_LIVE_READY).toBe(true);
  });
  it('일일제한: dailyMaxBuys=0(매수 비활성) → US_DAILY_BUY_LIMIT=false, US_LIVE_READY=false', () => {
    process.env.LS_US_DAILY_MAX_BUYS = '0';
    const c = computeUSP0Checklist(loadLiveConfig());
    expect(c.US_DAILY_BUY_LIMIT).toBe(false);
    expect(c.US_LIVE_READY).toBe(false);
  });
  it('P0-30A: dailyMaxBuys=10(하루 1회 고정 해제) → US_DAILY_BUY_LIMIT=true, US_LIVE_READY=true (===1 필수조건 제거)', () => {
    process.env.LS_US_DAILY_MAX_BUYS = '10';
    const c = computeUSP0Checklist(loadLiveConfig());
    expect(c.US_DAILY_BUY_LIMIT).toBe(true);   // >=1 이면 통과 (예전 ===1 요구였으면 false 였음)
    expect(c.US_LIVE_READY).toBe(true);
  });
});
