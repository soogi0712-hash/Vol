import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeBuyOrder, reconcilePending, linkTrackedToOrders, type TraderDeps } from '../local-runner/trader';
import { OrderStore, type RespAudit } from '../local-runner/order-store';
import { applyOrderEvent, parseAccountEvent, type TrackedOrder } from '../local-runner/order-events';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'trader-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type ExecRow = { ordNo: string; orgOrdNo: string; symbol: string; ordQty: number; execQty: number; unfilledQty: number; ordPrc: number; ordPtnCode: string; trxNm: string };
const row = (o: Partial<ExecRow>): ExecRow => ({ ordNo: '141', orgOrdNo: '0', symbol: 'AAPL', ordQty: 1, execQty: 0, unfilledQty: 1, ordPrc: 100, ordPtnCode: '02', trxNm: '접수', ...o });
const execRes = (rows: ExecRow[] = [], rspCd = '00000', queryOk = true) =>
  ({ queryOk, classification: (queryOk ? 'SUCCESS' : 'TRANSPORT_ERROR') as const, rspCd, rspMsg: '', rows, hasEnvelope: true, diag: {} as any });

let clock = 1_000_000;
function deps(over: Partial<TraderDeps> = {}): TraderDeps {
  return {
    place: async () => ({ rspCd: '00000', rspMsg: 'ok', ordNo: '141', raw: {}, diag: {} as any }),
    query: async () => execRes([]),
    cancel: async () => ({ rspCd: '00000', rspMsg: 'ok' }),
    cashOrderable: async () => ({ ok: true, cash: 1_000_000_000 }),
    now: () => clock,
    log: () => {},
    ...over,
  };
}
const buyParams = (orders: OrderStore) => ({ orders, exchcd: '82', symbol: 'AAPL', candleDatetime: '20260706093000', qty: 1, price: 100, etDate: '20260706', dailyMaxBuys: 1 });

// 실계정 흐름 모사: 전송 전 대사 query 는 빈 rows(미기록 주문 없음), 전송 후 체결조회는 afterRows.
function usHarness(opts: { placeRes?: any; afterRows?: ExecRow[]; cash?: { ok: boolean; cash: number }; onPlace?: () => void } = {}): TraderDeps & { placeCalls: number } {
  let placed = false; let placeCalls = 0;
  const d = deps({
    place: async () => { placeCalls++; placed = true; opts.onPlace?.(); return opts.placeRes ?? { rspCd: '00000', rspMsg: 'ok', ordNo: '141', raw: {}, diag: {} as any }; },
    query: async () => placed ? execRes(opts.afterRows ?? []) : execRes([]),
    cashOrderable: async () => opts.cash ?? { ok: true, cash: 1_000_000_000 },
  });
  Object.defineProperty(d, 'placeCalls', { get: () => placeCalls });
  return d as TraderDeps & { placeCalls: number };
}

describe('executeBuyOrder — 전송/체결/미체결', () => {
  beforeEach(() => { clock = 1_000_000; });
  it('전량 체결 → placed-filled, pending 해소, 일일카운트 반영', async () => {
    const orders = new OrderStore('AAPL', dir);
    const r = await executeBuyOrder(usHarness({ afterRows: [row({ execQty: 1, unfilledQty: 0 })] }), buyParams(orders));
    expect(r.status).toBe('placed-filled');
    expect(orders.hasPending()).toBe(false);
    expect(orders.buyCountToday('20260706')).toBe(1);
  });
  it('미체결 → placed-pending, pending 유지(취소는 reconcile 이 담당)', async () => {
    const orders = new OrderStore('AAPL', dir);
    const r = await executeBuyOrder(usHarness({ afterRows: [row({ execQty: 0, unfilledQty: 1 })] }), buyParams(orders));
    expect(r.status).toBe('placed-pending');
    expect(orders.hasPending()).toBe(true);
    expect(orders.pending[0].placedAtMs).toBe(1_000_000);
  });
  it('응답 ordNo 없으면 체결내역조회로 매칭', async () => {
    const orders = new OrderStore('AAPL', dir);
    const r = await executeBuyOrder(usHarness({ placeRes: { rspCd: '00000', rspMsg: '', ordNo: null, raw: {}, diag: {} as any }, afterRows: [row({ ordNo: '999', execQty: 1, unfilledQty: 0 })] }), buyParams(orders));
    expect(r.ordNo).toBe('999');
    expect(r.status).toBe('placed-filled');
  });
  it('원문 rsp_cd/rsp_msg 저장(대사+현금+주문+체결)', async () => {
    const orders = new OrderStore('AAPL', dir);
    await executeBuyOrder(usHarness({}), buyParams(orders));
    const trs = orders.responses.map((a: RespAudit) => a.tr);
    expect(trs).toEqual(expect.arrayContaining(['COSAQ00102', 'COSOQ02701', 'COSAT00301']));
  });
});

