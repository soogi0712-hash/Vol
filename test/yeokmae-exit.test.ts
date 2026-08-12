import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateYeokmaeExit, computeYeokmaeSellQty, updateHighestPrice, DEFAULT_YEOKMAE_EXIT_CONFIG,
  bbSellAppliesTo, yeokmaeSellAppliesTo, YEOKMAE_SOURCE_BASED_SELL, YEOKMAE_AUTOMATION_RISK_POLICY,
  type YeokmaeExitConfig, type YeokmaeExitState,
} from '../src/lib/yeokmae';
import { YeokmaePositionStore } from '../local-runner/yeokmae-position-store';

const CFG: YeokmaeExitConfig = { ...DEFAULT_YEOKMAE_EXIT_CONFIG };   // stop5 tp8 mode FIXED trail(5,3) hold20
const q = (price: number, reliable = true) => ({ reliableRealtime: reliable, price, bestBid: price });
const st = (o: Partial<YeokmaeExitState> = {}): YeokmaeExitState => ({ entryAvgPrice: 100, qty: 10, highestPrice: 100, holdDays: 0, ...o });

describe('P0-34 자료기반 SELL 분리 상수', () => {
  it('SOURCE_BASED_SELL=NONE, AUTOMATION_RISK_POLICY=P0-34', () => {
    expect(YEOKMAE_SOURCE_BASED_SELL).toBe('NONE');
    expect(YEOKMAE_AUTOMATION_RISK_POLICY).toBe('P0-34');
  });
});

describe('P0-34 손절/익절(FIXED)', () => {
  it('-4.9% → HOLD', () => expect(evaluateYeokmaeExit({ state: st(), config: CFG, quote: q(95.1) }).action).toBe('HOLD'));
  it('-5.0% → STOP_LOSS', () => {
    const d = evaluateYeokmaeExit({ state: st(), config: CFG, quote: q(95) });
    expect(d.action).toBe('SELL'); expect(d.reason).toBe('STOP_LOSS');
  });
  it('+7.9% → HOLD', () => expect(evaluateYeokmaeExit({ state: st({ highestPrice: 107.9 }), config: CFG, quote: q(107.9) }).action).toBe('HOLD'));
  it('+8.0% → TAKE_PROFIT(FIXED)', () => {
    const d = evaluateYeokmaeExit({ state: st({ highestPrice: 108 }), config: CFG, quote: q(108) });
    expect(d.action).toBe('SELL'); expect(d.reason).toBe('TAKE_PROFIT');
  });
});

describe('P0-34 trailing(TRAILING 모드)', () => {
  const T: YeokmaeExitConfig = { ...CFG, profitMode: 'TRAILING' };   // activate5 drawdown3
  it('activate 미도달(+4%) → HOLD', () => {
    const d = evaluateYeokmaeExit({ state: st({ highestPrice: 104 }), config: T, quote: q(104) });
    expect(d.action).toBe('HOLD');
  });
  it('activate 후 drawdown 미달 → HOLD (최고 +7%, 현재 +5% 되돌림 1.87%<3%)', () => {
    // highest 107, price 105 → drawdown=(107-105)/107=1.87%
    const d = evaluateYeokmaeExit({ state: st({ highestPrice: 107 }), config: T, quote: q(105) });
    expect(d.action).toBe('HOLD');
  });
  it('activate 후 drawdown 도달 → TRAILING_STOP (최고 +10%, -4% 되돌림)', () => {
    // highest 110, price 105.6 → drawdown=(110-105.6)/110=4%>=3
    const d = evaluateYeokmaeExit({ state: st({ highestPrice: 110 }), config: T, quote: q(105.6) });
    expect(d.action).toBe('SELL'); expect(d.reason).toBe('TRAILING_STOP');
  });
  it('FIXED 모드에선 trailing 미발동', () => {
    const d = evaluateYeokmaeExit({ state: st({ highestPrice: 110 }), config: CFG, quote: q(105.6) });
    expect(d.reason).not.toBe('TRAILING_STOP');
  });
});

describe('P0-34 시간청산(MAX_HOLD_DAYS)', () => {
  it('20일 미만 → 시간청산 없음', () => {
    const d = evaluateYeokmaeExit({ state: st({ holdDays: 19 }), config: CFG, quote: q(99) });
    expect(d.action).toBe('HOLD');
  });
  it('20일 + pnl<=0 → MAX_HOLD_DAYS', () => {
    const d = evaluateYeokmaeExit({ state: st({ holdDays: 20 }), config: CFG, quote: q(99) });
    expect(d.action).toBe('SELL'); expect(d.reason).toBe('MAX_HOLD_DAYS');
  });
  it('20일 + pnl>0 → 시간청산 안 함(HOLD)', () => {
    const d = evaluateYeokmaeExit({ state: st({ holdDays: 30, highestPrice: 104 }), config: CFG, quote: q(103) });
    expect(d.action).toBe('HOLD');
  });
});

