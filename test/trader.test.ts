import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeBuyOrder, reconcilePending, type TraderDeps } from '../local-runner/trader';
import { OrderStore, type RespAudit } from '../local-runner/order-store';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'trader-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type ExecRow = { ordNo: string; orgOrdNo: string; symbol: string; ordQty: number; execQty: number; unfilledQty: number; ordPrc: number; ordPtnCode: string; trxNm: string };
const row = (o: Partial<ExecRow>): ExecRow => ({ ordNo: '141', orgOrdNo: '0', symbol: 'AAPL', ordQty: 1, execQty: 0, unfilledQty: 1, ordPrc: 100, ordPtnCode: '02', trxNm: '접수', ...o });

let clock = 1_000_000;
function deps(over: Partial<TraderDeps> = {}): TraderDeps {
  return {
    place: async () => ({ rspCd: '00000', rspMsg: 'ok', ordNo: '141', raw: {}, diag: {} as any }),
    query: async () => ({ rspCd: '00000', rspMsg: 'ok', rows: [], diag: {} as any }),
    cancel: async () => ({ rspCd: '00000', rspMsg: 'ok' }),
    now: () => clock,
    log: () => {},
    ...over,
  };
}
const buyParams = (orders: OrderStore) => ({ orders, exchcd: '82', symbol: 'AAPL', candleDatetime: '20260706093000', qty: 1, price: 100, etDate: '20260706', dailyMaxBuys: 1 });

describe('executeBuyOrder — 전송/체결/미체결', () => {
  beforeEach(() => { clock = 1_000_000; });
  it('전량 체결 → placed-filled, pending 해소, 일일카운트 반영', async () => {
    const orders = new OrderStore('AAPL', dir);
    const d = deps({ query: async () => ({ rspCd: '00000', rspMsg: '', rows: [row({ execQty: 1, unfilledQty: 0 })], diag: {} as any }) });
    const r = await executeBuyOrder(d, buyParams(orders));
    expect(r.status).toBe('placed-filled');
    expect(orders.hasPending()).toBe(false);
    expect(orders.buyCountToday('20260706')).toBe(1);
  });
  it('미체결 → placed-pending, pending 유지(취소는 reconcile 이 담당)', async () => {
    const orders = new OrderStore('AAPL', dir);
    const d = deps({ query: async () => ({ rspCd: '00000', rspMsg: '', rows: [row({ execQty: 0, unfilledQty: 1 })], diag: {} as any }) });
    const r = await executeBuyOrder(d, buyParams(orders));
    expect(r.status).toBe('placed-pending');
    expect(orders.hasPending()).toBe(true);
    expect(orders.pending[0].placedAtMs).toBe(1_000_000);   // 주문시각 저장(타임아웃 판정용)
  });
  it('응답 ordNo 없으면 체결내역조회로 매칭', async () => {
    const orders = new OrderStore('AAPL', dir);
    const d = deps({
      place: async () => ({ rspCd: '00000', rspMsg: '', ordNo: null, raw: {}, diag: {} as any }),
      query: async () => ({ rspCd: '00000', rspMsg: '', rows: [row({ ordNo: '999', execQty: 1, unfilledQty: 0 })], diag: {} as any }),
    });
    const r = await executeBuyOrder(d, buyParams(orders));
    expect(r.ordNo).toBe('999');
    expect(r.status).toBe('placed-filled');
  });
  it('원문 rsp_cd/rsp_msg 저장(req18)', async () => {
    const orders = new OrderStore('AAPL', dir);
    await executeBuyOrder(deps(), buyParams(orders));
    const trs = orders.responses.map((a: RespAudit) => a.tr);
    expect(trs).toContain('COSAT00301');
    expect(trs).toContain('COSAQ00102');
  });
});

describe('executeBuyOrder — 방어적 abort(자동 재주문 금지 포함)', () => {
  beforeEach(() => { clock = 1_000_000; });
  it('일일 한도 초과 → aborted, place 미호출', async () => {
    const orders = new OrderStore('AAPL', dir);
    orders.recordPlaced('buy', '20260706091500', '20260706', { ordNo: '1', symbol: 'AAPL', qty: 1, price: 100, placedAtMs: 1 });
    let placed = false;
    const r = await executeBuyOrder(deps({ place: async () => { placed = true; return { rspCd: '00000', rspMsg: '', ordNo: '2', raw: {}, diag: {} as any }; } }), buyParams(orders));
    expect(r.status).toBe('aborted');
    expect(placed).toBe(false);
  });
  it('동일 확정봉 중복 → aborted', async () => {
    const orders = new OrderStore('AAPL', dir);
    orders.recordPlaced('buy', '20260706093000', '20260705', { ordNo: '1', symbol: 'AAPL', qty: 1, price: 100, placedAtMs: 1 });
    orders.resolvePending('1');
    const r = await executeBuyOrder(deps(), buyParams(orders));
    expect(r.status).toBe('aborted');
    expect(r.reason).toMatch(/중복/);
  });
  it('미체결 존재 → aborted', async () => {
    const orders = new OrderStore('AAPL', dir);
    orders.recordPlaced('buy', '20260705093000', '20260705', { ordNo: '9', symbol: 'AAPL', qty: 1, price: 100, placedAtMs: 1 });
    const r = await executeBuyOrder(deps(), buyParams(orders));
    expect(r.status).toBe('aborted');
    expect(r.reason).toMatch(/미체결/);
  });
  it('주문 거부(rsp_cd!=00000) → aborted, 원문 저장, 자동 재주문 안 함', async () => {
    const orders = new OrderStore('AAPL', dir);
    const r = await executeBuyOrder(deps({ place: async () => ({ rspCd: '40510', rspMsg: '주문거부', ordNo: null, raw: {}, diag: {} as any }) }), buyParams(orders));
    expect(r.status).toBe('aborted');
    expect(orders.responses.some(a => a.rspCd === '40510')).toBe(true);
    expect(orders.hasPending()).toBe(false);
  });
});