// ─── KR 3중 체결 사고 방지 패턴을 US 에 이식·검증 ───
describe('US 주문 idempotency (KR 사고 패턴 이식)', () => {
  beforeEach(() => { clock = 1_000_000; });
  it('같은 candle BUY 3회 반복 → 실제 POST 1회만(req11)', async () => {
    const orders = new OrderStore('AAPL', dir);
    const h = usHarness({ afterRows: [row({ execQty: 1, unfilledQty: 0 })] });
    const r1 = await executeBuyOrder(h, buyParams(orders));
    const r2 = await executeBuyOrder(h, buyParams(orders));
    const r3 = await executeBuyOrder(h, buyParams(orders));
    expect(r1.status).toBe('placed-filled');
    expect(r2.status).toBe('aborted');
    expect(r3.status).toBe('aborted');
    expect(h.placeCalls).toBe(1);   // ★ POST 1회만
  });
  it('P0-9: 같은 candle BUY 신호 100회 반복돼도 실제 POST 1회만', async () => {
    const orders = new OrderStore('AAPL', dir);
    const h = usHarness({ afterRows: [row({ execQty: 1, unfilledQty: 0 })] });
    let filled = 0;
    for (let i = 0; i < 100; i++) { const r = await executeBuyOrder(h, buyParams(orders)); if (r.status === 'placed-filled') filled++; }
    expect(h.placeCalls).toBe(1);   // ★ 100회 반복 → POST 1회
    expect(filled).toBe(1);
    expect(orders.buyCountToday('20260706')).toBe(1);
  });
  it('전송 예외(timeout/500/parse) 후 candle 잠금 유지 → 재POST 0회(req2·12)', async () => {
    const orders = new OrderStore('AAPL', dir);
    let calls = 0;
    const d = deps({ place: async () => { calls++; throw new Error('ETIMEDOUT'); }, query: async () => execRes([]) });
    const r1 = await executeBuyOrder(d, buyParams(orders));
    const r2 = await executeBuyOrder(d, buyParams(orders));
    expect(r1.status).toBe('aborted'); expect(r1.reason).toMatch(/예외/);
    expect(orders.hasOrderedCandle('20260706093000', 'buy')).toBe(true);   // 전송 직전 잠금
    expect(r2.status).toBe('aborted');
    expect(calls).toBe(1);   // ★ 재POST 0회
  });
  it('OrdNo 있으면 성공(rsp_cd 미확인 코드여도) — 재주문 없음(req3·4)', async () => {
    const orders = new OrderStore('AAPL', dir);
    const r = await executeBuyOrder(usHarness({ placeRes: { rspCd: '99999', rspMsg: '?', ordNo: '141', raw: {}, diag: {} as any }, afterRows: [row({ execQty: 1, unfilledQty: 0 })] }), buyParams(orders));
    expect(r.status).toBe('placed-filled');
    expect(orders.buyCountToday('20260706')).toBe(1);
  });
  it('거래소 대사: 로컬 미기록 매수주문 존재 → 전송 금지(req9)', async () => {
    const orders = new OrderStore('AAPL', dir);
    let placed = false;
    const d = deps({ place: async () => { placed = true; return { rspCd: '00000', rspMsg: '', ordNo: '1', raw: {}, diag: {} as any }; }, query: async () => execRes([row({ ordNo: '900', execQty: 1, unfilledQty: 0, ordPtnCode: '02' })]) });
    const r = await executeBuyOrder(d, buyParams(orders));
    expect(r.status).toBe('aborted');
    expect(r.reason).toMatch(/대사|거래소/);
    expect(placed).toBe(false);
  });
  it('대사 조회 실패 → 신규 BUY 금지(req9)', async () => {
    const orders = new OrderStore('AAPL', dir);
    let placed = false;
    const d = deps({ place: async () => { placed = true; return { rspCd: '00000', rspMsg: '', ordNo: '1', raw: {}, diag: {} as any }; }, query: async () => { throw new Error('500'); } });
    const r = await executeBuyOrder(d, buyParams(orders));
    expect(r.status).toBe('aborted'); expect(placed).toBe(false);
  });
});

