// P0-34 — US SELL 게이트(BUY 무관) + 운영 exit 판정 재사용. 실 POST 없음.
import { describe, it, expect } from 'vitest';
import { evaluateUSSellGate } from '../local-runner/yeokmae-us-sell-run';
import { evaluateUSExit } from '../local-runner/yeokmae/us-live-core';
import type { USExitPolicy } from '../local-runner/yeokmae/us-live-core';

const policy = (over: Partial<USExitPolicy> = {}): USExitPolicy => ({ stopLossPct: 5, takeProfitPct: 8, maxHoldDays: 20, emergencyStopPct: 15, confirmed: true, pendingDecisions: [], ...over });

describe('P0-34 evaluateUSSellGate — SELL 은 BUY 게이트와 무관', () => {
  const base = { strategyTag: 'YEOKMAE', exitAction: 'SELL' as const, sellLive: true, exitConfirmed: true, dryRun: false, pendingSell: false, reconciliationOk: true };
  it('모든 SELL 게이트 충족 → allowed', () => {
    expect(evaluateUSSellGate(base).allowed).toBe(true);
  });
  it('strategyTag!=YEOKMAE(수동/LEGACY) → 차단(수동보유 자동 SELL 금지)', () => {
    expect(evaluateUSSellGate({ ...base, strategyTag: 'UNKNOWN' }).reasons).toContain('NOT_YEOKMAE');
    expect(evaluateUSSellGate({ ...base, strategyTag: 'LEGACY_BB' }).reasons).toContain('NOT_YEOKMAE');
  });
  it('sellLive/exitConfirmed/dryRun/pending/recon 각각 차단', () => {
    expect(evaluateUSSellGate({ ...base, sellLive: false }).reasons).toContain('SELL_LIVE_OFF');
    expect(evaluateUSSellGate({ ...base, exitConfirmed: false }).reasons).toContain('EXIT_NOT_CONFIRMED');
    expect(evaluateUSSellGate({ ...base, dryRun: true }).reasons).toContain('DRY_RUN');
    expect(evaluateUSSellGate({ ...base, pendingSell: true }).reasons).toContain('PENDING_SELL');
    expect(evaluateUSSellGate({ ...base, reconciliationOk: false }).reasons).toContain('RECON_NOT_OK');
  });
});

describe('P0-34 evaluateUSExit — 운영 risk policy(KR 과 동일 우선순위)', () => {
  const p = policy();
  it('-5% 이하 → STOP_LOSS', () => {
    expect(evaluateUSExit({ entryAvgPrice: 100, currentPrice: 95, holdDays: 1, policy: p }).reason).toBe('STOP_LOSS');
  });
  it('+8% 이상 → TAKE_PROFIT', () => {
    expect(evaluateUSExit({ entryAvgPrice: 100, currentPrice: 108, holdDays: 1, policy: p }).reason).toBe('TAKE_PROFIT');
  });
  it('20거래일 → MAX_HOLD_DAYS', () => {
    expect(evaluateUSExit({ entryAvgPrice: 100, currentPrice: 101, holdDays: 20, policy: p }).reason).toBe('MAX_HOLD_DAYS');
  });
  it('-15% → EMERGENCY_STOP 최우선', () => {
    expect(evaluateUSExit({ entryAvgPrice: 100, currentPrice: 85, holdDays: 1, policy: p }).reason).toBe('EMERGENCY_STOP');
  });
  it('평단 불명확(<=0) → HOLD(임의 생성 금지)', () => {
    expect(evaluateUSExit({ entryAvgPrice: 0, currentPrice: 95, holdDays: 1, policy: p }).action).toBe('HOLD');
  });
});
