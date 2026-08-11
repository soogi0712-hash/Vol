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
const exec = (o: Partial<any> = {}) => ({ ok: true, rspCd: '00000', rspMsg: '', buyOrdQty: 0, buyExecQty: 0, sellOrdQty: 0, sellExecQty: 0, ...o });
function deps(over: Partial<KRTraderDeps> = {}): KRTraderDeps {
  return {
    place: async () => ({ rspCd: '00000', rspMsg: 'ok', ordNo: '32004', raw: {}, diag: {} as any }),
    queryExec: async () => exec(),
    cancel: async () => ({ rspCd: '00156', rspMsg: '취소접수', ordNo: '84006', raw: {}, diag: {} as any }),
    cashOrderable: async () => ({ ok: true, cash: 1_000_000_000 }),
    now: () => clock,
    log: () => {},
    ...over,
  };
}
const BIG = 10 * 60_000;   // 큰 타임아웃(취소 미발생)

// 실계정 흐름 모사: 전송 전 대사 queryExec 는 buyOrdQty=0, 전송 후 체결조회는 afterExec.
function buyHarness(opts: { placeRes?: any; afterExec?: any; cash?: { ok: boolean; cash: number }; onPlace?: () => void } = {}): KRTraderDeps & { placeCalls: number } {
  let placed = false; let placeCalls = 0;
  const d = deps({
    place: async () => { placeCalls++; placed = true; opts.onPlace?.(); return opts.placeRes ?? { rspCd: '00040', rspMsg: '매수 주문이 완료되었습니다.', ordNo: '32004', raw: {}, diag: {} as any }; },
    queryExec: async () => placed ? (opts.afterExec ?? exec({ buyOrdQty: 1, buyExecQty: 1 })) : exec({ buyOrdQty: 0, buyExecQty: 0 }),
    cashOrderable: async () => opts.cash ?? { ok: true, cash: 1_000_000_000 },
  });
  Object.defineProperty(d, 'placeCalls', { get: () => placeCalls });
  return d as KRTraderDeps & { placeCalls: number };
}
const params = (orders: OrderStore, over: Partial<any> = {}) => ({ orders, shcode: '005930', candleDatetime: '202608071500', qty: 1, price: 70000, krDate: '20260807', mbrNo: 'NXT', dailyMaxBuys: 1, ...over });

describe('executeKRBuyOrder — 전송/체결/부분/미체결', () => {
  beforeEach(() => { clock = 1_000_000; });
  it('rsp_cd=00040(매수 완료) + OrdNo → 성공(placed-filled), 오판 아님', async () => {
    const orders = new OrderStore('KR_005930', dir);
    const r = await executeKRBuyOrder(buyHarness({ placeRes: { rspCd: '00040', rspMsg: '매수 주문이 완료되었습니다.', ordNo: '32004', raw: {}, diag: {} as any }, afterExec: exec({ buyOrdQty: 1, buyExecQty: 1 }) }), params(orders));
    expect(r.status).toBe('placed-filled');
    expect(r.ordNo).toBe('32004');
    expect(orders.buyCountToday('20260807')).toBe(1);
  });
  it('부분 체결 → placed-partial, pending 유지', async () => {
    const orders = new OrderStore('KR_005930', dir);
    const r = await executeKRBuyOrder(buyHarness({ afterExec: exec({ buyOrdQty: 2, buyExecQty: 1 }) }), params(orders, { qty: 2 }));
    expect(r.status).toBe('placed-partial');
    expect(r.execQty).toBe(1);
    expect(orders.hasPending()).toBe(true);
  });
  it('미체결 → placed-pending, 주문번호 저장', async () => {
    const orders = new OrderStore('KR_005930', dir);
    const r = await executeKRBuyOrder(buyHarness({ afterExec: exec({ buyOrdQty: 1, buyExecQty: 0 }) }), params(orders));
    expect(r.status).toBe('placed-pending');
    expect(orders.pending[0].ordNo).toBe('32004');
  });
  it('원문 rsp_cd/rsp_msg 저장(대사+현금+주문+체결조회)', async () => {
    const orders = new OrderStore('KR_005930', dir);
    await executeKRBuyOrder(buyHarness({}), params(orders));
    expect(orders.responses.map(a => a.tr)).toEqual(expect.arrayContaining(['CSPAQ13700', 'CSPAQ12200', 'CSPAT00601']));
  });
});