// ─── P0-27 issue1: reconciliation "조회 성공+0건" vs "조회 API 실패" 구분(req3·4·7·8) ───
describe('P0-27 reconciliation 구분 — 0건 정상 vs API 실패', () => {
  beforeEach(() => { clock = 1_000_000; });

  it('조회 API 성공 + 주문 0건 → POST 허용(오늘 주문 없던 계좌, 정상)', async () => {
    const orders = new OrderStore('AAPL', dir);
    // 대사(전송 전) queryOk=true rows=[] → 정상. 전송 후 체결조회는 filled.
    let placed = false;
    const d = deps({
      place: async () => { placed = true; return { rspCd: '00000', rspMsg: 'ok', ordNo: '141', raw: {}, diag: {} as any }; },
      query: async () => placed ? execRes([row({ execQty: 1, unfilledQty: 0 })]) : execRes([]),   // queryOk:true 기본
    });
    const r = await executeBuyOrder(d, buyParams(orders));
    expect(r.status).toBe('placed-filled');   // ★ 0건이라고 차단되지 않음
    expect(placed).toBe(true);
  });

  it('조회 API 실패(TRANSPORT_ERROR) → POST 차단 + abortCode=RECONCILIATION_FAILED', async () => {
    const orders = new OrderStore('AAPL', dir);
    let placed = false;
    const d = deps({
      place: async () => { placed = true; return { rspCd: '00000', rspMsg: 'ok', ordNo: '141', raw: {}, diag: {} as any }; },
      query: async () => ({ queryOk: false, classification: 'TRANSPORT_ERROR' as const, rspCd: 'ERR(NETWORK)', rspMsg: 'timeout', rows: [], hasEnvelope: false, diag: {} as any, kind: 'NETWORK' as const }),
    });
    const r = await executeBuyOrder(d, buyParams(orders));
    expect(r.status).toBe('aborted');
    expect(r.abortCode).toBe('RECONCILIATION_FAILED');
    expect(placed).toBe(false);   // ★ 안전차단(전송 금지)
  });
  it('P0-27a: unknown 업무코드(BUSINESS_ERROR) → POST 차단(fail-closed, 0건 오인 금지)', async () => {
    const orders = new OrderStore('AAPL', dir);
    let placed = false;
    const msgs: string[] = [];
    const d = deps({
      place: async () => { placed = true; return { rspCd: '00000', rspMsg: 'ok', ordNo: '141', raw: {}, diag: {} as any }; },
      query: async () => ({ queryOk: false, classification: 'BUSINESS_ERROR' as const, rspCd: '77777', rspMsg: '알수없는 업무오류', rows: [], hasEnvelope: true, diag: {} as any }),
      log: (m) => msgs.push(m),
    });
    const r = await executeBuyOrder(d, buyParams(orders));
    expect(r.status).toBe('aborted');
    expect(r.abortCode).toBe('RECONCILIATION_FAILED');
    expect(placed).toBe(false);   // ★ unknown 코드를 0건으로 오인해 통과시키지 않음
    expect(msgs.some(m => /classification=BUSINESS_ERROR/.test(m))).toBe(true);
  });
  it('P0-27a: 실측 empty code(EMPTY) + rows0 → POST 허용', async () => {
    const orders = new OrderStore('AAPL', dir);
    let placed = false;
    const d = deps({
      place: async () => { placed = true; return { rspCd: '00000', rspMsg: 'ok', ordNo: '141', raw: {}, diag: {} as any }; },
      query: async () => placed
        ? { queryOk: true, classification: 'SUCCESS' as const, rspCd: '00000', rspMsg: '', rows: [row({ execQty: 1, unfilledQty: 0 })], hasEnvelope: true, diag: {} as any }
        : { queryOk: true, classification: 'EMPTY' as const, rspCd: '00600', rspMsg: '조회할 자료가 없습니다.', rows: [], hasEnvelope: true, diag: {} as any },
    });
    const r = await executeBuyOrder(d, buyParams(orders));
    expect(r.status).toBe('placed-filled');   // ★ EMPTY(정상 0건)는 허용
    expect(placed).toBe(true);
  });

  it('조회 예외(throw) → POST 차단 + abortCode=RECONCILIATION_FAILED', async () => {
    const orders = new OrderStore('AAPL', dir);
    let placed = false;
    const d = deps({ place: async () => { placed = true; return { rspCd: '00000', rspMsg: '', ordNo: '1', raw: {}, diag: {} as any }; }, query: async () => { throw new Error('ETIMEDOUT'); } });
    const r = await executeBuyOrder(d, buyParams(orders));
    expect(r.status).toBe('aborted');
    expect(r.abortCode).toBe('RECONCILIATION_FAILED');
    expect(placed).toBe(false);
  });

  it('pending 주문 존재 → POST 차단 + abortCode=PENDING', async () => {
    const orders = new OrderStore('AAPL', dir);
    orders.recordPlaced('buy', '20260705093000', '20260705', { ordNo: '9', symbol: 'AAPL', qty: 1, price: 100, placedAtMs: 1 });
    const r = await executeBuyOrder(usHarness({}), buyParams(orders));
    expect(r.status).toBe('aborted');
    expect(r.abortCode).toBe('PENDING');
  });

  it('오늘 BUY 한도 사용 → POST 차단 + abortCode=DAILY_LIMIT', async () => {
    const orders = new OrderStore('AAPL', dir);
    orders.recordPlaced('buy', '20260706091500', '20260706', { ordNo: '1', symbol: 'AAPL', qty: 1, price: 100, placedAtMs: 1 });
    const h = usHarness({});
    const r = await executeBuyOrder(h, buyParams(orders));
    expect(r.status).toBe('aborted');
    expect(r.abortCode).toBe('DAILY_LIMIT');
    expect(h.placeCalls).toBe(0);
  });

  it('[US-RECON] 진단 로그가 queryOk/rsp_cd/order count/decision 을 출력', async () => {
    const orders = new OrderStore('AAPL', dir);
    const msgs: string[] = [];
    const d = deps({ query: async () => execRes([]), log: (m) => msgs.push(m) });
    await executeBuyOrder(d, buyParams(orders));
    const recon = msgs.find(m => m.includes('[US-RECON'));
    expect(recon).toBeTruthy();
    expect(recon).toMatch(/queryOk=true/);
    expect(recon).toMatch(/decision=POST_ALLOWED/);
  });
});

