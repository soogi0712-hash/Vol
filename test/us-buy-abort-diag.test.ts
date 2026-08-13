// P0-35US4 — executeBuyOrder abort 계측 검증.
//   각 abort 가 [US-BUY-ABORT] 를 stage/placeCalled 와 함께 출력하고, placeCalled=false(=COSAT00301 미호출)를
//   broker reject(placeCalled=true)와 구분하는지 확인. PRGO 재현: CASH_GATE(현금 0) → place() 절대 미호출.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeBuyOrder, type TraderDeps, type BuyParams } from '../local-runner/trader';
import { OrderStore } from '../local-runner/order-store';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'us-abort-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type ExecRow = { ordNo: string; orgOrdNo: string; symbol: string; ordQty: number; execQty: number; unfilledQty: number; ordPrc: number; ordPtnCode: string; trxNm: string };
const execRes = (rows: ExecRow[] = [], rspCd = '00000', queryOk = true, classification: any = 'SUCCESS') =>
  ({ queryOk, classification, rspCd, rspMsg: '', rows, hasEnvelope: true, diag: { status: 200 } as any, httpStatus: 200 });

function harness(over: Partial<TraderDeps> & { afterRows?: ExecRow[] } = {}): { deps: TraderDeps; logs: string[]; placeCalls: () => number } {
  const logs: string[] = [];
  let placeCalls = 0; let placed = false;
  const { afterRows, ...depsOver } = over;
  const deps: TraderDeps = {
    place: async () => { placeCalls++; placed = true; return { rspCd: '00000', rspMsg: 'ok', ordNo: '141', raw: {}, diag: { status: 200 } as any }; },
    // 전송 전 대사는 빈 rows(미기록 없음), 전송 후 체결조회는 afterRows.
    query: async () => placed ? execRes(afterRows ?? []) : execRes([]),
    cancel: async () => ({ rspCd: '00000', rspMsg: 'ok' }),
    cashOrderable: async () => ({ ok: true, cash: 1_000_000, rspCd: '00136', rspMsg: '' }),
    now: () => 1_000_000,
    log: (m) => logs.push(m),
    ...depsOver,
  };
  return { deps, logs, placeCalls: () => placeCalls };
}
// PRGO 실계정 파라미터
const prgoParams = (orders: OrderStore): BuyParams =>
  ({ orders, exchcd: '81', symbol: 'PRGO', candleDatetime: '20260811', qty: 4, price: 12.86, etDate: '20260813', dailyMaxBuys: 1, reqTag: 'US-PILOT-BUY' });

describe('P0-35US4 [US-BUY-ABORT] — PRGO CASH_GATE (현금 0 → COSAT00301 미호출)', () => {
  it('cashOrderable=0 → stage=ORDERABLE/PRICE CASH_GATE, place() 미호출, posted=false', async () => {
    const orders = new OrderStore('YEOKMAE_US_PRGO', dir);
    // PRGO 재현: 예수금 조회는 성공(rsp_cd=00136)이나 순수 USD현금=0 → need(51.44) > 0.
    const h = harness({ cashOrderable: async () => ({ ok: true, cash: 0, rspCd: '00136', rspMsg: '' }) });
    const r = await executeBuyOrder(h.deps, prgoParams(orders));
    expect(r.status).toBe('aborted');
    expect(r.abortCode).toBe('CASH_GATE');
    expect(r.stage).toBe('ORDERABLE/PRICE');
    expect(h.placeCalls()).toBe(0);   // ⚠️ COSAT00301 place API 자체가 호출 안 됨
    const abortLine = h.logs.find(l => l.startsWith('[US-BUY-ABORT]'))!;
    expect(abortLine).toContain('stage=ORDERABLE/PRICE');
    expect(abortLine).toContain('abortCode=CASH_GATE');
    expect(abortLine).toContain('placeCalled=false');
    expect(abortLine).toContain('posted=false');
    expect(abortLine).toContain('rsp_cd=00136');   // 예수금 조회 원 응답코드 노출
    // place 미호출이므로 [*-REQ]/[*-RESP] 는 출력되지 않는다(SEND 미도달).
    expect(h.logs.some(l => l.includes('-REQ]'))).toBe(false);
  });
});

