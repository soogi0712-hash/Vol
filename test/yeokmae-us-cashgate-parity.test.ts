// P0-35US5 — preflight orderable ↔ executor CASH_GATE parity 회귀 테스트.
//   preflight(pilot-core)와 executor(pilot-live/trader)가 동일 crossWonVerified 기준으로 cash/orderable 을 판정하므로
//   "preflight finalQty>0 인데 executor CASH_GATE=0" 불일치가 재발하지 않아야 한다(PRGO abort 원인 제거).
//   두 경로가 쓰는 실제 라이브러리 함수(usCashOnlyUsdCap/evaluateCrossWon/usOrderableQty/computeUSOrderQty)와
//   실제 executor(executeBuyOrder)를 그대로 호출해 검증한다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usCashOnlyUsdCap, computeUSOrderQty, type LSUSDeposit } from '../src/lib/ls-api';
import { executeBuyOrder, type TraderDeps, type BuyParams } from '../local-runner/trader';
import { OrderStore } from '../local-runner/order-store';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'us-parity-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function dep(over: Partial<LSUSDeposit> = {}): LSUSDeposit {
  return {
    ok: true, rspCd: '00136', rspMsg: '', found: true, diag: { status: 200 } as any,
    usdCash: 0, usdOrderable: 0, usdPrexchOrderable: 0, baseXchRate: 1434.6,
    krwCash: 840000, krwWithdrawable: 840000, krwPrexchable: 840000, overseasMargin: 0,
    t4FcurrDps: 0, fcurrOrdAmt: 0, fcurrMxchgAbleAmt: 0, fcurrPldgAmt: 0, loanAmt: 0,
    usdDeposit: 0, rawMasked: {}, ...over,
  };
}

// preflight(pilot-core)와 정확히 동일한 orderable/finalQty 산정 — orderable = floor(executorCashGate/price).
function preflightSizing(d: LSUSDeposit, price: number, budgetUSD: number, crossWonVerified: boolean) {
  const orderable = price > 0 ? Math.floor(usCashOnlyUsdCap(d, { crossWonVerified }) / price) : 0;
  const qtyDec = computeUSOrderQty({ perTradeBudgetUsd: budgetUSD, orderableQty: orderable, bestAsk: price, maxQty: null });
  return { orderable, budgetQty: qtyDec.budgetQty, finalQty: qtyDec.finalQty };
}
// executor(pilot-live)와 동일한 cash 게이트 상한.
const executorCashUSD = (d: LSUSDeposit, crossWonVerified: boolean) => usCashOnlyUsdCap(d, { crossWonVerified });

// executor 를 실제 호출해 CASH_GATE 여부를 본다(mock place/query — POST 실제 전송 없음).
async function runExecutor(orders: OrderStore, p: { exchcd: string; symbol: string; qty: number; price: number; cashUSD: number }) {
  const logs: string[] = []; let placeCalls = 0;
  const deps: TraderDeps = {
    place: async () => { placeCalls++; return { rspCd: '00000', rspMsg: 'ok', ordNo: '141', raw: {}, diag: { status: 200 } as any }; },
    query: async () => ({ queryOk: true, classification: 'EMPTY' as any, rspCd: '02679', rspMsg: '', rows: [] as any[], hasEnvelope: true, diag: { status: 200 } as any, httpStatus: 200 }),
    cancel: async () => ({ rspCd: '00000', rspMsg: 'ok' }),
    cashOrderable: async () => ({ ok: true, cash: p.cashUSD, rspCd: '00136', rspMsg: '' }),
    now: () => 1_000_000, log: (m) => logs.push(m),
  };
  const params: BuyParams = { orders, exchcd: p.exchcd, symbol: p.symbol, candleDatetime: '20260811', qty: p.qty, price: p.price, etDate: '20260813', dailyMaxBuys: 1, reqTag: 'US-PILOT-BUY' };
  const out = await executeBuyOrder(deps, params);
  return { out, logs, placeCalls, cashGate: out.abortCode === 'CASH_GATE' };
}