describe('US 현금(USD) 주문가능 가드 (cash-only, req5·6·7)', () => {
  beforeEach(() => { clock = 1_000_000; });
  it('price*qty > 현금가능 → COSAT00301 미호출', async () => {
    const orders = new OrderStore('AAPL', dir);
    const h = usHarness({ cash: { ok: true, cash: 50 } });   // 현금 50 < 필요 100
    const r = await executeBuyOrder(h, buyParams(orders));
    expect(r.status).toBe('aborted'); expect(r.reason).toMatch(/현금/);
    expect(h.placeCalls).toBe(0);
  });
  it('현금 조회 실패 → 전송 금지', async () => {
    const orders = new OrderStore('AAPL', dir);
    const h = usHarness({ cash: { ok: false, cash: 0 } });
    const r = await executeBuyOrder(h, buyParams(orders));
    expect(r.status).toBe('aborted'); expect(h.placeCalls).toBe(0);
  });
});

describe('executeBuyOrder — 방어적 abort', () => {
  beforeEach(() => { clock = 1_000_000; });
  it('일일 한도 초과 → aborted, place 미호출', async () => {
    const orders = new OrderStore('AAPL', dir);
    orders.recordPlaced('buy', '20260706091500', '20260706', { ordNo: '1', symbol: 'AAPL', qty: 1, price: 100, placedAtMs: 1 });
    const h = usHarness({});
    const r = await executeBuyOrder(h, buyParams(orders));
    expect(r.status).toBe('aborted'); expect(h.placeCalls).toBe(0);
  });
  it('미체결 존재 → aborted', async () => {
    const orders = new OrderStore('AAPL', dir);
    orders.recordPlaced('buy', '20260705093000', '20260705', { ordNo: '9', symbol: 'AAPL', qty: 1, price: 100, placedAtMs: 1 });
    const r = await executeBuyOrder(usHarness({}), buyParams(orders));
    expect(r.status).toBe('aborted'); expect(r.reason).toMatch(/미체결/);
  });
  it('주문 거부(성공코드 아님 + OrdNo 없음) → aborted, candle 잠금 유지', async () => {
    const orders = new OrderStore('AAPL', dir);
    const h = usHarness({ placeRes: { rspCd: '40510', rspMsg: '주문거부', ordNo: null, raw: {}, diag: {} as any } });
    const r = await executeBuyOrder(h, buyParams(orders));
    expect(r.status).toBe('aborted');
    expect(orders.responses.some(a => a.rspCd === '40510')).toBe(true);
    expect(orders.hasPending()).toBe(false);
    expect(orders.hasOrderedCandle('20260706093000', 'buy')).toBe(true);   // 잠금 유지 → 재주문 없음
  });
});

