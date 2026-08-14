// P0-33A — KR 위험청산 판정 + KR SELL executor 안전경로 + SELL 게이트(BUY 무관). 실 POST 없음(mock).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateKRExit, resolveKRExitPolicy, type KRExitPolicy } from '../local-runner/yeokmae/kr-live-core';
import { executeKRSellOrder, type KRSellDeps } from '../local-runner/kr-seller';
import { evaluateKRSellGate } from '../local-runner/yeokmae-kr-sell-run';
import { OrderStore } from '../local-runner/order-store';
import type { LSKROrderExec } from '../src/lib/ls-api';

const policy = (over: Partial<KRExitPolicy> = {}): KRExitPolicy => ({ stopLossPct: 5, takeProfitPct: 8, maxHoldDays: 20, emergencyStopPct: 15, confirmed: true, pendingDecisions: [], ...over });

describe('P0-33A evaluateKRExit — 위험청산 우선순위', () => {
  const p = policy();
  it('-5% 이하 → STOP_LOSS SELL', () => {
    const d = evaluateKRExit({ entryAvgPrice: 10000, currentPrice: 9500, holdDays: 1, policy: p });   // -5%
    expect(d.action).toBe('SELL'); expect(d.reason).toBe('STOP_LOSS');
  });
  it('+8% 이상 → TAKE_PROFIT SELL', () => {
    const d = evaluateKRExit({ entryAvgPrice: 10000, currentPrice: 10800, holdDays: 1, policy: p });   // +8%
    expect(d.action).toBe('SELL'); expect(d.reason).toBe('TAKE_PROFIT');
  });
  it('20거래일 도달 → MAX_HOLD_DAYS SELL', () => {
    const d = evaluateKRExit({ entryAvgPrice: 10000, currentPrice: 10100, holdDays: 20, policy: p });   // +1%, 20일
    expect(d.action).toBe('SELL'); expect(d.reason).toBe('MAX_HOLD_DAYS');
  });
  it('-15% → EMERGENCY_STOP 최우선(STOP_LOSS 보다 우선)', () => {
    const d = evaluateKRExit({ entryAvgPrice: 10000, currentPrice: 8500, holdDays: 1, policy: p });   // -15%
    expect(d.action).toBe('SELL'); expect(d.reason).toBe('EMERGENCY_STOP');   // -15%는 STOP_LOSS(-5%)도 만족하나 EMERGENCY 우선
  });
  it('-2%(임계 사이) → HOLD', () => {
    expect(evaluateKRExit({ entryAvgPrice: 10000, currentPrice: 9800, holdDays: 1, policy: p }).action).toBe('HOLD');
  });
  it('평단 불명확(entryAvg<=0) → HOLD(임의 생성 금지)', () => {
    const d = evaluateKRExit({ entryAvgPrice: 0, currentPrice: 9800, holdDays: 1, policy: p });
    expect(d.action).toBe('HOLD'); expect(d.pnlPct).toBeNull(); expect(d.note).toContain('NO_ENTRY_AVG');
  });
  it('emergency 는 전략값 미설정(stopLoss=null)이어도 항상 활성', () => {
    const d = evaluateKRExit({ entryAvgPrice: 10000, currentPrice: 8000, holdDays: 1, policy: policy({ stopLossPct: null, takeProfitPct: null, maxHoldDays: null }) });
    expect(d.reason).toBe('EMERGENCY_STOP');
  });
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kr-sell-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const krExec = (over: Partial<LSKROrderExec> = {}): LSKROrderExec => ({ ok: true, rspCd: '00000', rspMsg: '', buyOrdQty: 0, buyExecQty: 0, sellOrdQty: 0, sellExecQty: 0, classification: 'EMPTY' as any, ...over });
function harness(over: { freshQty?: { ok: boolean; qty: number }; placeRes?: any; afterSellExec?: number } = {}) {
  let placeCalls = 0; let placed = false;
  const deps: KRSellDeps = {
    place: async (p) => { placeCalls++; placed = true; return over.placeRes ?? { rspCd: '00040', rspMsg: '매도 완료', ordNo: '700', raw: {}, diag: {} as any }; },
    queryExec: async () => placed ? krExec({ sellOrdQty: over.afterSellExec ?? 7, sellExecQty: over.afterSellExec ?? 7, classification: 'SUCCESS' as any, rspCd: '00000' }) : krExec(),
    freshSellable: async () => over.freshQty ?? { ok: true, qty: 100 },
    now: () => 1_000_000, log: () => {},
  };
  return { deps, placeCalls: () => placeCalls };
}
const params = (orders: OrderStore, qty = 7) => ({ orders, shcode: '005930', candleDatetime: '20260814', qty, price: 61000, krDate: '20260814' });

describe('P0-33A executeKRSellOrder — 안전경로', () => {
  it('sellable 10 / position 7 → sellQty=7', async () => {
    const orders = new OrderStore('YEOKMAE_KR_005930', dir); orders.load();
    const h = harness({ freshQty: { ok: true, qty: 10 }, afterSellExec: 7 });
    const r = await executeKRSellOrder(h.deps, params(orders, 7));
    expect(r.status).toBe('placed-filled'); expect(r.execQty).toBe(7); expect(h.placeCalls()).toBe(1);
  });
  it('sellable 3 / position 7 → sellQty=3(과매도 방지)', async () => {
    const orders = new OrderStore('YEOKMAE_KR_005930', dir); orders.load();
    const h = harness({ freshQty: { ok: true, qty: 3 }, afterSellExec: 3 });
    const r = await executeKRSellOrder(h.deps, params(orders, 7));
    expect(r.execQty).toBe(3);
  });
  it('sellable 0 → POST 0(freshSellable=0)', async () => {
    const orders = new OrderStore('YEOKMAE_KR_005930', dir); orders.load();
    const h = harness({ freshQty: { ok: true, qty: 0 } });
    const r = await executeKRSellOrder(h.deps, params(orders, 7));
    expect(r.status).toBe('aborted'); expect(r.abortCode).toBe('NO_QTY'); expect(h.placeCalls()).toBe(0);
  });
  it('holdings 조회 실패 → POST 0(fail-closed)', async () => {
    const orders = new OrderStore('YEOKMAE_KR_005930', dir); orders.load();
    const h = harness({ freshQty: { ok: false, qty: 0 } });
    const r = await executeKRSellOrder(h.deps, params(orders, 7));
    expect(r.abortCode).toBe('RECONCILIATION_FAILED'); expect(h.placeCalls()).toBe(0);
  });
  it('pending SELL 존재 → 중복 0', async () => {
    const orders = new OrderStore('YEOKMAE_KR_005930', dir); orders.load();
    orders.recordPlaced('sell', '20260813', '20260813', { ordNo: '600', symbol: '005930', qty: 1, price: 60000, placedAtMs: 1 }); orders.flush();
    const h = harness();
    const r = await executeKRSellOrder(h.deps, params(orders, 7));
    expect(r.abortCode).toBe('PENDING_SELL'); expect(h.placeCalls()).toBe(0);
  });
  it('미체결 후 재실행 → 재POST 0(candle 잠금)', async () => {
    const orders = new OrderStore('YEOKMAE_KR_005930', dir); orders.load();
    // 1차: 미체결(placed-pending) — candle lock + pending sell 기록
    const h1 = harness({ freshQty: { ok: true, qty: 10 }, afterSellExec: 0 });
    const r1 = await executeKRSellOrder(h1.deps, params(orders, 7));
    expect(r1.status).toBe('placed-pending'); expect(h1.placeCalls()).toBe(1);
    // 2차: 동일 candle 재실행 → pending SELL 로 즉시 차단(재POST 0)
    const h2 = harness({ freshQty: { ok: true, qty: 10 } });
    const r2 = await executeKRSellOrder(h2.deps, params(orders, 7));
    expect(r2.status).toBe('aborted'); expect(h2.placeCalls()).toBe(0);
  });
  it('broker 거부(비성공) → ORDER_REJECTED', async () => {
    const orders = new OrderStore('YEOKMAE_KR_005930', dir); orders.load();
    const h = harness({ freshQty: { ok: true, qty: 10 }, placeRes: { rspCd: '40510', rspMsg: '거부', ordNo: null, raw: {}, diag: {} as any } });
    const r = await executeKRSellOrder(h.deps, params(orders, 7));
    expect(r.abortCode).toBe('ORDER_REJECTED');
  });
});

describe('P0-33A evaluateKRSellGate — SELL 은 BUY 게이트와 무관(item5)', () => {
  const base = { strategyTag: 'YEOKMAE', exitAction: 'SELL' as const, sellLive: true, exitConfirmed: true, dryRun: false, pendingSell: false, reconciliationOk: true };
  it('모든 SELL 게이트 충족 → allowed(=BUY 자본한도/하루매수 상태 참조 안 함)', () => {
    expect(evaluateKRSellGate(base).allowed).toBe(true);
  });
  it('strategyTag!=YEOKMAE(LEGACY/UNKNOWN) → 차단', () => {
    expect(evaluateKRSellGate({ ...base, strategyTag: 'LEGACY_BB' }).reasons).toContain('NOT_YEOKMAE');
  });
  it('sellLive off / exitConfirmed off / dryRun / pending / recon 실패 → 각각 차단', () => {
    expect(evaluateKRSellGate({ ...base, sellLive: false }).reasons).toContain('SELL_LIVE_OFF');
    expect(evaluateKRSellGate({ ...base, exitConfirmed: false }).reasons).toContain('EXIT_NOT_CONFIRMED');
    expect(evaluateKRSellGate({ ...base, dryRun: true }).reasons).toContain('DRY_RUN');
    expect(evaluateKRSellGate({ ...base, pendingSell: true }).reasons).toContain('PENDING_SELL');
    expect(evaluateKRSellGate({ ...base, reconciliationOk: false }).reasons).toContain('RECON_NOT_OK');
  });
});
