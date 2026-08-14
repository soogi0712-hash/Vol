// P0-33 — KR 실전 코어: 자본가드 / UPGRADE-only 후보 / A·B·C 마스터연결 / 청산정책 resolver.
import { describe, it, expect } from 'vitest';
import { computeKRCapitalGuard, selectKRBuyCandidates, krMasterFlags, resolveKRExitPolicy } from '../local-runner/yeokmae/kr-live-core';
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

describe('P0-33 computeKRCapitalGuard — 총100만/종목10만/cash-only', () => {
  const base = { totalCapitalKRW: 1_000_000, perTradeKRW: 100_000, investedKRW: 0, pendingKRW: 0, orderableCash: 1_000_000 };
  it('종목당 10만 상한 → budgetQty=floor(10만/price)', () => {
    const g = computeKRCapitalGuard({ ...base, price: 20_000 });   // 10만/2만=5
    expect(g.budgetQty).toBe(5);
    expect(g.finalQty).toBe(5);
    expect(g.candidateKRW).toBe(100_000);
    expect(g.reason).toBe('OK');
  });
  it('총자본 100만 초과 금지 — 이미 95만 사용 → 남은 5만 한도로 수량축소', () => {
    const g = computeKRCapitalGuard({ ...base, investedKRW: 900_000, pendingKRW: 50_000, price: 10_000 });
    // remaining=1,000,000-950,000=50,000 → capacityQty=5. budgetQty=100,000/10,000=10. cashQty=100 → min=5
    expect(g.remainingCapitalKRW).toBe(50_000);
    expect(g.capacityQty).toBe(5);
    expect(g.finalQty).toBe(5);
    expect(g.reason).toContain('REDUCED_TO_FIT');
    // 투입후 총사용 = 950,000 + 5*10,000 = 1,000,000 (초과 안 함)
    expect(g.investedKRW + g.pendingKRW + g.candidateKRW).toBeLessThanOrEqual(1_000_000);
  });
  it('cash-only: 주문가능현금 부족 → CASH_INSUFFICIENT(신용/미수 사용 안 함)', () => {
    const g = computeKRCapitalGuard({ ...base, orderableCash: 5_000, price: 10_000 });   // cashQty=0
    expect(g.cashQty).toBe(0);
    expect(g.canNewBuy).toBe(false);
    expect(g.reason).toContain('CASH_INSUFFICIENT');
  });
  it('자본 소진(invested+pending>=total) → CAPITAL_EXHAUSTED', () => {
    const g = computeKRCapitalGuard({ ...base, investedKRW: 1_000_000, price: 10_000 });
    expect(g.canNewBuy).toBe(false);
    expect(g.reason).toBe('CAPITAL_EXHAUSTED');
  });
  it('1주가 종목당예산 초과(단가>10만) → PER_TRADE_TOO_SMALL', () => {
    const g = computeKRCapitalGuard({ ...base, price: 150_000 });
    expect(g.budgetQty).toBe(0);
    expect(g.reason).toContain('PER_TRADE_TOO_SMALL');
  });
});