describe('linkTrackedToOrders — AS 이벤트↔주문번호 연결(req10)', () => {
  const ev = (trCd: string, body: any) => parseAccountEvent(trCd, body)!;
  it('AS1 완전체결 이벤트가 주문번호로 pending 을 해소', async () => {
    const orders = new OrderStore('AAPL', dir);
    orders.recordPlaced('buy', '20260706093000', '20260706', { ordNo: '141', symbol: 'AAPL', qty: 1, price: 100, placedAtMs: 1 });
    orders.flush();
    const tracker = new Map<string, TrackedOrder>();
    applyOrderEvent(tracker, ev('AS0', { sOrdNo: '141', sOrgOrdNo: '0', sShtnIsuNo: 'AAPL', sOrdQty: '1', sOrdPrc: '100', sUnercQty: '1' }), 1);
    applyOrderEvent(tracker, ev('AS1', { sOrdNo: '141', sOrgOrdNo: '0', sExecNO: 'E1', sExecQty: '1', sUnercQty: '0' }), 2);   // FILLED
    const resolved = linkTrackedToOrders(tracker, orders);
    expect(resolved).toEqual(['141']);
    expect(orders.hasPending()).toBe(false);   // AS 이벤트로 pending 해소(주문번호 연결 확인)
  });
  it('미종결(부분체결) 상태면 pending 유지', async () => {
    const orders = new OrderStore('AAPL', dir);
    orders.recordPlaced('buy', '20260706093000', '20260706', { ordNo: '141', symbol: 'AAPL', qty: 2, price: 100, placedAtMs: 1 });
    const tracker = new Map<string, TrackedOrder>();
    applyOrderEvent(tracker, ev('AS0', { sOrdNo: '141', sOrgOrdNo: '0', sShtnIsuNo: 'AAPL', sOrdQty: '2', sUnercQty: '2' }), 1);
    applyOrderEvent(tracker, ev('AS1', { sOrdNo: '141', sOrgOrdNo: '0', sExecNO: 'E1', sExecQty: '1', sUnercQty: '1' }), 2);   // PARTIALLY_FILLED
    const resolved = linkTrackedToOrders(tracker, orders);
    expect(resolved).toEqual([]);
    expect(orders.hasPending()).toBe(true);
  });
});

