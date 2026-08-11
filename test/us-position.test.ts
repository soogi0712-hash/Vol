import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergePositions, computeUSSellGate, computeRealizedPnL, positionPnlPct, PositionStore, sellRealOrderEnabled,
} from '../local-runner/us-position';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'us-pos-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('P0-30B computeUSSellGate — 청산 게이트(일일 횟수제한 없음)', () => {
  const base = { signalSell: true, holdingQty: 4, sellableQty: 4, pendingSell: false, hasOrderedSellCandle: false };
  it('실제 보유 4주 + SELL 신호 → sellQty=4, POST 허용', () => {
    expect(computeUSSellGate(base)).toMatchObject({ sellQty: 4, postAllowed: true, reason: 'OK' });
  });
  it('보유 0 → SELL 금지(NO_HOLDING)', () => {
    expect(computeUSSellGate({ ...base, holdingQty: 0, sellableQty: 0 })).toMatchObject({ postAllowed: false, reason: 'NO_HOLDING', sellQty: 0 });
  });
  it('pending SELL 존재 → 중복 POST 금지(PENDING_SELL_EXISTS)', () => {
    expect(computeUSSellGate({ ...base, pendingSell: true })).toMatchObject({ postAllowed: false, reason: 'PENDING_SELL_EXISTS' });
  });
  it('동일 candle 이미 매도 → 재POST 금지(DUPLICATE_CANDLE)', () => {
    expect(computeUSSellGate({ ...base, hasOrderedSellCandle: true })).toMatchObject({ postAllowed: false, reason: 'DUPLICATE_CANDLE' });
  });
  it('SELL 신호 없음 → NO_SELL_SIGNAL', () => {
    expect(computeUSSellGate({ ...base, signalSell: false })).toMatchObject({ postAllowed: false, reason: 'NO_SELL_SIGNAL' });
  });
  it('매도가능 < 보유(결제전 등) → sellQty=매도가능', () => {
    expect(computeUSSellGate({ ...base, holdingQty: 4, sellableQty: 2 })).toMatchObject({ sellQty: 2, postAllowed: true });
  });
  it('매도가능 0(보유는 있으나) → NO_SELLABLE_QTY', () => {
    expect(computeUSSellGate({ ...base, holdingQty: 4, sellableQty: 0 })).toMatchObject({ postAllowed: false, reason: 'NO_SELLABLE_QTY' });
  });
  it('SELL 은 일일 횟수 파라미터가 없다 — 몇 번을 팔았든 게이트에 영향 없음(청산 항상 가능)', () => {
    // 동일 입력이면 항상 동일 허용 — 횟수 상태가 아예 인자에 없음
    expect(computeUSSellGate(base).postAllowed).toBe(true);
    expect(computeUSSellGate(base).postAllowed).toBe(true);
  });
});

describe('P0-30D sellRealOrderEnabled — 실 SELL POST 게이트(코드상수 AND env AND 라이브)', () => {
  it('confirmed=true + sellLiveEnv=true + liveTrading=true → 허용', () => {
    expect(sellRealOrderEnabled({ confirmed: true, sellLiveEnv: true, liveTrading: true })).toBe(true);
  });
  it('LS_US_SELL_LIVE=false → 금지', () => {
    expect(sellRealOrderEnabled({ confirmed: true, sellLiveEnv: false, liveTrading: true })).toBe(false);
  });
  it('LS_LIVE_TRADING=false → 금지', () => {
    expect(sellRealOrderEnabled({ confirmed: true, sellLiveEnv: true, liveTrading: false })).toBe(false);
  });
  it('매도TR 미확인(confirmed=false) → 금지', () => {
    expect(sellRealOrderEnabled({ confirmed: false, sellLiveEnv: true, liveTrading: true })).toBe(false);
  });
});