// ─── 이번 SK하이닉스 3중 체결 버그 재현/방지 ───
describe('SK하이닉스 3중 체결 버그 재현·방지', () => {
  beforeEach(() => { clock = 1_000_000; });
  it('00040 을 실패로 오판하지 않는다 — 같은 candle 재호출 시 place 1회만', async () => {
    const orders = new OrderStore('A000660', dir);
    const h = buyHarness({ placeRes: { rspCd: '00040', rspMsg: '매수 주문이 완료되었습니다.', ordNo: '55001', raw: {}, diag: {} as any }, afterExec: exec({ buyOrdQty: 1, buyExecQty: 1 }) });
    const p = params(orders, { shcode: '000660', candleDatetime: '202608071015' });
    // 같은 15분봉에서 3회 시도(러너가 3틱 도는 상황 재현)
    const r1 = await executeKRBuyOrder(h, p);
    const r2 = await executeKRBuyOrder(h, p);
    const r3 = await executeKRBuyOrder(h, p);
    expect(r1.status).toBe('placed-filled');
    expect(r2.status).toBe('aborted');            // 한도/잠금 어느 쪽이든 재주문 차단
    expect(r3.status).toBe('aborted');
    expect(h.placeCalls).toBe(1);                 // ★ 실주문 1회만(3중 체결 방지)
    expect(orders.buyCountToday('20260807')).toBe(1);
  });
  it('candle lock 은 전송 직전 기록 — 전송 예외가 나도 재주문 금지', async () => {
    const orders = new OrderStore('A000660', dir);
    let calls = 0;
    const d = deps({
      place: async () => { calls++; throw new Error('ETIMEDOUT'); },   // 네트워크 예외(접수 여부 불명)
      queryExec: async () => exec({ buyOrdQty: 0, buyExecQty: 0 }),
    });
    const p = params(orders, { shcode: '000660', candleDatetime: '202608071015' });
    const r1 = await executeKRBuyOrder(d, p);
    const r2 = await executeKRBuyOrder(d, p);
    expect(r1.status).toBe('aborted'); expect(r1.reason).toMatch(/예외/);
    expect(orders.hasOrderedCandle('202608071015', 'buy')).toBe(true);   // ★ 전송 직전 잠금됨
    expect(r2.status).toBe('aborted'); expect(r2.reason).toMatch(/이미 주문|잠금/);
    expect(calls).toBe(1);                          // ★ 전송 1회만(재시도 없음, req7)
  });
  it('거래소 대사: 로컬 미기록 매수주문 존재 → 전송 금지(place 미호출)', async () => {
    const orders = new OrderStore('A000660', dir);
    let placed = false;
    const d = deps({
      place: async () => { placed = true; return { rspCd: '00040', rspMsg: '', ordNo: '1', raw: {}, diag: {} as any }; },
      queryExec: async () => exec({ buyOrdQty: 3, buyExecQty: 3 }),   // 거래소엔 이미 3건(로컬 0)
    });
    const r = await executeKRBuyOrder(d, params(orders, { shcode: '000660' }));
    expect(r.status).toBe('aborted');
    expect(r.reason).toMatch(/대사|거래소/);
    expect(r.abortCode).toBe('RECONCILIATION_FAILED');
    expect(placed).toBe(false);
  });
});

describe('현금 주문가능금액(MnyOrdAbleAmt) 가드', () => {
  beforeEach(() => { clock = 1_000_000; });
  it('price*qty > 현금가능 → CSPAT00601 절대 미호출', async () => {
    const orders = new OrderStore('KR_005930', dir);
    let placed = false;
    const h = buyHarness({ cash: { ok: true, cash: 50_000 }, onPlace: () => { placed = true; } });   // 현금 5만 < 필요 7만
    const r = await executeKRBuyOrder(h, params(orders, { price: 70000, qty: 1 }));
    expect(r.status).toBe('aborted');
    expect(r.reason).toMatch(/현금/);
    expect(r.abortCode).toBe('CASH_GATE');   // KR P0 진단: 사유 태깅
    expect(placed).toBe(false);
    expect(h.placeCalls).toBe(0);
  });
  it('현금가능 조회 실패 → 전송 금지(오판 방지)', async () => {
    const orders = new OrderStore('KR_005930', dir);
    const h = buyHarness({ cash: { ok: false, cash: 0 } });
    const r = await executeKRBuyOrder(h, params(orders));
    expect(r.status).toBe('aborted');
    expect(h.placeCalls).toBe(0);
  });
});

describe('executeKRBuyOrder — 방어적 abort', () => {
  beforeEach(() => { clock = 1_000_000; });
  it('일일 한도 초과 → aborted, place 미호출', async () => {
    const orders = new OrderStore('KR_005930', dir);
    orders.recordPlaced('buy', '202608071445', '20260807', { ordNo: '1', symbol: '005930', qty: 1, price: 70000, placedAtMs: 1 });
    const h = buyHarness({});
    const r = await executeKRBuyOrder(h, params(orders));
    expect(r.status).toBe('aborted'); expect(h.placeCalls).toBe(0);
    expect(r.abortCode).toBe('DAILY_LIMIT');
  });
  it('미체결 존재 → aborted', async () => {
    const orders = new OrderStore('KR_005930', dir);
    orders.recordPlaced('buy', '202608061500', '20260806', { ordNo: '9', symbol: '005930', qty: 1, price: 70000, placedAtMs: 1 });
    const r = await executeKRBuyOrder(buyHarness({}), params(orders));
    expect(r.status).toBe('aborted'); expect(r.reason).toMatch(/미체결/);
    expect(r.abortCode).toBe('PENDING');
  });
  it('주문 거부(성공코드 아님 + OrdNo 없음) → aborted, candle 잠금 유지, 재주문 없음', async () => {
    const orders = new OrderStore('KR_005930', dir);
    const h = buyHarness({ placeRes: { rspCd: '08085', rspMsg: '주문거부', ordNo: null, raw: {}, diag: {} as any } });
    const r = await executeKRBuyOrder(h, params(orders));
    expect(r.status).toBe('aborted');
    expect(r.abortCode).toBe('ORDER_REJECTED');
    expect(orders.responses.some(a => a.rspCd === '08085')).toBe(true);
    expect(orders.hasPending()).toBe(false);
    expect(orders.hasOrderedCandle('202608071500', 'buy')).toBe(true);   // 잠금 유지 → 재주문 없음
  });
});