describe('reconcilePending — 타임아웃 취소(BUY→PENDING→CANCELLED 모의 흐름)', () => {
  beforeEach(() => { clock = 1_000_000; });
  it('전체 흐름: 매수→미체결(pending)→타임아웃→취소 완료', async () => {
    const orders = new OrderStore('AAPL', dir);
    // ① 매수 → 미체결
    const buy = await executeBuyOrder(usHarness({ afterRows: [row({ execQty: 0, unfilledQty: 1 })] }), buyParams(orders));
    expect(buy.status).toBe('placed-pending');
    expect(orders.hasPending()).toBe(true);

    // ② 타임아웃 전 → waiting (취소 안 함)
    clock = 1_000_000 + 30_000;
    let cancelled = false;
    const early = await reconcilePending(
      deps({ query: async () => ({ queryOk: true, classification: 'SUCCESS' as const, hasEnvelope: true, rspCd: '00000', rspMsg: '', rows: [row({ execQty: 0, unfilledQty: 1 })], diag: {} as any }), cancel: async () => { cancelled = true; return { rspCd: '00000', rspMsg: '' }; } }),
      { orders, exchcd: '82', ordDate: '20260706', timeoutMs: 60_000, autoCancel: true },
    );
    expect(early[0].status).toBe('waiting');
    expect(cancelled).toBe(false);
    expect(orders.hasPending()).toBe(true);

    // ③ 타임아웃 경과 → 취소 완료
    clock = 1_000_000 + 61_000;
    const late = await reconcilePending(
      deps({ query: async () => ({ queryOk: true, classification: 'SUCCESS' as const, hasEnvelope: true, rspCd: '00000', rspMsg: '', rows: [row({ execQty: 0, unfilledQty: 1 })], diag: {} as any }), cancel: async () => ({ rspCd: '00000', rspMsg: '취소완료' }) }),
      { orders, exchcd: '82', ordDate: '20260706', timeoutMs: 60_000, autoCancel: true },
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
      deps({ query: async () => ({ queryOk: true, classification: 'SUCCESS' as const, hasEnvelope: true, rspCd: '00000', rspMsg: '', rows: [row({ execQty: 1, unfilledQty: 0 })], diag: {} as any }), cancel: async () => { cancelled = true; return { rspCd: '00000', rspMsg: '' }; } }),
      { orders, exchcd: '82', ordDate: '20260706', timeoutMs: 60_000, autoCancel: true },
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
      deps({ query: async () => ({ queryOk: true, classification: 'SUCCESS' as const, hasEnvelope: true, rspCd: '00000', rspMsg: '', rows: [row({ execQty: 0, unfilledQty: 1 })], diag: {} as any }), cancel: async () => { throw new Error('COSAT00311 공식 필드 미확인'); } }),
      { orders, exchcd: '82', ordDate: '20260706', timeoutMs: 60_000, autoCancel: true },
    );
    expect(r[0].status).toBe('cancel-failed');
    expect(orders.hasPending()).toBe(true);   // 취소 성공 확인 전 → 유지(req15)
  });

  it('P0-1·P0-2: 수동취소 모드 — 미체결 타임아웃에도 자동취소 안 함, cancel 미호출, pending 유지', async () => {
    const orders = new OrderStore('AAPL', dir);
    orders.recordPlaced('buy', '20260706093000', '20260706', { ordNo: '141', symbol: 'AAPL', qty: 1, price: 100, placedAtMs: 1_000_000 });
    orders.flush();
    clock = 1_000_000 + 999_000;   // 한참 경과
    let cancelled = false;
    const msgs: string[] = [];
    const r = await reconcilePending(
      deps({ query: async () => ({ queryOk: true, classification: 'SUCCESS' as const, hasEnvelope: true, rspCd: '00000', rspMsg: '', rows: [row({ execQty: 0, unfilledQty: 1 })], diag: {} as any }), cancel: async () => { cancelled = true; return { rspCd: '00000', rspMsg: '' }; }, log: (m) => msgs.push(m) }),
      { orders, exchcd: '82', ordDate: '20260706', timeoutMs: 60_000, autoCancel: false },
    );
    expect(r[0].status).toBe('manual-cancel-required');
    expect(cancelled).toBe(false);                       // ★ 자동취소 호출 안 함
    expect(orders.hasPending()).toBe(true);              // ★ 다음 BUY 금지 유지(P0-2)
    expect(msgs.some(m => /수동취소/.test(m))).toBe(true);   // 안내 메시지
  });
  it('P0-3: 수동취소 모드에서 체결(AS1 상당) 확인되면 해소', async () => {
    const orders = new OrderStore('AAPL', dir);
    orders.recordPlaced('buy', '20260706093000', '20260706', { ordNo: '141', symbol: 'AAPL', qty: 1, price: 100, placedAtMs: 1_000_000 });
    const r = await reconcilePending(
      deps({ query: async () => ({ queryOk: true, classification: 'SUCCESS' as const, hasEnvelope: true, rspCd: '00000', rspMsg: '', rows: [row({ execQty: 1, unfilledQty: 0 })], diag: {} as any }) }),
      { orders, exchcd: '82', ordDate: '20260706', timeoutMs: 60_000, autoCancel: false },
    );
    expect(r[0].status).toBe('filled');
    expect(orders.hasPending()).toBe(false);
  });
});
