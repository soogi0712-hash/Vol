import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeSellOrder, type SellDeps } from '../local-runner/us-seller';
import { OrderStore } from '../local-runner/order-store';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'us-seller-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type ExecRow = { ordNo: string; orgOrdNo: string; symbol: string; ordQty: number; execQty: number; unfilledQty: number; ordPrc: number; ordPtnCode: string; trxNm: string };
// 매도 row (ordPtnCode='01' 후보)
const srow = (o: Partial<ExecRow>): ExecRow => ({ ordNo: '900', orgOrdNo: '0', symbol: 'AAPL', ordQty: 4, execQty: 0, unfilledQty: 4, ordPrc: 110, ordPtnCode: '01', trxNm: '접수', ...o });
const execRes = (rows: ExecRow[] = [], queryOk = true) =>
  ({ queryOk, classification: (queryOk ? 'SUCCESS' : 'TRANSPORT_ERROR') as const, rspCd: queryOk ? '00000' : 'EXCEPTION', rspMsg: '', rows, hasEnvelope: true, diag: {} as any });

let clock = 1_000_000;
function sellHarness(opts: { placeRes?: any; placeThrows?: Error; afterRows?: ExecRow[]; onPlace?: () => void } = {}): SellDeps & { placeCalls: number } {
  let placed = false; let placeCalls = 0;
  const d: SellDeps = {
    place: async () => { placeCalls++; placed = true; opts.onPlace?.(); if (opts.placeThrows) throw opts.placeThrows; return opts.placeRes ?? { rspCd: '00000', rspMsg: 'ok', ordNo: '900', raw: {}, diag: {} as any }; },
    query: async () => placed ? execRes(opts.afterRows ?? []) : execRes([]),
    now: () => clock,
    log: () => {},
  };
  Object.defineProperty(d, 'placeCalls', { get: () => placeCalls });
  return d as SellDeps & { placeCalls: number };
}
const params = (orders: OrderStore, over: Partial<any> = {}) => ({ orders, exchcd: '82', symbol: 'AAPL', candleDatetime: '20260811100000', qty: 4, price: 110, etDate: '20260811', ...over });