describe('P0-35US4 [US-BUY-ABORT] — POST 전/후 stage 구분', () => {
  it('duplicate candle → stage=CANDLE_LOCK, place() 미호출', async () => {
    const orders = new OrderStore('YEOKMAE_US_PRGO', dir);
    orders.lockCandle('20260811', 'buy'); orders.flush();
    const h = harness();
    const r = await executeBuyOrder(h.deps, prgoParams(orders));
    expect(r.abortCode).toBe('DUPLICATE_CANDLE');
    expect(r.stage).toBe('CANDLE_LOCK');
    expect(h.placeCalls()).toBe(0);
  });
  it('pending 존재 → stage=PENDING_CHECK, place() 미호출', async () => {
    const orders = new OrderStore('YEOKMAE_US_PRGO', dir);
    // 어제자(20260812) 미체결 → 오늘(20260813) 매수카운트 0(canBuyToday 통과), hasPending()=true 로 PENDING 격리.
    orders.recordPlaced('buy', '20260810', '20260812', { ordNo: '900', symbol: 'PRGO', qty: 1, price: 12, placedAtMs: 1 }); orders.flush();
    const h = harness();
    const r = await executeBuyOrder(h.deps, prgoParams(orders));
    expect(r.abortCode).toBe('PENDING');
    expect(r.stage).toBe('PENDING_CHECK');
    expect(h.placeCalls()).toBe(0);
  });
  it('reconciliation 업무오류(BUSINESS_ERROR) → stage=PRE_RECONCILIATION, place() 미호출', async () => {
    const orders = new OrderStore('YEOKMAE_US_PRGO', dir);
    const h = harness({ query: async () => execRes([], 'IZAA', false, 'BUSINESS_ERROR') });
    const r = await executeBuyOrder(h.deps, prgoParams(orders));
    expect(r.abortCode).toBe('RECONCILIATION_FAILED');
    expect(r.stage).toBe('PRE_RECONCILIATION');
    expect(h.placeCalls()).toBe(0);
  });
  it('broker 거부(비성공 rsp_cd·ordNo 없음) → stage=POST_RESPONSE, placeCalled=true, [*-REQ]/[*-RESP] 출력', async () => {
    const orders = new OrderStore('YEOKMAE_US_PRGO', dir);
    const h = harness({
      cashOrderable: async () => ({ ok: true, cash: 100_000, rspCd: '00136', rspMsg: '' }),
      place: async () => ({ rspCd: 'IZBA', rspMsg: '거부', ordNo: null, raw: {}, diag: { status: 200 } as any }),
    });
    const r = await executeBuyOrder(h.deps, prgoParams(orders));
    expect(r.abortCode).toBe('ORDER_REJECTED');
    expect(r.stage).toBe('POST_RESPONSE');
    const abortLine = h.logs.find(l => l.startsWith('[US-BUY-ABORT]'))!;
    expect(abortLine).toContain('placeCalled=true');   // place 호출됨 → broker 가 거부(호출 안 됨과 구분)
    expect(abortLine).toContain('rsp_cd=IZBA');
    // reqTag=US-PILOT-BUY → SEND 단계 진단 출력
    expect(h.logs.some(l => l.startsWith('[US-PILOT-BUY-REQ]') && l.includes('OrdMktCode=81') && l.includes('IsuNo=PRGO') && l.includes('OrdQty=4') && l.includes('OvrsOrdPrc=12.86') && l.includes('OrdPtnCode=02') && l.includes('OrdprcPtnCode=00'))).toBe(true);
    expect(h.logs.some(l => l.startsWith('[US-PILOT-BUY-RESP]') && l.includes('rsp_cd=IZBA'))).toBe(true);
  });
  it('정상 체결 시엔 abort 로그 없음(회귀 방지)', async () => {
    const orders = new OrderStore('YEOKMAE_US_PRGO', dir);
    const h = harness({
      cashOrderable: async () => ({ ok: true, cash: 100_000, rspCd: '00136', rspMsg: '' }),
      afterRows: [{ ordNo: '141', orgOrdNo: '0', symbol: 'PRGO', ordQty: 4, execQty: 4, unfilledQty: 0, ordPrc: 12.86, ordPtnCode: '02', trxNm: '체결' }],
    });
    const r = await executeBuyOrder(h.deps, prgoParams(orders));
    expect(r.status).toBe('placed-filled');
    expect(h.logs.some(l => l.startsWith('[US-BUY-ABORT]'))).toBe(false);
    expect(h.logs.some(l => l.startsWith('[US-PILOT-BUY-REQ]'))).toBe(true);   // SEND 도달 → REQ 출력
  });
});
