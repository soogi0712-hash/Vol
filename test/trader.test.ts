import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeBuyOrder, type TraderDeps } from '../local-runner/trader';
import { OrderStore } from '../local-runner/order-store';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'trader-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const logs: string[] = [];
function deps(over: Partial<TraderDeps> = {}): TraderDeps {
  return {
    place: async () => ({ rspCd: '00000', rspMsg: 'ok', ordNo: '141', raw: {}, diag: {} as any }),
    query: async () => ({ rspCd: '00000', rspMsg: 'ok', rows: [], diag: {} as any }),
    cancel: async () => ({ rspCd: '00000' }),
    log: (m) => { logs.push(m); },
    ...over,
  };
}
const params = (orders: OrderStore) => ({ orders, exchcd: '82', symbol: 'AAPL', candleDatetime: '20260706093000', qty: 1, price: 100, etDate: '20260706' });

describe('executeBuyOrder — 체결/미체결/취소', () => {
  it('전량 체결 → placed-filled, pending 해소, 저장', async () => {
    const orders = new OrderStore('AAPL', dir);
    const d = deps({ query: async () => ({ rspCd: '00000', rspMsg: '', rows: [{ ordNo: '141', orgOrdNo: '0', symbol: 'AAPL', ordQty: 1, execQty: 1, unfilledQty: 0, ordPrc: 100, ordPtnCode: '02', trxNm: '체결' }], diag: {} as any }) });
    const r = await executeBuyOrder(d, params(orders));
    expect(r.status).toBe('placed-filled');
    expect(r.ordNo).toBe('141');
    expect(orders.hasPending()).toBe(false);
    expect(orders.buyCountToday('20260706')).toBe(1);   // 일일카운트 반영
  });

  it('미체결 → 취소 성공 → placed-unfilled-cancelled', async () => {
    const orders = new OrderStore('AAPL', dir);
    let cancelled = false;
    const d = deps({
      query: async () => ({ rspCd: '00000', rspMsg: '', rows: [{ ordNo: '141', orgOrdNo: '0', symbol: 'AAPL', ordQty: 1, execQty: 0, unfilledQty: 1, ordPrc: 100, ordPtnCode: '02', trxNm: '접수' }], diag: {} as any }),
      cancel: async () => { cancelled = true; return { rspCd: '00000' }; },
    });
    const r = await executeBuyOrder(d, params(orders));
    expect(cancelled).toBe(true);
    expect(r.status).toBe('placed-unfilled-cancelled');
    expect(orders.hasPending()).toBe(false);
  });

  it('취소 실패 → placed-unfilled-pending, pending 유지', async () => {
    const orders = new OrderStore('AAPL', dir);
    const d = deps({
      query: async () => ({ rspCd: '00000', rspMsg: '', rows: [{ ordNo: '141', orgOrdNo: '0', symbol: 'AAPL', ordQty: 1, execQty: 0, unfilledQty: 1, ordPrc: 100, ordPtnCode: '02', trxNm: '접수' }], diag: {} as any }),
      cancel: async () => { throw new Error('COSAT00311 미확인'); },
    });
    const r = await executeBuyOrder(d, params(orders));
    expect(r.status).toBe('placed-unfilled-pending');
    expect(orders.hasPending()).toBe(true);   // 취소 실패 → 수동확인용 유지
  });

  it('주문 응답에 ordNo 없으면 체결내역조회로 매칭', async () => {
    const orders = new OrderStore('AAPL', dir);
    const d = deps({
      place: async () => ({ rspCd: '00000', rspMsg: '', ordNo: null, raw: {}, diag: {} as any }),
      query: async () => ({ rspCd: '00000', rspMsg: '', rows: [{ ordNo: '999', orgOrdNo: '0', symbol: 'AAPL', ordQty: 1, execQty: 1, unfilledQty: 0, ordPrc: 100, ordPtnCode: '02', trxNm: '체결' }], diag: {} as any }),
    });
    const r = await executeBuyOrder(d, params(orders));
    expect(r.ordNo).toBe('999');
    expect(r.status).toBe('placed-filled');
  });
});

describe('executeBuyOrder — 방어적 재검증(주문 전 abort)', () => {
  it('일일 한도 초과 → aborted, place 미호출', async () => {
    const orders = new OrderStore('AAPL', dir);
    orders.recordPlaced('buy', '20260706091500', '20260706', { ordNo: '1', symbol: 'AAPL', qty: 1, price: 100 });
    let placed = false;
    const r = await executeBuyOrder(deps({ place: async () => { placed = true; return { rspCd: '00000', rspMsg: '', ordNo: '2', raw: {}, diag: {} as any }; } }), params(orders));
    expect(r.status).toBe('aborted');
    expect(placed).toBe(false);
  });
  it('동일 확정봉 중복 → aborted', async () => {
    const orders = new OrderStore('AAPL', dir);
    // 어제 날짜로 동일 확정봉 주문 기록(오늘 일일한도는 살아있게) → 중복주문 경로만 격리
    orders.recordPlaced('buy', '20260706093000', '20260705', { ordNo: '1', symbol: 'AAPL', qty: 1, price: 100 });
    orders.resolvePending('1');   // pending 은 비우되, 동일봉 기록은 남음
    const r = await executeBuyOrder(deps(), params(orders));   // params etDate=20260706
    expect(r.status).toBe('aborted');
    expect(r.reason).toMatch(/중복/);
  });
  it('미체결 존재 → aborted', async () => {
    const orders = new OrderStore('AAPL', dir);
    orders.recordPlaced('buy', '20260705093000', '20260705', { ordNo: '9', symbol: 'AAPL', qty: 1, price: 100 });
    const r = await executeBuyOrder(deps(), params(orders));
    expect(r.status).toBe('aborted');
    expect(r.reason).toMatch(/미체결/);
  });
  it('주문 거부(rsp_cd!=00000) → aborted', async () => {
    const orders = new OrderStore('AAPL', dir);
    const r = await executeBuyOrder(deps({ place: async () => ({ rspCd: '40510', rspMsg: '주문거부', ordNo: null, raw: {}, diag: {} as any }) }), params(orders));
    expect(r.status).toBe('aborted');
    expect(r.reason).toMatch(/거부/);
  });
});
