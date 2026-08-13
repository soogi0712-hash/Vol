// P0-35US3 — US PILOT orderableQty=0 근본원인 진단 검증.
//   (1) usEtSession: IANA America/New_York(DST 자동)로 ET 세션 판정 — 추측 없음.
//   (2) 통일된 orderable 산정: Math.max(crossWon.programQty, qtyCountry) — ls-usws(검증된 AAPL 매수경로) 동일.
//       원화보유(USD현금=0) 계좌에서 기존 순수-USD 계산은 0, 통일 후엔 통합증거금(WonCashMin) 경로로 >0.
//   (3) 예산 게이트(budgetQty) 와 주문가능 게이트(orderableQty/finalQty) 분리.
import { describe, it, expect } from 'vitest';
import {
  usEtSession, usOrderableQty, evaluateCrossWon, usCashOnlyUsdCap, computeUSOrderQty,
  LS_US_CROSS_WON_TR_CONFIRMED, type LSUSDeposit,
} from '../src/lib/ls-api';

function dep(over: Partial<LSUSDeposit> = {}): LSUSDeposit {
  return {
    ok: true, rspCd: '00136', rspMsg: '', found: true, diag: {} as any,
    usdCash: 0, usdOrderable: 0, usdPrexchOrderable: 0, baseXchRate: 1434.6,
    krwCash: 13927349, krwWithdrawable: 13927349, krwPrexchable: 13927349, overseasMargin: 0,
    t4FcurrDps: 0, fcurrOrdAmt: 0, fcurrMxchgAbleAmt: 0, fcurrPldgAmt: 0, loanAmt: 0,
    usdDeposit: 0, rawMasked: {}, ...over,
  };
}
// PILOT 이 쓰는 통일 산정식(ls-usws L715 동일): orderableQty = max(crossWon.programQty, qtyCountry).
const unifiedOrderable = (d: LSUSDeposit, price: number) =>
  Math.max(evaluateCrossWon(d, price, null).programQty, usOrderableQty(d, price).qtyCountry);
// 기존(버그) PILOT 산정식: 순수 USD현금만.
const legacyOrderable = (d: LSUSDeposit, price: number) =>
  price > 0 ? Math.floor(usCashOnlyUsdCap(d, {}) / price) : 0;

describe('P0-35US3 usEtSession — ET 세션 판정(DST 자동, 추측 없음)', () => {
  it('겨울 평일 10:00 EST → REGULAR', () => {
    const r = usEtSession(new Date('2026-01-15T15:00:00Z'));
    expect(r.session).toBe('REGULAR');
    expect(r.etTime).toContain('10:00 ET(Thu)');
  });
  it('겨울 평일 08:00 EST → PRE_MARKET', () => {
    expect(usEtSession(new Date('2026-01-15T13:00:00Z')).session).toBe('PRE_MARKET');
  });
  it('겨울 평일 17:00 EST → AFTER_HOURS', () => {
    expect(usEtSession(new Date('2026-01-15T22:00:00Z')).session).toBe('AFTER_HOURS');
  });
  it('겨울 평일 21:00 EST → CLOSED', () => {
    expect(usEtSession(new Date('2026-01-15T02:00:00Z')).session).toBe('CLOSED');
  });
  it('여름 평일 10:00 EDT(DST=-4) → REGULAR (환산 정확)', () => {
    // 14:00Z 를 -5 로 잘못 보면 09:00(REGULAR 경계 이전 아님)이지만 실제 EDT 10:00 → REGULAR. DST 자동처리 확인.
    expect(usEtSession(new Date('2026-07-15T14:00:00Z')).session).toBe('REGULAR');
  });
  it('토요일 → CLOSED_WEEKEND', () => {
    expect(usEtSession(new Date('2026-08-15T15:00:00Z')).session).toBe('CLOSED_WEEKEND');
  });
});

describe('P0-35US3 orderable 산정 통일 — 원화보유(USD현금=0) 계좌 근본수정', () => {
  it('코드상수 확정 전제', () => expect(LS_US_CROSS_WON_TR_CONFIRMED).toBe(true));

  it('USD현금=0·원화보유 계좌: 기존식=0(버그) → 통일식>0 (통합증거금 WonCashMin 경로 포함)', () => {
    const d = dep({ usdOrderable: 0, krwCash: 13927349, krwWithdrawable: 13927349 });
    const price = 311;
    // qtyCountry(USD현금)=0
    expect(usOrderableQty(d, price).qtyCountry).toBe(0);
    // crossWon.programQty = floor(WonCashMin / (price*rate)) = floor(13927349 / (311*1434.6))
    const expected = Math.floor(13927349 / (price * 1434.6));
    expect(evaluateCrossWon(d, price, null).programQty).toBe(expected);
    // 기존 PILOT 식은 0 (근본원인), 통일 식은 expected(>0)
    expect(legacyOrderable(d, price)).toBe(0);
    expect(unifiedOrderable(d, price)).toBe(expected);
    expect(unifiedOrderable(d, price)).toBeGreaterThan(0);
  });

  it('PRGO 재현($12.69, 예산 $60): budgetQty=4(≠0) — 예산부족과 주문가능0 을 분리', () => {
    const d = dep({ usdOrderable: 0, krwCash: 1000000, krwWithdrawable: 1000000, baseXchRate: 1434.6 });
    const price = 12.69, budgetUSD = 60;
    const orderable = unifiedOrderable(d, price);
    const q = computeUSOrderQty({ perTradeBudgetUsd: budgetUSD, orderableQty: orderable, bestAsk: price, maxQty: null });
    expect(q.budgetQty).toBe(Math.floor(budgetUSD / price));   // = 4, 예산 게이트는 0 이 아님
    expect(q.budgetQty).toBe(4);
    // 원화 100만 보유 → 통합증거금 경로로 orderable>0 → finalQty=min(orderable,4)
    expect(orderable).toBeGreaterThan(0);
    expect(q.finalQty).toBe(Math.min(orderable, 4));
    expect(q.finalQty).toBeGreaterThanOrEqual(1);
  });

  it('진짜 자본부족(USD현금=0·원화=0): 통일식도 0 — 예산이 아닌 실입금 필요로 구분됨', () => {
    const d = dep({ usdOrderable: 0, usdCash: 0, krwCash: 0, krwWithdrawable: 0, krwPrexchable: 0 });
    const price = 12.69;
    expect(unifiedOrderable(d, price)).toBe(0);
    // 예산 게이트는 여전히 정상(budgetQty>=1) — '자본부족'과 '예산상한'을 같은 이유로 표시하지 않음
    const q = computeUSOrderQty({ perTradeBudgetUsd: 60, orderableQty: 0, bestAsk: price, maxQty: null });
    expect(q.budgetQty).toBe(4);
    expect(q.finalQty).toBe(0);
    expect(q.reason).toBe('CASH_INSUFFICIENT');
  });

  it('USD현금 충분 계좌: qtyCountry 경로로도 orderable>0 (통일식이 max 로 포함)', () => {
    const d = dep({ usdOrderable: 700, usdCash: 700, krwCash: 0, krwWithdrawable: 0 });
    const price = 311;
    expect(usOrderableQty(d, price).qtyCountry).toBe(2);   // 700/311
    expect(unifiedOrderable(d, price)).toBeGreaterThanOrEqual(2);
  });
});
