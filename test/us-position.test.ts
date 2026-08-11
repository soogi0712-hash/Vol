import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  mergePositions, computeUSSellGate, computeRealizedPnL, positionPnlPct, PositionStore, sellRealOrderEnabled,
  programInvestedUSD, scanPendingBuyUSD, computeUSCapitalGuard,
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

describe('P0-31 총 운용자금(원화) 한도 — 다종목 분산매수', () => {
  const rate = 1400;   // LS 기준환율(고정 아님, 테스트용 값)
  it('programInvestedUSD — 프로그램관리(avgPrice!=null)만 원금집계, 수동보유(null) 제외', () => {
    const inv = programInvestedUSD([
      { qty: 1, avgPrice: 300 },     // 프로그램: 300
      { qty: 2, avgPrice: 15 },      // 프로그램: 30
      { qty: 5, avgPrice: null },    // 수동보유 → 제외
    ]);
    expect(inv).toBe(330);
  });
  it('scanPendingBuyUSD — us-orders-*.json 의 side=buy pending 합(계정레저 __ 제외)', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'us-pend-'));
    writeFileSync(join(dir2, 'us-orders-AAL.json'), JSON.stringify({ pending: [{ side: 'buy', qty: 1, price: 15 }] }));
    writeFileSync(join(dir2, 'us-orders-TSLA.json'), JSON.stringify({ pending: [{ side: 'buy', qty: 2, price: 20 }, { side: 'sell', qty: 1, price: 300 }] }));
    writeFileSync(join(dir2, 'us-orders-__account_events__.json'), JSON.stringify({ pending: [{ side: 'buy', qty: 99, price: 99 }] }));
    const r = scanPendingBuyUSD(dir2);
    expect(r.totalUSD).toBe(15 + 40);   // AAL 15 + TSLA 40 (sell 제외, __ 제외)
    expect(r.count).toBe(2);
    rmSync(dir2, { recursive: true, force: true });
  });
  it('한도 내 → 예산수량 그대로(OK)', () => {
    // limit 1,000,000 / rate 1400 → 714.3 USD 여유. invested 0, pending 0. 후보 $60×4주=240 < 714 → 4주 OK
    const g = computeUSCapitalGuard({ limitKRW: 1_000_000, investedUSD: 0, pendingUSD: 0, candidateQty: 4, bestAsk: 15, baseXchRate: rate });
    expect(g).toMatchObject({ finalQty: 4, canNewBuy: true, reason: 'OK' });
  });
  it('한도 근접 → 남은자금으로 수량 축소(REDUCED_TO_FIT_CAPITAL)', () => {
    // invested $650 → 910,000원. 남은 90,000원 = 64.3 USD. bestAsk 15 → 최대 4주. 후보 10주 → 4주로 축소
    const g = computeUSCapitalGuard({ limitKRW: 1_000_000, investedUSD: 650, pendingUSD: 0, candidateQty: 10, bestAsk: 15, baseXchRate: rate });
    expect(g.finalQty).toBe(4); expect(g.canNewBuy).toBe(true); expect(g.reason).toBe('REDUCED_TO_FIT_CAPITAL');
  });
  it('pending BUY 도 committed 에 포함 → 남은자금 차감', () => {
    // invested $600 + pending $60 = 660 → 924,000. 남은 76,000 = 54.3USD. bestAsk 15 → 3주
    const g = computeUSCapitalGuard({ limitKRW: 1_000_000, investedUSD: 600, pendingUSD: 60, candidateQty: 10, bestAsk: 15, baseXchRate: rate });
    expect(g.pendingKRW).toBe(84_000);
    expect(g.finalQty).toBe(3);
  });
  it('한도 소진(remaining<=0) → 신규 BUY 금지(CAPITAL_EXHAUSTED)', () => {
    const g = computeUSCapitalGuard({ limitKRW: 1_000_000, investedUSD: 720, pendingUSD: 0, candidateQty: 4, bestAsk: 15, baseXchRate: rate });
    expect(g.remainingKRW).toBeLessThanOrEqual(0);
    expect(g.canNewBuy).toBe(false); expect(g.reason).toBe('CAPITAL_EXHAUSTED');
  });
  it('1주도 못 사면 차단(CAPITAL_INSUFFICIENT_FOR_1SHARE)', () => {
    // 남은 10,000원=7.1USD, bestAsk 300 → 0주
    const g = computeUSCapitalGuard({ limitKRW: 1_000_000, investedUSD: 707, pendingUSD: 0, candidateQty: 1, bestAsk: 300, baseXchRate: rate });
    expect(g.canNewBuy).toBe(false); expect(g.reason).toBe('CAPITAL_INSUFFICIENT_FOR_1SHARE');
  });
  it('한도 미설정(null) → guard off(기존 동작, 수량 그대로)', () => {
    const g = computeUSCapitalGuard({ limitKRW: null, investedUSD: 999, pendingUSD: 0, candidateQty: 4, bestAsk: 15, baseXchRate: rate });
    expect(g.finalQty).toBe(4); expect(g.canNewBuy).toBe(true); expect(g.reason).toContain('UNSET');
  });
  it('환율 미확보(rate<=0) → 계산불가 차단(NO_XCHRATE)', () => {
    const g = computeUSCapitalGuard({ limitKRW: 1_000_000, investedUSD: 0, pendingUSD: 0, candidateQty: 4, bestAsk: 15, baseXchRate: 0 });
    expect(g.canNewBuy).toBe(false); expect(g.reason).toBe('NO_XCHRATE');
  });
  it('SELL 회수 후 원금 감소 → 운용가능금액 자동 회복(투자원금이 낮아지면 remaining 증가)', () => {
    const before = computeUSCapitalGuard({ limitKRW: 1_000_000, investedUSD: 700, pendingUSD: 0, candidateQty: 4, bestAsk: 15, baseXchRate: rate });
    const after = computeUSCapitalGuard({ limitKRW: 1_000_000, investedUSD: 300, pendingUSD: 0, candidateQty: 4, bestAsk: 15, baseXchRate: rate });
    expect(after.remainingKRW).toBeGreaterThan(before.remainingKRW);   // 원금 회수 → 여유 증가
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