describe('P0-33 selectKRBuyCandidates — UPGRADE-only, ORIGINAL 자동대체 금지', () => {
  it('112_UPGRADE/224_UPGRADE 만 후보. ORIGINAL/LONG_TERM 단독은 제외', () => {
    const res = [
      disc('ORIG', { arrows: { '112_ORIGINAL': true } }),
      disc('LT', { arrows: { 'LONG_TERM': true } }),
      disc('U112', { arrows: { '112_UPGRADE': true } }),
      disc('U224', { arrows: { '224_UPGRADE': true } }),
      disc('BOTH', { arrows: { '112_UPGRADE': true, '224_UPGRADE': true } }),
    ];
    const cands = selectKRBuyCandidates(res);
    expect(cands.map(c => c.symbol)).toEqual(['BOTH', 'U112', 'U224']);   // BOTH 최우선, 나머지 symbol 순
    expect(cands.find(c => c.symbol === 'ORIG')).toBeUndefined();
    expect(cands.find(c => c.symbol === 'LT')).toBeUndefined();
  });
  it('BOTH_UPGRADE 최우선 tier', () => {
    const cands = selectKRBuyCandidates([disc('B', { arrows: { '112_UPGRADE': true, '224_UPGRADE': true } })]);
    expect(cands[0].tier).toBe('BOTH_UPGRADE');
  });
  it('보유/pending/당일주문 종목은 재진입 금지(제외)', () => {
    const res = [disc('HELD', { arrows: { '112_UPGRADE': true } }), disc('PEND', { arrows: { '112_UPGRADE': true } }), disc('OK', { arrows: { '112_UPGRADE': true } })];
    const cands = selectKRBuyCandidates(res, { heldSymbols: new Set(['HELD']), pendingSymbols: new Set(['PEND']) });
    expect(cands.map(c => c.symbol)).toEqual(['OK']);
  });
  it('ready=false/reverse=false 는 제외(1차 미통과)', () => {
    expect(selectKRBuyCandidates([disc('X', { reverse: false, arrows: { '112_UPGRADE': true } })])).toHaveLength(0);
  });
});

describe('P0-33 krMasterFlags — A/B/C t8436 실필드 연결', () => {
  it('C: ETF/SPAC → isEtfEtnSpac=true', () => {
    expect(krMasterFlags({ shcode: '069500', hname: 'KODEX 200', etf: true, prevClose: 30000 }).isEtfEtnSpac).toBe(true);
    expect(krMasterFlags({ shcode: '123456', hname: '엔에이치스팩', prevClose: 2000 }).isEtfEtnSpac).toBe(true);
  });
  it('B: 우선주 → isCommonStock=false', () => {
    expect(krMasterFlags({ shcode: '005935', hname: '삼성전자우', prevClose: 50000 }).isCommonStock).toBe(false);
    expect(krMasterFlags({ shcode: '005930', hname: '삼성전자', prevClose: 60000 }).isCommonStock).toBe(true);
  });
  it('A: 전일종가<=0 → excluded=true(신규/거래정지 성격)', () => {
    expect(krMasterFlags({ shcode: '005930', hname: '삼성전자', prevClose: 0 }).excluded).toBe(true);
    expect(krMasterFlags({ shcode: '005930', hname: '삼성전자', prevClose: 60000 }).excluded).toBe(false);
  });
});

describe('P0-33 resolveKRExitPolicy — 전략값 사용자 결정 필요 + 비상손실 항상활성', () => {
  it('미설정 → pendingDecisions 에 손절/익절/보유일/미확인 표시, emergencyStop 기본 15', () => {
    const p = resolveKRExitPolicy({} as any);
    expect(p.stopLossPct).toBeNull();
    expect(p.takeProfitPct).toBeNull();
    expect(p.emergencyStopPct).toBe(15);
    expect(p.confirmed).toBe(false);
    expect(p.pendingDecisions.length).toBeGreaterThanOrEqual(4);
  });
  it('전부 설정 + 확인 → pendingDecisions 없음', () => {
    const p = resolveKRExitPolicy({ YEOKMAE_KR_STOP_LOSS_PCT: '5', YEOKMAE_KR_TAKE_PROFIT_PCT: '8', YEOKMAE_KR_MAX_HOLD_DAYS: '20', YEOKMAE_KR_EMERGENCY_STOP_PCT: '12', YEOKMAE_KR_EXIT_CONFIRMED: 'true' } as any);
    expect(p.stopLossPct).toBe(5); expect(p.takeProfitPct).toBe(8); expect(p.maxHoldDays).toBe(20);
    expect(p.emergencyStopPct).toBe(12); expect(p.confirmed).toBe(true);
    expect(p.pendingDecisions).toHaveLength(0);
  });
});
