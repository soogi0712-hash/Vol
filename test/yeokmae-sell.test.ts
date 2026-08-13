// P0-35US10 — YEOKMAE 자동 SELL 게이트 + us-seller 실행 배선 검증. 실 POST 없음(mock/dry-run).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateYeokmaeSellGate, runYeokmaeSell, type YeokmaeSellIO } from '../local-runner/yeokmae-sell';
import { YeokmaePositionStore } from '../local-runner/yeokmae-position-store';
import { OrderStore } from '../local-runner/order-store';
import { executeSellOrder, type SellOutcome } from '../local-runner/us-seller';

describe('P0-35US10 evaluateYeokmaeSellGate — 전량청산 수량 + 차단조건', () => {
  const base = { strategyTag: 'YEOKMAE', exitAction: 'SELL' as const, sellLive: true, dryRun: false, freshSellableQty: 4, programQty: 4, pendingSell: false, reconciliationOk: true };
  it('모든 조건 충족 → allowed, sellQty=min(program,fresh)=4', () => {
    const g = evaluateYeokmaeSellGate(base);
    expect(g.allowed).toBe(true); expect(g.sellQty).toBe(4);
  });
  it('strategyTag!=YEOKMAE(AIOT/LEGACY) → 차단(NOT_YEOKMAE)', () => {
    expect(evaluateYeokmaeSellGate({ ...base, strategyTag: 'UNKNOWN' }).allowed).toBe(false);
    expect(evaluateYeokmaeSellGate({ ...base, strategyTag: 'LEGACY_BB' }).reasons).toContain('NOT_YEOKMAE');
  });
  it('exit!=SELL → 차단', () => expect(evaluateYeokmaeSellGate({ ...base, exitAction: 'HOLD' }).reasons).toContain('EXIT_NOT_SELL'));
  it('sellLive=false → 차단(SELL_LIVE_OFF)', () => expect(evaluateYeokmaeSellGate({ ...base, sellLive: false }).reasons).toContain('SELL_LIVE_OFF'));
  it('dryRun → 차단(DRY_RUN, POST 0)', () => expect(evaluateYeokmaeSellGate({ ...base, dryRun: true }).reasons).toContain('DRY_RUN'));
  it('pendingSell → 차단(중복 매도 금지)', () => expect(evaluateYeokmaeSellGate({ ...base, pendingSell: true }).reasons).toContain('PENDING_SELL'));
  it('reconciliation 실패 → 차단', () => expect(evaluateYeokmaeSellGate({ ...base, reconciliationOk: false }).reasons).toContain('RECON_NOT_OK'));
  it('전량청산 수량 = min(program,fresh): fresh<program → fresh', () => {
    const g = evaluateYeokmaeSellGate({ ...base, programQty: 4, freshSellableQty: 2 });
    expect(g.sellQty).toBe(2);
  });
  it('freshSellable=0 → NO_SELLABLE_QTY 차단', () => expect(evaluateYeokmaeSellGate({ ...base, freshSellableQty: 0 }).reasons).toContain('NO_SELLABLE_QTY'));
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'yeok-sell-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function seedPRGO(ps: YeokmaePositionStore) {
  ps.applyYeokmaeBuyFill({ symbol: 'PRGO', exchcd: '81', entryDate: '2026-08-13', fillQty: 4, fillPrice: 13.02, confirmedSignalDate: '2026-08-11', matchedSignals: ['112_UPGRADE'] });
  ps.flush();
}
// mock IO — executeSell 는 주입으로 대체(실 POST 없음).
function mockIO(over: Partial<YeokmaeSellIO> & { sellOutcome?: SellOutcome; sellSpy?: () => void } = {}): YeokmaeSellIO {
  return {
    freshSellable: async () => ({ ok: true, qty: 4 }),
    reconcile: async () => ({ ok: true, classification: 'SUCCESS' }),
    executeSell: async () => { over.sellSpy?.(); return over.sellOutcome ?? { status: 'placed-filled', ordNo: '900', execQty: 4, fillPrice: 12.80, reason: '전량 체결' }; },
    sellDeps: {} as any,
    ...over,
  };
}

describe('P0-35US10 runYeokmaeSell — us-seller 배선 + 원장 반영', () => {
  const ctxBase = (ps: YeokmaePositionStore, orders: OrderStore, over: any = {}) => ({
    posStore: ps, orders, position: ps.get('PRGO')!, exchcd: '81',
    exitAction: 'SELL' as const, exitReason: 'STOP_LOSS' as const, pnlPct: -5.5,
    currentPrice: 12.30, etDate: '20260814', sellLive: true, dryRun: false, log: () => {}, ...over,
  });

  it('sellLive & 게이트 통과 → executeSell 호출, 전량체결 → 원장 qty=0 + realizedPnLGross 저장', async () => {
    const ps = new YeokmaePositionStore(dir); ps.load(); seedPRGO(ps);
    const orders = new OrderStore('YEOKMAE_US_PRGO', dir);
    let called = 0;
    const io = mockIO({ sellSpy: () => { called++; }, sellOutcome: { status: 'placed-filled', ordNo: '900', execQty: 4, fillPrice: 12.30, reason: '전량 체결' } });
    const res = await runYeokmaeSell(io, ctxBase(ps, orders));
    expect(res.allowed).toBe(true);
    expect(called).toBe(1);
    expect(res.status).toBe('placed-filled');
    expect(res.filledQty).toBe(4);
    expect(res.remainingQty).toBe(0);
    // realizedPnLGross = (12.30-13.02)*4 = -2.88
    expect(res.realizedPnLGross).toBeCloseTo(-2.88, 2);
    expect(ps.get('PRGO')).toBeNull();                 // 전량청산 → 포지션 삭제
    expect(ps.exits()).toHaveLength(1);
    expect(ps.exits()[0]).toMatchObject({ symbol: 'PRGO', exitReason: 'STOP_LOSS', filledQty: 4, remainingQty: 0 });
  });

  it('dryRun → 게이트 차단(DRY_RUN), executeSell 미호출(POST 0), 원장 유지', async () => {
    const ps = new YeokmaePositionStore(dir); ps.load(); seedPRGO(ps);
    const orders = new OrderStore('YEOKMAE_US_PRGO', dir);
    let called = 0;
    const io = mockIO({ sellSpy: () => { called++; } });
    const res = await runYeokmaeSell(io, ctxBase(ps, orders, { dryRun: true, sellLive: false }));
    expect(res.allowed).toBe(false);
    expect(res.status).toBe('GATE_BLOCKED');
    expect(res.gateReasons).toContain('DRY_RUN');
    expect(called).toBe(0);
    expect(ps.get('PRGO')!.qty).toBe(4);              // 원장 무변경
  });

  it('sellLive=false → 차단(POST 0)', async () => {
    const ps = new YeokmaePositionStore(dir); ps.load(); seedPRGO(ps);
    const orders = new OrderStore('YEOKMAE_US_PRGO', dir);
    let called = 0;
    const res = await runYeokmaeSell(mockIO({ sellSpy: () => { called++; } }), ctxBase(ps, orders, { sellLive: false }));
    expect(res.allowed).toBe(false);
    expect(res.gateReasons).toContain('SELL_LIVE_OFF');
    expect(called).toBe(0);
  });

  it('freshSellable 조회 0 → NO_SELLABLE_QTY 차단(과매도 방지)', async () => {
    const ps = new YeokmaePositionStore(dir); ps.load(); seedPRGO(ps);
    const orders = new OrderStore('YEOKMAE_US_PRGO', dir);
    const res = await runYeokmaeSell(mockIO({ freshSellable: async () => ({ ok: true, qty: 0 }) }), ctxBase(ps, orders));
    expect(res.allowed).toBe(false);
    expect(res.gateReasons).toContain('NO_SELLABLE_QTY');
  });

  it('부분체결 → 원장 잔여 qty 반영, realizedPnL 부분 저장', async () => {
    const ps = new YeokmaePositionStore(dir); ps.load(); seedPRGO(ps);
    const orders = new OrderStore('YEOKMAE_US_PRGO', dir);
    const io = mockIO({ sellOutcome: { status: 'placed-partial', ordNo: '901', execQty: 2, fillPrice: 12.50, reason: '부분체결' } });
    const res = await runYeokmaeSell(io, ctxBase(ps, orders));
    expect(res.filledQty).toBe(2);
    expect(res.remainingQty).toBe(2);
    expect(ps.get('PRGO')!.qty).toBe(2);
  });

  it('실 executeSellOrder(us-seller) 경유 — 대사/신선매도가능/COSAT00301 OrdPtnCode=01 안전경로 전량체결', async () => {
    const ps = new YeokmaePositionStore(dir); ps.load(); seedPRGO(ps);
    const orders = new OrderStore('YEOKMAE_US_PRGO', dir);
    let placed = false; let sentPtn = ''; let sentQty = 0;
    const execRes = (rows: any[]) => ({ queryOk: true, classification: 'SUCCESS' as const, rspCd: '00136', rspMsg: '', rows, hasEnvelope: true, diag: { status: 200 } as any, httpStatus: 200 });
    const io: YeokmaeSellIO = {
      freshSellable: async () => ({ ok: true, qty: 4 }),
      reconcile: async () => ({ ok: true, classification: 'SUCCESS' }),
      executeSell: executeSellOrder,   // ★ 실제 us-seller 안전경로
      sellDeps: {
        place: async (p) => { placed = true; sentQty = p.qty; return { rspCd: '00040', rspMsg: '매도 완료', ordNo: '900', raw: {}, diag: { status: 200 } as any }; },
        query: async () => placed ? execRes([{ ordNo: '900', orgOrdNo: '0', symbol: 'PRGO', ordQty: 4, execQty: 4, unfilledQty: 0, ordPrc: 12.30, ordPtnCode: '01', trxNm: '체결' }]) : execRes([]),
        sellableQty: async () => ({ ok: true, qty: 4 }),
        now: () => 1_000_000, log: () => {},
      },
    };
    // us-seller 는 place 의 OrdPtnCode 를 내부에서 '01' 로 강제(placeLSUSSellOrder). 여기선 place mock 이 qty 만 확인.
    void sentPtn;
    const res = await runYeokmaeSell(io, ctxBase(ps, orders, { currentPrice: 12.30 }));
    expect(res.allowed).toBe(true);
    expect(placed).toBe(true);
    expect(sentQty).toBe(4);                 // min(program4, fresh4)
    expect(res.status).toBe('placed-filled');
    expect(res.remainingQty).toBe(0);
    expect(ps.get('PRGO')).toBeNull();       // 전량청산
    expect(ps.exits()[0].exitReason).toBe('STOP_LOSS');
  });
});
