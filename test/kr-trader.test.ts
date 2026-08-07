import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeKRBuyOrder, reconcileKRPending, type KRTraderDeps } from '../local-runner/kr-trader';
import { OrderStore } from '../local-runner/order-store';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kr-trader-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

let clock = 1_000_000;
const exec = (o: Partial<any> = {}) => ({ ok: true, rspCd: '00000', rspMsg: '', buyOrdQty: 1, buyExecQty: 0, sellOrdQty: 0, sellExecQty: 0, ...o });
function deps(over: Partial<KRTraderDeps> = {}): KRTraderDeps {
  return {
    place: async () => ({ rspCd: '00000', rspMsg: 'ok', ordNo: '32004', raw: {}, diag: {} as any }),
    queryExec: async () => exec(),
    now: () => clock,
    log: () => {},
    ...over,
  };
}
const params = (orders: OrderStore, over: Partial<any> = {}) => ({ orders, shcode: '005930', candleDatetime: '202608071500', qty: 1, price: 70000, krDate: '20260807', mbrNo: 'NXT', dailyMaxBuys: 1, ...over });

describe('executeKRBuyOrder — 전송/체결/부분/미체결', () => {
  beforeEach(() => { clock = 1_000_000; });
  it('전량 체결 → placed-filled, 주문번호 저장 + pending 해소 + 일일카운트', async () => {
    const orders = new OrderStore('KR_005930', dir);
    const r = await executeKRBuyOrder(deps({ queryExec: async () => exec({ buyOrdQty: 1, buyExecQty: 1 }) }), params(orders));
    expect(r.status).toBe('placed-filled');
    expect(r.ordNo).toBe('32004');
    expect(orders.hasPending()).toBe(false);
    expect(orders.buyCountToday('20260807')).toBe(1);
  });
  it('부분 체결 → placed-partial, pending 유지', async () => {
    const orders = new OrderStore('KR_005930', dir);
    const r = await executeKRBuyOrder(deps({ queryExec: async () => exec({ buyOrdQty: 2, buyExecQty: 1 }) }), params(orders, { qty: 2 }));
    expect(r.status).toBe('placed-partial');
    expect(r.execQty).toBe(1);
    expect(orders.hasPending()).toBe(true);
  });
  it('미체결 → placed-pending, pending 유지(주문번호 저장됨)', async () => {
    const orders = new OrderStore('KR_005930', dir);
    const r = await executeKRBuyOrder(deps({ queryExec: async () => exec({ buyOrdQty: 1, buyExecQty: 0 }) }), params(orders));
    expect(r.status).toBe('placed-pending');
    expect(orders.pending[0].ordNo).toBe('32004');
    expect(orders.pending[0].placedAtMs).toBe(1_000_000);
  });
  it('체결조회 실패는 체결완료로 오판하지 않음 → placed-pending', async () => {
    const orders = new OrderStore('KR_005930', dir);
    const r = await executeKRBuyOrder(deps({ queryExec: async () => exec({ ok: false, rspCd: 'ERR', buyExecQty: 0 }) }), params(orders));
    expect(r.status).toBe('placed-pending');
    expect(orders.hasPending()).toBe(true);
  });
  it('원문 rsp_cd/rsp_msg 저장(주문+체결조회)', async () => {
    const orders = new OrderStore('KR_005930', dir);
    await executeKRBuyOrder(deps(), params(orders));
    expect(orders.responses.map(a => a.tr)).toEqual(expect.arrayContaining(['CSPAT00601', 'CSPAQ13700']));
  });
});

describe('executeKRBuyOrder — 방어적 abort(자동 재주문 없음)', () => {
  beforeEach(() => { clock = 1_000_000; });
  it('일일 한도 초과 → aborted, place 미호출', async () => {
    const orders = new OrderStore('KR_005930', dir);
    orders.recordPlaced('buy', '202608071445', '20260807', { ordNo: '1', symbol: '005930', qty: 1, price: 70000, placedAtMs: 1 });
    let placed = false;
    const r = await executeKRBuyOrder(deps({ place: async () => { placed = true; return { rspCd: '00000', rspMsg: '', ordNo: '2', raw: {}, diag: {} as any }; } }), params(orders));
    expect(r.status).toBe('aborted'); expect(placed).toBe(false);
  });
  it('미체결 존재 → aborted', async () => {
    const orders = new OrderStore('KR_005930', dir);
    orders.recordPlaced('buy', '202608061500', '20260806', { ordNo: '9', symbol: '005930', qty: 1, price: 70000, placedAtMs: 1 });
    const r = await executeKRBuyOrder(deps(), params(orders));
    expect(r.status).toBe('aborted'); expect(r.reason).toMatch(/미체결/);
  });
  it('주문 거부(rsp_cd!=00000) → aborted, 원문 저장, 재주문 없음', async () => {
    const orders = new OrderStore('KR_005930', dir);
    const r = await executeKRBuyOrder(deps({ place: async () => ({ rspCd: '08085', rspMsg: '주문거부', ordNo: null, raw: {}, diag: {} as any }) }), params(orders));
    expect(r.status).toBe('aborted');
    expect(orders.responses.some(a => a.rspCd === '08085')).toBe(true);
    expect(orders.hasPending()).toBe(false);
  });
});

describe('reconcileKRPending — 재시작 후 미체결 재확인', () => {
  beforeEach(() => { clock = 1_000_000; });
  it('재시작(load) 후 pending 복원 → 전량체결 확인 시 해소', async () => {
    const s1 = new OrderStore('KR_005930', dir);
    s1.recordPlaced('buy', '202608071500', '20260807', { ordNo: '32004', symbol: '005930', qty: 1, price: 70000, placedAtMs: 1 });
    s1.flush();
    const s2 = new OrderStore('KR_005930', dir); s2.load();
    expect(s2.hasPending()).toBe(true);   // 재시작 복원
    const rec = await reconcileKRPending(deps({ queryExec: async () => exec({ buyOrdQty: 1, buyExecQty: 1 }) }), { orders: s2, shcode: '005930', krDate: '20260807' });
    expect(rec[0].status).toBe('filled');
    expect(s2.hasPending()).toBe(false);
  });
  it('부분체결 → partial, pending 유지', async () => {
    const s = new OrderStore('KR_005930', dir);
    s.recordPlaced('buy', '202608071500', '20260807', { ordNo: '32004', symbol: '005930', qty: 2, price: 70000, placedAtMs: 1 });
    const rec = await reconcileKRPending(deps({ queryExec: async () => exec({ buyOrdQty: 2, buyExecQty: 1 }) }), { orders: s, shcode: '005930', krDate: '20260807' });
    expect(rec[0].status).toBe('partial');
    expect(s.hasPending()).toBe(true);
  });
  it('체결조회 실패 → query-failed, pending 유지(오판 금지)', async () => {
    const s = new OrderStore('KR_005930', dir);
    s.recordPlaced('buy', '202608071500', '20260807', { ordNo: '32004', symbol: '005930', qty: 1, price: 70000, placedAtMs: 1 });
    const rec = await reconcileKRPending(deps({ queryExec: async () => exec({ ok: false, rspCd: 'ERR' }) }), { orders: s, shcode: '005930', krDate: '20260807' });
    expect(rec[0].status).toBe('query-failed');
    expect(s.hasPending()).toBe(true);
  });
});
