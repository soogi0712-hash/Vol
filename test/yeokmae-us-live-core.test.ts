// P0-34 — US 실전 코어: 실주문 게이트 / KRW→USD 자본가드(실 baseXchRate) / UPGRADE 후보랭킹 / exit resolver / 수동보유 보호.
import { describe, it, expect } from 'vitest';
import {
  usRealOrderEnabled, usSellEnabled, resolveUSExitPolicy, selectUSBuyCandidates, computeUSYeokmaeCapitalGuard,
  US_BUY_PATH_READY, US_SELL_PATH_READY,
} from '../local-runner/yeokmae/us-live-core';
import type { SymbolDiscovery } from '../local-runner/yeokmae/discovery';

const A0 = { '112_ORIGINAL': false, '224_ORIGINAL': false, '112_UPGRADE': false, '224_UPGRADE': false, 'LONG_TERM': false };
function disc(symbol: string, over: Partial<SymbolDiscovery> & { arrows?: Partial<typeof A0> } = {}): SymbolDiscovery {
  const { arrows: ao, ...rest } = over;
  const arrows = { ...A0, ...(ao ?? {}) } as SymbolDiscovery['arrows'];
  const anyArrow = Object.values(arrows).some(Boolean);
  return {
    symbol, ready: true, reverse: true, bars: 800, lastConfirmed: '2026-08-13',
    ema112: 100, ema224: 110, ema448: 120, conditions: {}, searcherFormulaPass: false,
    verifiedFailed: [], unverifiedExternal: ['A', 'B', 'C', 'T'], verifiedFailedCount: 0,
    ...rest, arrows, anyArrow, arrowCount: Object.values(arrows).filter(Boolean).length,
  } as SymbolDiscovery;
}
const EX = new Map<string, { exchcd: string; exchange: string }>([
  ['BOTH', { exchcd: '82', exchange: 'NASDAQ' }], ['U112', { exchcd: '82', exchange: 'NASDAQ' }],
  ['U224', { exchcd: '81', exchange: 'NYSE_AMEX' }], ['ORIG', { exchcd: '82', exchange: 'NASDAQ' }],
  ['NOEXCH_UP', { exchcd: '', exchange: '' }],
]);

describe('P0-34 usRealOrderEnabled — US 실주문 최종 게이트(KR 과 별개)', () => {
  const on = { liveTrading: true, yeokmaeLive: true, usLive: true, exitConfirmed: true, historyReady: true };
  it('전부 충족 → enabled=true, reasons 없음', () => {
    const r = usRealOrderEnabled(on);
    expect(r.enabled).toBe(true); expect(r.reasons).toHaveLength(0);
    expect(r.buyPathReady).toBe(US_BUY_PATH_READY); expect(r.sellPathReady).toBe(US_SELL_PATH_READY);
  });
  it('각 조건 off → 해당 사유로 차단', () => {
    expect(usRealOrderEnabled({ ...on, liveTrading: false }).reasons).toContain('LS_LIVE_TRADING_off');
    expect(usRealOrderEnabled({ ...on, yeokmaeLive: false }).reasons).toContain('YEOKMAE_LIVE_TRADING_off');
    expect(usRealOrderEnabled({ ...on, usLive: false }).reasons).toContain('YEOKMAE_US_LIVE_TRADING_off');
    expect(usRealOrderEnabled({ ...on, exitConfirmed: false }).reasons).toContain('YEOKMAE_US_EXIT_CONFIRMED_off');
    expect(usRealOrderEnabled({ ...on, historyReady: false }).reasons).toContain('US_DAILY_HISTORY_NOT_READY');
    expect(usRealOrderEnabled({ ...on, usLive: false }).enabled).toBe(false);
  });
  it('history 미준비면 다른 조건 다 충족해도 게이트 닫힘(g3204 rows>0 전 실주문 금지)', () => {
    expect(usRealOrderEnabled({ ...on, historyReady: false }).enabled).toBe(false);
  });
});

describe('P0-38 usSellEnabled — SELL 게이트는 historyReady 무관(청산 항상 감시)', () => {
  const on = { liveTrading: true, yeokmaeLive: true, usLive: true, exitConfirmed: true };
  it('history 없어도(=BUY 불가) SELL 게이트는 열림', () => {
    // BUY 게이트는 historyReady=false 면 닫힘
    expect(usRealOrderEnabled({ ...on, historyReady: false }).enabled).toBe(false);
    // SELL 게이트는 historyReady 파라미터 자체가 없음 → 나머지 충족 시 열림
    expect(usSellEnabled(on).enabled).toBe(true);
    expect(usSellEnabled(on).reasons).toHaveLength(0);
  });
  it('각 스위치 off → SELL 게이트 차단', () => {
    expect(usSellEnabled({ ...on, liveTrading: false }).reasons).toContain('LS_LIVE_TRADING_off');
    expect(usSellEnabled({ ...on, usLive: false }).reasons).toContain('YEOKMAE_US_LIVE_TRADING_off');
    expect(usSellEnabled({ ...on, exitConfirmed: false }).reasons).toContain('YEOKMAE_US_EXIT_CONFIRMED_off');
  });
});