describe('executeSellOrder — 전송/체결/안전장치', () => {
  beforeEach(() => { clock = 1_000_000; });

  it('보유 4주 SELL(qty=4) 전량체결 → placed-filled, pending 해소', async () => {
    const orders = new OrderStore('AAPL', dir);
    const r = await executeSellOrder(sellHarness({ afterRows: [srow({ execQty: 4, unfilledQty: 0 })] }), params(orders));
    expect(r.status).toBe('placed-filled');
    expect(r.execQty).toBe(4);
    expect(orders.hasPending()).toBe(false);
  });

  it('부분체결 → placed-partial, 잔여 pending 유지', async () => {
    const orders = new OrderStore('AAPL', dir);
    const r = await executeSellOrder(sellHarness({ afterRows: [srow({ execQty: 2, unfilledQty: 2 })] }), params(orders));
    expect(r.status).toBe('placed-partial');
    expect(r.execQty).toBe(2);
    expect(orders.pending.some(o => o.side === 'sell')).toBe(true);
  });

  it('미체결 → placed-pending, pending SELL 유지', async () => {
    const orders = new OrderStore('AAPL', dir);
    const r = await executeSellOrder(sellHarness({ afterRows: [srow({ execQty: 0, unfilledQty: 4 })] }), params(orders));
    expect(r.status).toBe('placed-pending');
    expect(orders.pending.some(o => o.side === 'sell')).toBe(true);
  });

  it('pending SELL 존재 → 동일종목 재매도 금지(place 미호출)', async () => {
    const orders = new OrderStore('AAPL', dir);
    orders.recordPlaced('sell', '20260811094500', '20260811', { ordNo: '800', symbol: 'AAPL', qty: 4, price: 111, placedAtMs: 1 });
    const h = sellHarness({});
    const r = await executeSellOrder(h, params(orders));
    expect(r.status).toBe('aborted'); expect(r.abortCode).toBe('PENDING_SELL');
    expect(h.placeCalls).toBe(0);
  });

  it('보유수량 0(qty=0) → NO_QTY, place 미호출', async () => {
    const orders = new OrderStore('AAPL', dir);
    const h = sellHarness({});
    const r = await executeSellOrder(h, params(orders, { qty: 0 }));
    expect(r.status).toBe('aborted'); expect(r.abortCode).toBe('NO_QTY');
    expect(h.placeCalls).toBe(0);
  });

  it('동일 candle 이미 매도(잠금) → 재POST 금지', async () => {
    const orders = new OrderStore('AAPL', dir);
    orders.lockCandle('20260811100000', 'sell');
    const h = sellHarness({});
    const r = await executeSellOrder(h, params(orders));
    expect(r.status).toBe('aborted'); expect(r.abortCode).toBe('DUPLICATE_CANDLE');
    expect(h.placeCalls).toBe(0);
  });

  it('SELL 응답 timeout(전송 예외) → candle 잠금 유지 → 재호출 시 재POST 금지', async () => {
    const orders = new OrderStore('AAPL', dir);
    const h1 = sellHarness({ placeThrows: new Error('socket timeout') });
    const r1 = await executeSellOrder(h1, params(orders));
    expect(r1.status).toBe('aborted'); expect(r1.abortCode).toBe('SEND_EXCEPTION');
    expect(orders.hasOrderedCandle('20260811100000', 'sell')).toBe(true);   // 전송직전 잠금 유지
    // 재시도 → 동일 candle 잠금으로 재전송 차단
    const h2 = sellHarness({});
    const r2 = await executeSellOrder(h2, params(orders));
    expect(r2.abortCode).toBe('DUPLICATE_CANDLE');
    expect(h2.placeCalls).toBe(0);
  });

  it('대사: 거래소 매도주문 > 로컬 → 미기록 매도 감지, 전송 금지', async () => {
    const orders = new OrderStore('AAPL', dir);
    // 주문전 대사 query 가 이미 거래소 매도 1건 반환(로컬 0)
    const d: SellDeps = { place: async () => ({ rspCd: '00000', rspMsg: '', ordNo: '900', raw: {}, diag: {} as any }), query: async () => execRes([srow({ ordNo: '777', execQty: 0 })]), now: () => clock, log: () => {} };
    let placeCalls = 0; const wrapped: SellDeps = { ...d, place: async (p) => { placeCalls++; return d.place(p); } };
    const r = await executeSellOrder(wrapped, params(orders));
    expect(r.status).toBe('aborted'); expect(r.abortCode).toBe('UNRECORDED_ORDER');
    expect(placeCalls).toBe(0);
  });

  it('대사 조회 실패(queryOk=false) → RECONCILIATION_FAILED(전송 금지)', async () => {
    const orders = new OrderStore('AAPL', dir);
    const d: SellDeps = { place: async () => ({ rspCd: '00000', rspMsg: '', ordNo: '900', raw: {}, diag: {} as any }), query: async () => execRes([], false), now: () => clock, log: () => {} };
    const r = await executeSellOrder(d, params(orders));
    expect(r.status).toBe('aborted'); expect(r.abortCode).toBe('RECONCILIATION_FAILED');
  });

  it('매도 거부(성공코드 아님 + OrdNo 없음) → aborted, candle 잠금 유지', async () => {
    const orders = new OrderStore('AAPL', dir);
    const r = await executeSellOrder(sellHarness({ placeRes: { rspCd: '08085', rspMsg: '거부', ordNo: null, raw: {}, diag: {} as any } }), params(orders));
    expect(r.status).toBe('aborted'); expect(r.abortCode).toBe('ORDER_REJECTED');
    expect(orders.hasOrderedCandle('20260811100000', 'sell')).toBe(true);
  });

  it('매도 TR 미확인(place 가 미확인 예외) → POST_UNCONFIRMED 하드차단', async () => {
    const orders = new OrderStore('AAPL', dir);
    const r = await executeSellOrder(sellHarness({ placeThrows: new Error('COSAT00301 매도 OrdPtnCode 공식 미확인 — SELL POST 보류') }), params(orders));
    expect(r.status).toBe('aborted'); expect(r.abortCode).toBe('POST_UNCONFIRMED');
  });
});
