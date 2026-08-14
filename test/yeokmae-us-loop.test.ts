// P0-34L — US 지속실행 루프 회귀: 주기분리/보유 exit 사이클/stale·MATCH 게이트/emergency/중복 POST 0. 실 POST 없음(mock).
import { describe, it, expect } from 'vitest';
import { resolveUSLoopIntervals, isDue, runUSSellCycle, type USQuote, type USSellCycleDeps } from '../local-runner/yeokmae/us-loop-core';
import type { USExitPolicy } from '../local-runner/yeokmae/us-live-core';
import type { YeokmaePosition } from '../local-runner/yeokmae-position-store';

const policy = (over: Partial<USExitPolicy> = {}): USExitPolicy => ({ stopLossPct: 5, takeProfitPct: 8, maxHoldDays: 20, emergencyStopPct: 15, confirmed: true, pendingDecisions: [], ...over });
const pos = (over: Partial<YeokmaePosition> = {}): YeokmaePosition => ({
  symbol: 'PRGO', strategyTag: 'YEOKMAE', exchcd: '82', entryDate: '2026-08-01', entryAvgPrice: 100, qty: 5,
  highestPrice: 100, highestPnlPct: 0, stopLossPct: 5, profitMode: 'FIXED' as any, takeProfitPct: 8,
  trailingActivatePct: 0, trailingDrawdownPct: 0, holdDays: 1, lastExitReason: null, confirmedSignalDate: '2026-07-31', matchedSignals: ['112_UPGRADE'], ...over,
});
// mock deps: quote 고정, brokerQty MATCH(=pos.qty), runSell 는 POST 횟수/사유 기록.
function mk(over: { quote?: USQuote; broker?: number | null; pendingAfterSell?: boolean } = {}) {
  const posts: { symbol: string; reason: string | null }[] = []; let pending = false;
  const deps: USSellCycleDeps = {
    quote: async () => over.quote ?? { ok: true, price: 100, stale: false },
    brokerQtyOf: () => over.broker === undefined ? 5 : over.broker,
    runSell: async ({ position, decision }) => {
      if (pending) return { posted: false };                 // pending SELL → 중복 POST 0(게이트 차단 모사)
      posts.push({ symbol: position.symbol, reason: decision.reason });
      if (over.pendingAfterSell) pending = true;
      return { posted: true };
    },
    log: () => {},
  };
  return { deps, posts: () => posts };
}
const ctx = (positions: YeokmaePosition[], over: any = {}) => ({ positions, policy: policy(), sessionOrderable: true, verbose: false, ...over });

describe('P0-34L resolveUSLoopIntervals — 주기분리(SELL 짧게 / reconcile 중간 / BUY 낮은빈도) + 하한 클램프', () => {
  it('기본값: sell<reconcile<buyRecalc', () => {
    const iv = resolveUSLoopIntervals({} as any);
    expect(iv.sellMs).toBe(7000); expect(iv.reconcileMs).toBe(60000); expect(iv.buyRecalcMs).toBe(1800000);
    expect(iv.sellMs).toBeLessThan(iv.reconcileMs); expect(iv.reconcileMs).toBeLessThan(iv.buyRecalcMs);
  });
  it('rate limiter 준수: sell 하한 2000ms 미만은 무시(폭주 방지)', () => {
    expect(resolveUSLoopIntervals({ US_LOOP_SELL_MS: '500' } as any).sellMs).toBe(7000);   // 하한 미달 → 기본
    expect(resolveUSLoopIntervals({ US_LOOP_SELL_MS: '3000' } as any).sellMs).toBe(3000);
  });
});

describe('P0-34L isDue — cadence(BUY 일봉 낮은빈도 = 매 cycle 재계산 안 함)', () => {
  it('lastAt=null → 즉시 due', () => { expect(isDue(null, 1000, 5000)).toBe(true); });
  it('경과<주기 → 아직 아님(BUY 재다운로드 폭주 방지)', () => { expect(isDue(1000, 1_800_000, 1000 + 7000)).toBe(false); });
  it('경과>=주기 → due', () => { expect(isDue(1000, 60000, 1000 + 60000)).toBe(true); });
});