describe('P0-34 우선순위 & 단일 SELL', () => {
  it('STOP_LOSS 가 TAKE_PROFIT/MAX_HOLD 보다 우선(동시성립 불가하지만 stop 최우선)', () => {
    // -6% 손절 + 20일 → STOP_LOSS
    const d = evaluateYeokmaeExit({ state: st({ holdDays: 30 }), config: CFG, quote: q(94) });
    expect(d.reason).toBe('STOP_LOSS');
  });
  it('SAFETY_FORCED 가 TAKE_PROFIT 보다 우선', () => {
    const d = evaluateYeokmaeExit({ state: st({ highestPrice: 108 }), config: CFG, quote: q(108), safetyForcedExit: true });
    expect(d.reason).toBe('SAFETY_FORCED_EXIT');
  });
  it('structure invalidation 은 OBSERVE_ONLY (SELL 아님)', () => {
    const d = evaluateYeokmaeExit({ state: st({ structureInvalidated: true }), config: CFG, quote: q(99) });
    expect(d.action).toBe('HOLD');
    expect(d.triggers.structureInvalidation).toBe(true);
    expect(d.structureObserveOnly).toBe(true);
  });
});

describe('P0-34 stale quote / 수량', () => {
  it('stale/미신뢰 quote → SELL POST 금지(NO_QUOTE)', () => {
    const d = evaluateYeokmaeExit({ state: st(), config: CFG, quote: q(80, false) });   // -20% 여도 미신뢰
    expect(d.action).toBe('NO_QUOTE'); expect(d.reason).toBeNull();
  });
  it('price<=0 → NO_QUOTE', () => {
    expect(evaluateYeokmaeExit({ state: st(), config: CFG, quote: q(0) }).action).toBe('NO_QUOTE');
  });
  it('sellQty = min(program, freshSellable), 축소/0', () => {
    expect(computeYeokmaeSellQty({ programManagedQty: 10, freshSellableQty: 4 })).toBe(4);
    expect(computeYeokmaeSellQty({ programManagedQty: 10, freshSellableQty: 0 })).toBe(0);
    expect(computeYeokmaeSellQty({ programManagedQty: 3, freshSellableQty: 10 })).toBe(3);
  });
  it('updateHighestPrice', () => {
    expect(updateHighestPrice(100, 105)).toBe(105);
    expect(updateHighestPrice(110, 105)).toBe(110);
  });
});

describe('P0-34 전략 SELL 분리(dispatch)', () => {
  it('YEOKMAE 포지션에 BB SELL 미적용', () => {
    expect(bbSellAppliesTo('YEOKMAE')).toBe(false);
    expect(bbSellAppliesTo('LEGACY_BB')).toBe(true);
    expect(bbSellAppliesTo('UNKNOWN')).toBe(true);
  });
  it('LEGACY_BB 포지션에 YEOKMAE SELL 미적용', () => {
    expect(yeokmaeSellAppliesTo('LEGACY_BB')).toBe(false);
    expect(yeokmaeSellAppliesTo('UNKNOWN')).toBe(false);
    expect(yeokmaeSellAppliesTo('YEOKMAE')).toBe(true);
  });
});

describe('P0-34 포지션 store 영구화/복원', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'yk-pos-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('진입/최고가 저장 후 재시작 복원', () => {
    const s1 = new YeokmaePositionStore(dir); s1.load();
    s1.applyYeokmaeBuyFill({ symbol: 'ABC', exchcd: '82', entryDate: '2026-08-11', fillQty: 5, fillPrice: 100 });
    s1.updateHighest('ABC', 112);
    s1.setHoldDays('ABC', 7);
    s1.flush();
    const s2 = new YeokmaePositionStore(dir); s2.load();
    const p = s2.get('ABC')!;
    expect(p.strategyTag).toBe('YEOKMAE');
    expect(p.entryAvgPrice).toBe(100);
    expect(p.qty).toBe(5);
    expect(p.highestPrice).toBe(112);
    expect(p.highestPnlPct).toBeCloseTo(12, 5);
    expect(p.holdDays).toBe(7);
    expect(p.stopLossPct).toBe(5.0);
    expect(p.profitMode).toBe('FIXED');
  });
  it('가중평균 진입가', () => {
    const s = new YeokmaePositionStore(dir); s.load();
    s.applyYeokmaeBuyFill({ symbol: 'X', exchcd: '82', entryDate: '2026-08-11', fillQty: 2, fillPrice: 100 });
    s.applyYeokmaeBuyFill({ symbol: 'X', exchcd: '82', entryDate: '2026-08-11', fillQty: 2, fillPrice: 200 });
    expect(s.get('X')!.entryAvgPrice).toBe(150);
    expect(s.get('X')!.qty).toBe(4);
  });
  it('recordExit — lastExitReason 저장 + 전량 제거', () => {
    const s = new YeokmaePositionStore(dir); s.load();
    s.applyYeokmaeBuyFill({ symbol: 'X', exchcd: '82', entryDate: '2026-08-11', fillQty: 5, fillPrice: 100 });
    s.recordExit('X', 'STOP_LOSS', 0);
    expect(s.get('X')).toBeNull();
  });
});