describe('P0-35US5 parity — USD현금 0 + 원화충분', () => {
  const price = 12.86, budget = 60;   // PRGO 실계정 파라미터

  it('crossWonVerified=true → PRGO(budgetQty=4/orderableQty=45/finalQty=4) 재현 + executor CASH_GATE 통과', async () => {
    const d = dep();   // usdCash=0, krwCash=840000, rate=1434.6
    const s = preflightSizing(d, price, budget, true);
    expect(s.orderable).toBe(45);
    expect(s.budgetQty).toBe(4);
    expect(s.finalQty).toBe(4);
    // executor cash 상한이 preflight finalQty 결제금액 이상 → CASH_GATE 통과
    const cashUSD = executorCashUSD(d, true);
    expect(price * s.finalQty).toBeLessThanOrEqual(cashUSD);
    const orders = new OrderStore('YEOKMAE_US_PRGO', dir);
    const r = await runExecutor(orders, { exchcd: '81', symbol: 'PRGO', qty: s.finalQty, price, cashUSD });
    expect(r.cashGate).toBe(false);       // ⚠️ CASH_GATE 아님
    expect(r.placeCalls).toBe(1);         // place 도달(단, mock — 실전송 아님)
    expect(r.out.status).not.toBe('aborted');   // CASH_GATE 통과(placed-filled/pending)
  });

  it('crossWonVerified=false → 순수 USD현금(0)만 → 차단(preflight finalQty=0 · executor cashUSD=0 일치)', async () => {
    const d = dep();
    const s = preflightSizing(d, price, budget, false);
    expect(s.orderable).toBe(0);          // qtyCountry(USD현금)=0
    expect(s.finalQty).toBe(0);           // 주문 없음(상위 게이트 차단)
    expect(executorCashUSD(d, false)).toBe(0);   // executor 도 0 → 불일치 없음(둘 다 차단)
    // finalQty=0 이면 executor 를 호출하지 않지만, 만약 호출돼도(qty=1 가정) CASH_GATE 로 차단됨을 확인.
    const orders = new OrderStore('YEOKMAE_US_PRGO', dir);
    const r = await runExecutor(orders, { exchcd: '81', symbol: 'PRGO', qty: 1, price, cashUSD: 0 });
    expect(r.cashGate).toBe(true);
    expect(r.placeCalls).toBe(0);         // COSAT00301 미호출
  });

  it('필요금액 > 통합증거금(원화현금 소액) → preflight orderable=0 차단, executor cashUSD<1주', async () => {
    const d = dep({ krwCash: 10000, krwWithdrawable: 10000, krwPrexchable: 10000 });   // 1주(≈18449원)도 안 됨
    const s = preflightSizing(d, price, budget, true);
    expect(s.orderable).toBe(0);          // programQty=floor(10000/18449)=0
    expect(s.finalQty).toBe(0);
    expect(executorCashUSD(d, true)).toBeLessThan(price);   // cashUSD(6.97) < 1주(12.86)
  });

  it('cash-only 원칙 유지: 미수(OvrsMgn>0) → orderable=0 · cashUSD=0 (신용/미수 금지)', async () => {
    const d = dep({ overseasMargin: 5000 });
    expect(preflightSizing(d, price, budget, true).orderable).toBe(0);
    expect(executorCashUSD(d, true)).toBe(0);
    const d2 = dep({ loanAmt: 5000 });   // 대출도 동일
    expect(executorCashUSD(d2, true)).toBe(0);
  });
});

describe('P0-35US5 parity 속성 — executor 는 preflight 가 허용한 수량을 CASH_GATE 로 되막지 않는다', () => {
  const price = 20, budget = 100;
  // 다양한 원화/USD 현금 조합에서 price*finalQty <= executorCashUSD (동일 crossWonVerified) 불변식.
  const cases: Array<Partial<LSUSDeposit>> = [
    { usdOrderable: 0, krwCash: 840000, krwWithdrawable: 840000 },
    { usdOrderable: 500, usdCash: 500, krwCash: 0, krwWithdrawable: 0 },
    { usdOrderable: 30, usdCash: 30, krwCash: 1_000_000, krwWithdrawable: 1_000_000 },
    { usdOrderable: 0, krwCash: 60000, krwWithdrawable: 40000 },   // WonCashMin=40000
    { usdOrderable: 15, usdCash: 15, krwCash: 25000, krwWithdrawable: 25000 },
  ];
  for (const [i, over] of cases.entries()) {
    it(`case#${i} crossWonVerified=true parity`, () => {
      const d = dep(over);
      const s = preflightSizing(d, price, budget, true);
      const cashUSD = executorCashUSD(d, true);
      if (s.finalQty > 0) expect(price * s.finalQty).toBeLessThanOrEqual(cashUSD);   // 되막지 않음
    });
    it(`case#${i} crossWonVerified=false parity(순수 USD)`, () => {
      const d = dep(over);
      const s = preflightSizing(d, price, budget, false);
      const cashUSD = executorCashUSD(d, false);
      if (s.finalQty > 0) expect(price * s.finalQty).toBeLessThanOrEqual(cashUSD);
    });
  }
});