describe('reconcilePending — 타임아웃 취소(BUY→PENDING→CANCELLED 모의 흐름)', () => {
  beforeEach(() => { clock = 1_000_000; });
  it('전체 흐름: 매수→미체결(pending)→타임아웃→취소 완료', async () => {
    const orders = new OrderStore('AAPL', dir);
    // ① 매수 → 미체결
    const buy = await executeBuyOrder(deps({ query: async () => ({ rspCd: '00000', rspMsg: '', rows: [row({ execQty: 0, unfilledQty: 1 })], diag: {} as any }) }), buyParams(orders));
    expect(buy.status).toBe('placed-pending');
    expect(orders.hasPending()).toBe(true);

    // ② 타임아웃 전 → waiting (취소 안 함)
    clock = 1_000_000 + 30_000;
    let cancelled = false;
    const early = await reconcilePending(
      deps({ query: async () => ({ rspCd: '00000', rspMsg: '', rows: [row({ execQty: 0, unfilledQty: 1 })], diag: {} as any }), cancel: async () => { cancelled = true; return { rspCd: '00000', rspMsg: '' }; } }),
      { orders, exchcd: '82', ordDate: '20260706', timeoutMs: 60_000 },
    );
    expect(early[0].status).toBe('waiting');
    expect(cancelled).toBe(false);
    expect(orders.hasPending()).toBe(true);

    // ③ 타임아웃 경과 → 취소 완료
    clock = 1_000_000 + 61_000;
    const late = await reconcilePending(
      deps({ query: async () => ({ rspCd: '00000', rspMsg: '', rows: [row({ execQty: 0, unfilledQty: 1 })], diag: {} as any }), cancel: async () => ({ rspCd: '00000', rspMsg: '취소완료' }) }),
      { orders, exchcd: '82', ordDate: '20260706', timeoutMs: 60_000 },
    );
    expect(late[0].status).toBe('cancelled');
    expect(orders.hasPending()).toBe(false);   // 취소 성공 → pending 해소(다음 주문 가능)
    expect(orders.responses.some(a => a.tr === 'COSAT00311' && a.rspCd === '00000')).toBe(true);
  });

  it('미체결이 그 사이 체결되면 filled 로 해소(취소 안 함)', async () => {
    const orders = new OrderStore('AAPL', dir);
    orders.recordPlaced('buy', '20260706093000', '20260706', { ordNo: '141', symbol: 'AAPL', qty: 1, price: 100, placedAtMs: 1_000_000 });
    orders.flush();
    clock = 1_000_000 + 61_000;
    let cancelled = false;
    const r = await reconcilePending(
      deps({ query: async () => ({ rspCd: '00000', rspMsg: '', rows: [row({ execQty: 1, unfilledQty: 0 })], diag: {} as any }), cancel: async () => { cancelled = true; return { rspCd: '00000', rspMsg: '' }; } }),
      { orders, exchcd: '82', ordDate: '20260706', timeoutMs: 60_000 },
    );
    expect(r[0].status).toBe('filled');
    expect(cancelled).toBe(false);
    expect(orders.hasPending()).toBe(false);
  });

  it('취소 실패(취소 TR 미확인 등) → cancel-failed, pending 유지(다음 주문 금지)', async () => {
    const orders = new OrderStore('AAPL', dir);
    orders.recordPlaced('buy', '20260706093000', '20260706', { ordNo: '141', symbol: 'AAPL', qty: 1, price: 100, placedAtMs: 1_000_000 });
    orders.flush();
    clock = 1_000_000 + 61_000;
    const r = await reconcilePending(
      deps({ query: async () => ({ rspCd: '00000', rspMsg: '', rows: [row({ execQty: 0, unfilledQty: 1 })], diag: {} as any }), cancel: async () => { throw new Error('COSAT00311 공식 필드 미확인'); } }),
      { orders, exchcd: '82', ordDate: '20260706', timeoutMs: 60_000 },
    );
    expect(r[0].status).toBe('cancel-failed');
    expect(orders.hasPending()).toBe(true);   // 취소 성공 확인 전 → 유지(req15)
  });
});