describe('reconcileKRPending — 재확인 + 타임아웃 취소', () => {
  beforeEach(() => { clock = 1_000_000; });
  const pend = (qty = 1) => { const s = new OrderStore('KR_005930', dir); s.recordPlaced('buy', '202608071500', '20260807', { ordNo: '32004', symbol: '005930', qty, price: 70000, placedAtMs: 1_000_000 }); return s; };

  it('재시작(load) 후 pending 복원 → 전량체결 확인 시 해소', async () => {
    const s1 = pend(1); s1.flush();
    const s2 = new OrderStore('KR_005930', dir); s2.load();
    expect(s2.hasPending()).toBe(true);   // 재시작 복원(req 12)
    const rec = await reconcileKRPending(deps({ queryExec: async () => exec({ buyOrdQty: 1, buyExecQty: 1 }) }), { orders: s2, shcode: '005930', krDate: '20260807', timeoutMs: BIG });
    expect(rec[0].status).toBe('filled');
    expect(s2.hasPending()).toBe(false);
  });
  it('타임아웃 전 미체결 → pending 유지(취소 안 함)', async () => {
    const s = pend(1);
    clock = 1_000_000 + 30_000;
    let cancelled = false;
    const rec = await reconcileKRPending(deps({ queryExec: async () => exec({ buyOrdQty: 1, buyExecQty: 0 }), cancel: async () => { cancelled = true; return { rspCd: '00156', rspMsg: '', ordNo: '1', raw: {}, diag: {} as any }; } }), { orders: s, shcode: '005930', krDate: '20260807', timeoutMs: 60_000 });
    expect(rec[0].status).toBe('pending');
    expect(cancelled).toBe(false);
    expect(s.hasPending()).toBe(true);
  });
  it('타임아웃 경과 미체결 → CSPAT00801 취소 접수(00156) → cancelled, 해소', async () => {
    const s = pend(1);
    clock = 1_000_000 + 121_000;
    const rec = await reconcileKRPending(deps({ queryExec: async () => exec({ buyOrdQty: 1, buyExecQty: 0 }), cancel: async () => ({ rspCd: '00156', rspMsg: '취소접수', ordNo: '84006', raw: {}, diag: {} as any }) }), { orders: s, shcode: '005930', krDate: '20260807', timeoutMs: 120_000 });
    expect(rec[0].status).toBe('cancelled');
    expect(s.hasPending()).toBe(false);   // 취소 접수 → 다음 주문 허용
    expect(s.responses.some(a => a.tr === 'CSPAT00801' && a.rspCd === '00156')).toBe(true);
  });
  it('타임아웃 취소 거부 → cancel-failed, pending 유지(다음 주문 금지)', async () => {
    const s = pend(1);
    clock = 1_000_000 + 121_000;
    const rec = await reconcileKRPending(deps({ queryExec: async () => exec({ buyOrdQty: 1, buyExecQty: 0 }), cancel: async () => ({ rspCd: '08085', rspMsg: '취소불가', ordNo: null, raw: {}, diag: {} as any }) }), { orders: s, shcode: '005930', krDate: '20260807', timeoutMs: 120_000 });
    expect(rec[0].status).toBe('cancel-failed');
    expect(s.hasPending()).toBe(true);
  });
  it('부분체결 + 타임아웃 → 잔량 취소', async () => {
    const s = pend(2);
    clock = 1_000_000 + 121_000;
    let cancelQty = -1;
    const rec = await reconcileKRPending(deps({ queryExec: async () => exec({ buyOrdQty: 2, buyExecQty: 1 }), cancel: async (p) => { cancelQty = p.qty; return { rspCd: '00156', rspMsg: '', ordNo: '84006', raw: {}, diag: {} as any }; } }), { orders: s, shcode: '005930', krDate: '20260807', timeoutMs: 120_000 });
    expect(rec[0].status).toBe('cancelled');
    expect(cancelQty).toBe(1);   // 잔량 1주 취소
  });
  it('체결조회 실패 → query-failed, pending 유지(오판 금지)', async () => {
    const s = pend(1);
    const rec = await reconcileKRPending(deps({ queryExec: async () => exec({ ok: false, rspCd: 'ERR' }) }), { orders: s, shcode: '005930', krDate: '20260807', timeoutMs: BIG });
    expect(rec[0].status).toBe('query-failed');
    expect(s.hasPending()).toBe(true);
  });
});
