import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { computeUSP0Checklist } from '../local-runner/us-live-checklist';
import { loadLiveConfig } from '../local-runner/live-config';

const KEYS = ['LS_US_LIVE_SYMBOL', 'LS_US_MAX_QTY', 'LS_US_DAILY_MAX_BUYS', 'LS_US_DAILY_MAX_SELLS', 'LS_TRADING_ARMED', 'LS_LIVE_TRADING', 'LS_CANCEL_TR_CONFIRMED', 'LS_AUTO_CANCEL_MODE'];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = {}; for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('P0-10 최종 체크리스트', () => {
  it('오늘 기본 설정(AAPL·1주·하루1) → 10개 플래그 전부 true, US_LIVE_READY=true', () => {
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
      US_LIVE_READY: true,
    });
  });
  it('LS_AUTO_CANCEL_MODE=true 여도 코드상수(취소TR 미확인)로 자동취소 불가 → 수동모드 유지', () => {
    process.env.LS_AUTO_CANCEL_MODE = 'true';
    const c = computeUSP0Checklist(loadLiveConfig());
    expect(c.AUTO_CANCEL_MODE).toBe(false);
    expect(c.MANUAL_CANCEL_MODE).toBe(true);
    expect(c.US_LIVE_READY).toBe(true);
  });
  it('일일제한 위반(종목/수량) → US_DAILY_BUY_LIMIT=false, US_LIVE_READY=false', () => {
    process.env.LS_US_LIVE_SYMBOL = 'NASDAQ:TSLA';
    const c = computeUSP0Checklist(loadLiveConfig());
    expect(c.US_DAILY_BUY_LIMIT).toBe(false);
    expect(c.US_LIVE_READY).toBe(false);
  });
});