describe('P0-30B computeRealizedPnL / positionPnlPct — gross(수수료·세금 미반영)', () => {
  it('실현손익 gross = (체결가-평단)×수량', () => {
    expect(computeRealizedPnL({ sellQty: 4, sellPrice: 110, avgBuyPrice: 100 })).toMatchObject({ gross: 40 });
  });
  it('avgPrice 미상(null) → 산출 불가(null, 추측 금지)', () => {
    expect(computeRealizedPnL({ sellQty: 4, sellPrice: 110, avgBuyPrice: null })).toEqual({ gross: null, pnlPct: null });
  });
  it('positionPnlPct — 평단 대비 현재가', () => {
    expect(positionPnlPct(100, 110)).toBeCloseTo(10);
    expect(positionPnlPct(null, 110)).toBeNull();
  });
});

describe('P0-30B mergePositions — 실계좌 holdings 진실원본 + 로컬 avgPrice', () => {
  it('실계좌 보유를 복원(프로그램이 산 것만이 아님) · avgPrice 는 우리 기록에서', () => {
    const known = new Map([['AAPL', { exchcd: '82', avgPrice: 305.5, aboveUpper: true }]]);
    const out = mergePositions(
      [{ symbol: 'AAPL', balQty: 4, sellableQty: 4 }, { symbol: 'TSLA', balQty: 2, sellableQty: 1 }],
      known, () => '82',
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ symbol: 'AAPL', qty: 4, sellableQty: 4, avgPrice: 305.5, aboveUpper: true });
    expect(out[1]).toMatchObject({ symbol: 'TSLA', qty: 2, sellableQty: 1, avgPrice: null, aboveUpper: false });   // 우리 기록 없음 → 미상
  });
  it('보유 0 종목은 제외', () => {
    expect(mergePositions([{ symbol: 'AAPL', balQty: 0, sellableQty: 0 }], new Map(), () => '82')).toHaveLength(0);
  });
});

describe('P0-30B PositionStore — 평단 가중평균 + 실현손익 원장 + 재시작 복원', () => {
  it('applyBuyFill 가중평균 평단', () => {
    const s = new PositionStore(dir);
    s.applyBuyFill('AAPL', '82', 2, 100);
    s.applyBuyFill('AAPL', '82', 2, 200);
    expect(s.getPosition('AAPL')).toMatchObject({ qty: 4, avgPrice: 150 });   // (2*100+2*200)/4
  });
  it('applySellFill — 보유 차감 + 당일 실현손익(gross) 누적, 전량매도 시 포지션 제거', () => {
    const s = new PositionStore(dir);
    s.applyBuyFill('AAPL', '82', 4, 100);
    s.applySellFill('AAPL', 4, 40, '20260811');   // gross +40
    expect(s.getPosition('AAPL')).toBeNull();       // 전량 → 제거
    expect(s.realizedToday('20260811')).toEqual({ gross: 40, sellCount: 1 });
  });
  it('부분매도 → 잔여수량 유지', () => {
    const s = new PositionStore(dir);
    s.applyBuyFill('AAPL', '82', 4, 100);
    s.applySellFill('AAPL', 1, 10, '20260811');
    expect(s.getPosition('AAPL')).toMatchObject({ qty: 3 });
  });
  it('flush 후 재시작 load → 평단/실현손익 복원', () => {
    const s1 = new PositionStore(dir);
    s1.applyBuyFill('AAPL', '82', 4, 100);
    s1.applySellFill('AAPL', 2, 20, '20260811');
    s1.flush();
    const s2 = new PositionStore(dir); s2.load();
    expect(s2.getPosition('AAPL')).toMatchObject({ qty: 2, avgPrice: 100 });
    expect(s2.realizedToday('20260811')).toEqual({ gross: 20, sellCount: 1 });
    expect(s2.knownMap().get('AAPL')).toMatchObject({ avgPrice: 100 });
  });
  it('syncQty — 실계좌 보유로 수량 동기화(0 이면 제거)', () => {
    const s = new PositionStore(dir);
    s.applyBuyFill('AAPL', '82', 4, 100);
    s.syncQty('AAPL', 3, 3);
    expect(s.getPosition('AAPL')).toMatchObject({ qty: 3, avgPrice: 100 });   // avgPrice 유지
    s.syncQty('AAPL', 0, 0);
    expect(s.getPosition('AAPL')).toBeNull();
  });
});