describe('P0-34 resolveUSExitPolicy — YEOKMAE_US_* (KR 과 값 독립, emergency 항상활성)', () => {
  it('미설정 → pendingDecisions, emergency 기본 15, confirmed=false', () => {
    const p = resolveUSExitPolicy({} as any);
    expect(p.stopLossPct).toBeNull(); expect(p.takeProfitPct).toBeNull();
    expect(p.emergencyStopPct).toBe(15); expect(p.confirmed).toBe(false);
    expect(p.pendingDecisions.length).toBeGreaterThanOrEqual(4);
  });
  it('사용자 확정값(-5/+8/20) → pendingDecisions 없음', () => {
    const p = resolveUSExitPolicy({ YEOKMAE_US_STOP_LOSS_PCT: '5', YEOKMAE_US_TAKE_PROFIT_PCT: '8', YEOKMAE_US_MAX_HOLD_DAYS: '20', YEOKMAE_US_EXIT_CONFIRMED: 'true' } as any);
    expect(p.stopLossPct).toBe(5); expect(p.takeProfitPct).toBe(8); expect(p.maxHoldDays).toBe(20);
    expect(p.confirmed).toBe(true); expect(p.pendingDecisions).toHaveLength(0);
  });
});

describe('P0-34 selectUSBuyCandidates — UPGRADE-only, exchcd 조인, 랭킹 BOTH>112>224', () => {
  const res = [
    disc('ORIG', { arrows: { '112_ORIGINAL': true } }),
    disc('U224', { arrows: { '224_UPGRADE': true } }),
    disc('U112', { arrows: { '112_UPGRADE': true } }),
    disc('BOTH', { arrows: { '112_UPGRADE': true, '224_UPGRADE': true } }),
  ];
  it('BOTH>112>224 랭킹, ORIGINAL 제외', () => {
    const cands = selectUSBuyCandidates(res, EX);
    expect(cands.map(c => c.symbol)).toEqual(['BOTH', 'U112', 'U224']);
    expect(cands[0].tier).toBe('BOTH_UPGRADE'); expect(cands[0].exchcd).toBe('82');
  });
  it('exchcd 미확인 UPGRADE 종목은 후보 제외(추측 금지)', () => {
    const cands = selectUSBuyCandidates([disc('NOEXCH_UP', { arrows: { '112_UPGRADE': true } })], EX);
    expect(cands).toHaveLength(0);
  });
  it('원장보유 ∪ 계좌보유(수동) ∪ pending 재진입 금지', () => {
    const cands = selectUSBuyCandidates(res, EX, { heldSymbols: new Set(['BOTH', 'U112']), pendingSymbols: new Set(['U224']) });
    expect(cands).toHaveLength(0);   // 나머지 ORIG 는 UPGRADE 아님
  });
});

describe('P0-34 computeUSYeokmaeCapitalGuard — 종목당 10만원(USD 환산)/총자본/cash-only, 고정환율 금지', () => {
  const base = { totalCapitalKRW: 1_000_000, perTradeKRW: 100_000, investedUSD: 0, pendingUSD: 0, cashOnlyUsd: 100_000 };
  it('rate=1400, price=$10 → perTradeUSD≈71.43 → perTradeQty=7, finalQty=7', () => {
    const g = computeUSYeokmaeCapitalGuard({ ...base, bestAsk: 10, baseXchRate: 1400 });
    expect(g.perTradeUSD).toBeCloseTo(71.43, 1);
    expect(g.perTradeQty).toBe(7);
    expect(g.finalQty).toBe(7);
    expect(g.reason).toBe('OK');
  });
  it('baseXchRate<=0 → NO_XCHRATE(고정환율로 대체하지 않음, finalQty=0)', () => {
    const g = computeUSYeokmaeCapitalGuard({ ...base, bestAsk: 10, baseXchRate: 0 });
    expect(g.canNewBuy).toBe(false);
    expect(g.reason).toContain('NO_XCHRATE');
    expect(g.finalQty).toBe(0);
  });
  it('단가가 종목당예산 초과($100>71.43) → PER_TRADE_TOO_SMALL', () => {
    const g = computeUSYeokmaeCapitalGuard({ ...base, bestAsk: 100, baseXchRate: 1400 });
    expect(g.perTradeQty).toBe(0);
    expect(g.reason).toContain('PER_TRADE_TOO_SMALL');
  });
  it('cash-only: 주문가능현금 부족 → CASH_INSUFFICIENT', () => {
    const g = computeUSYeokmaeCapitalGuard({ ...base, cashOnlyUsd: 5, bestAsk: 10, baseXchRate: 1400 });
    expect(g.cashQty).toBe(0);
    expect(g.reason).toContain('CASH_INSUFFICIENT');
  });
  it('총자본 소진(invested 환산 > 총한도) → CAPITAL_EXHAUSTED', () => {
    const g = computeUSYeokmaeCapitalGuard({ ...base, investedUSD: 1000, bestAsk: 10, baseXchRate: 1400 });
    expect(g.reason).toBe('CAPITAL_EXHAUSTED');
    expect(g.canNewBuy).toBe(false);
  });
  it('총자본 잔여가 종목당예산보다 작으면 잔여로 수량축소(REDUCED_TO_FIT)', () => {
    // remaining≈50,000원 → capacityQty=3 < perTradeQty=7 → finalQty=3
    const g = computeUSYeokmaeCapitalGuard({ ...base, investedUSD: 678.57, bestAsk: 10, baseXchRate: 1400 });
    expect(g.capacityQty).toBe(3);
    expect(g.finalQty).toBe(3);
    expect(g.reason).toContain('REDUCED_TO_FIT');
    // 투입후 총사용(KRW) <= 총한도
    expect(g.investedUSD * 1400 + g.candidateKRW).toBeLessThanOrEqual(1_000_000);
  });
  it('finalQty = min(perTradeQty, cashQty, capacityQty)', () => {
    // perTradeQty=7, cashQty= floor(50/10)=5, capacity 큼 → finalQty=5
    const g = computeUSYeokmaeCapitalGuard({ ...base, cashOnlyUsd: 50, bestAsk: 10, baseXchRate: 1400 });
    expect(g.cashQty).toBe(5);
    expect(g.finalQty).toBe(5);
  });
});