describe('P0-34L runUSSellCycle — 보유 exit 사이클(주입식, 실 POST 없음)', () => {
  it('후보/보유 0 → 종료 아님(evaluated=0, 예외 없음)', async () => {
    const h = mk(); const r = await runUSSellCycle(h.deps, ctx([]));
    expect(r.evaluated).toBe(0); expect(r.sells).toBe(0);
  });
  it('HOLD(-2%) → SELL 0(다음 cycle 계속 실행 가능)', async () => {
    const h = mk({ quote: { ok: true, price: 98, stale: false } });   // -2%
    const r1 = await runUSSellCycle(h.deps, ctx([pos()]));
    expect(r1.holds).toBe(1); expect(r1.sells).toBe(0);
    const r2 = await runUSSellCycle(h.deps, ctx([pos()]));            // 다음 cycle 도 정상
    expect(r2.holds).toBe(1); expect(h.posts()).toHaveLength(0);
  });
  it('HOLD 다음 cycle -5% 도달 → SELL 1회(STOP_LOSS)', async () => {
    const hold = mk({ quote: { ok: true, price: 98, stale: false } });
    expect((await runUSSellCycle(hold.deps, ctx([pos()]))).sells).toBe(0);
    const stop = mk({ quote: { ok: true, price: 95, stale: false } });   // -5%
    const r = await runUSSellCycle(stop.deps, ctx([pos()]));
    expect(r.sells).toBe(1); expect(stop.posts()).toEqual([{ symbol: 'PRGO', reason: 'STOP_LOSS' }]);
  });
  it('+8% → SELL 1회(TAKE_PROFIT)', async () => {
    const h = mk({ quote: { ok: true, price: 108, stale: false } });
    const r = await runUSSellCycle(h.deps, ctx([pos()]));
    expect(r.sells).toBe(1); expect(h.posts()[0].reason).toBe('TAKE_PROFIT');
  });
  it('-15% → emergency SELL(EMERGENCY_STOP)', async () => {
    const h = mk({ quote: { ok: true, price: 85, stale: false } });
    const r = await runUSSellCycle(h.deps, ctx([pos()]));
    expect(r.sells).toBe(1); expect(h.posts()[0].reason).toBe('EMERGENCY_STOP');
  });
  it('MAX_HOLD 20거래일 → SELL(MAX_HOLD_DAYS)', async () => {
    const h = mk({ quote: { ok: true, price: 101, stale: false } });
    const r = await runUSSellCycle(h.deps, ctx([pos({ holdDays: 20 })]));
    expect(r.sells).toBe(1); expect(h.posts()[0].reason).toBe('MAX_HOLD_DAYS');
  });
  it('pending SELL → 다음 cycle 중복 POST 0', async () => {
    const h = mk({ quote: { ok: true, price: 95, stale: false }, pendingAfterSell: true });
    const r1 = await runUSSellCycle(h.deps, ctx([pos()]));   // 1차 SELL POST
    const r2 = await runUSSellCycle(h.deps, ctx([pos()]));   // pending → POST 0
    expect(r1.sells).toBe(1); expect(r2.sells).toBe(0); expect(h.posts()).toHaveLength(1);
  });
  it('stale quote → SELL POST 0(현재가 신뢰 못하면 청산 금지)', async () => {
    const h = mk({ quote: { ok: false, price: 0, stale: true, reason: 'EMPTY' } });
    const r = await runUSSellCycle(h.deps, ctx([pos({ entryAvgPrice: 100 })]));
    expect(r.sells).toBe(0); expect(r.skippedStale).toBe(1); expect(h.posts()).toHaveLength(0);
  });
  it('broker MISMATCH(외부/수동 변동) → 자동 exit 보류(SELL 0)', async () => {
    const h = mk({ quote: { ok: true, price: 85, stale: false }, broker: 3 });   // ledger5 vs broker3
    const r = await runUSSellCycle(h.deps, ctx([pos()]));
    expect(r.sells).toBe(0); expect(r.skippedUnmatched).toBe(1);
  });
  it('broker 미확보(reconcile 전) → SELL 0(fail-closed)', async () => {
    const h = mk({ quote: { ok: true, price: 85, stale: false }, broker: null });
    const r = await runUSSellCycle(h.deps, ctx([pos()]));
    expect(r.sells).toBe(0); expect(r.skippedUnmatched).toBe(1);
  });
  it('정규장 아님(sessionOrderable=false) + SELL 조건 → POST 보류(deferredClosed)', async () => {
    const h = mk({ quote: { ok: true, price: 85, stale: false } });
    const r = await runUSSellCycle(h.deps, ctx([pos()], { sessionOrderable: false }));
    expect(r.sells).toBe(0); expect(r.deferredClosed).toBe(1); expect(h.posts()).toHaveLength(0);
  });
});
