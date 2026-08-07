import { describe, it, expect } from 'vitest';
import { evaluateTradeGate, canExecuteLive, isUSRegularSession, etWallClock, etDateStr, isKRRegularSession, krDateStr, GATE, type GateState } from '../local-runner/trade-gate';

// 미국 정규장 09:30~16:00 America/New_York 판정용 — UTC epoch 헬퍼.
// (ET 벽시계를 특정하려면 UTC 로 준다. EDT=UTC-4, 여름 기준.)
const utc = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi);

describe('미국 정규장 판정 (America/New_York)', () => {
  it('여름(EDT) 평일 13:30 UTC = 09:30 ET → 개장', () => {
    // 2026-07-06(월) 13:30 UTC = 09:30 EDT
    expect(isUSRegularSession(utc(2026, 7, 6, 13, 30))).toBe(true);
  });
  it('여름 평일 13:29 UTC = 09:29 ET → 개장 전', () => {
    expect(isUSRegularSession(utc(2026, 7, 6, 13, 29))).toBe(false);
  });
  it('여름 평일 20:00 UTC = 16:00 ET → 폐장(경계 제외)', () => {
    expect(isUSRegularSession(utc(2026, 7, 6, 20, 0))).toBe(false);
    expect(isUSRegularSession(utc(2026, 7, 6, 19, 59))).toBe(true);
  });
  it('겨울(EST) 평일 14:30 UTC = 09:30 ET → 개장(서머타임 자동)', () => {
    // 2026-01-05(월) 14:30 UTC = 09:30 EST
    expect(isUSRegularSession(utc(2026, 1, 5, 14, 30))).toBe(true);
    expect(isUSRegularSession(utc(2026, 1, 5, 14, 29))).toBe(false);
  });
  it('주말은 폐장', () => {
    expect(isUSRegularSession(utc(2026, 7, 4, 14, 0))).toBe(false);   // 토
    expect(isUSRegularSession(utc(2026, 7, 5, 14, 0))).toBe(false);   // 일
  });
  it('etDateStr 는 ET 기준 날짜 — 자정 근처 UTC 가 전날 ET', () => {
    // 2026-07-07 02:00 UTC = 2026-07-06 22:00 EDT
    expect(etDateStr(utc(2026, 7, 7, 2, 0))).toBe('20260706');
    expect(etWallClock(utc(2026, 7, 6, 13, 30)).minutes).toBe(9 * 60 + 30);
  });
});

describe('국내장 세션 (Asia/Seoul 09:00~15:30)', () => {
  // KST = UTC+9(서머타임 없음). 09:00 KST = 00:00 UTC.
  it('평일 09:00 KST(00:00 UTC) → 개장, 08:59 → 개장 전', () => {
    expect(isKRRegularSession(utc(2026, 8, 7, 0, 0))).toBe(true);    // 금 09:00 KST
    expect(isKRRegularSession(utc(2026, 8, 6, 23, 59))).toBe(false); // 목 08:59 KST(전날 UTC)
  });
  it('평일 15:30 KST(06:30 UTC) → 폐장(경계 제외), 15:29 → 개장', () => {
    expect(isKRRegularSession(utc(2026, 8, 7, 6, 30))).toBe(false);
    expect(isKRRegularSession(utc(2026, 8, 7, 6, 29))).toBe(true);
  });
  it('주말 폐장', () => {
    expect(isKRRegularSession(utc(2026, 8, 8, 3, 0))).toBe(false);   // 토 12:00 KST
    expect(isKRRegularSession(utc(2026, 8, 9, 3, 0))).toBe(false);   // 일
  });
  it('krDateStr — KST 날짜 (UTC 자정 근처는 다음날 KST)', () => {
    expect(krDateStr(utc(2026, 8, 6, 16, 0))).toBe('20260807');     // 목 16:00 UTC = 금 01:00 KST
  });
});

// 정규장 시간(여름 평일 09:30 ET)로 고정한 기준 상태
const NOW = utc(2026, 7, 6, 14, 0);   // 10:00 ET
const good = (over: Partial<GateState> = {}): GateState => ({
  confirmedCount: 20, signalAction: 'BUY', wsConnected: true, gscAgeSec: 10, gshAgeSec: 5,
  bid: 99, ask: 101, lastPrice: 100, nowMs: NOW, orderableQtyOk: true,
  duplicateCandleOrdered: false, hasPendingOrder: false, ...over,
});

describe('10개 필수조건 게이트', () => {
  it('전부 충족 → armed=true, 통과 10', () => {
    const g = evaluateTradeGate(good());
    expect(g.armed).toBe(true);
    expect(g.passed.length).toBe(10);
    expect(g.blockedBy).toEqual([]);
  });
  const cases: Array<[string, Partial<GateState>, string]> = [
    ['confirmed<20', { confirmedCount: 19 }, `confirmed>=${GATE.MIN_CONFIRMED}`],
    ['signal!=BUY', { signalAction: 'HOLD' }, 'signal=BUY'],
    ['WS 끊김', { wsConnected: false }, 'wsConnected'],
    ['GSC 301s', { gscAgeSec: 301 }, `GSC<=${GATE.GSC_FRESH_S}s`],
    ['GSH 31s', { gshAgeSec: 31 }, `GSH<=${GATE.GSH_FRESH_S}s`],
    ['bid 0', { bid: 0 }, 'bid/ask/last>0'],
    ['주문가능 실패', { orderableQtyOk: false }, '주문가능수량 조회성공'],
    ['동일봉 중복', { duplicateCandleOrdered: true }, '동일봉 중복주문 없음'],
    ['미체결 존재', { hasPendingOrder: true }, '미체결 없음'],
  ];
  for (const [name, over, blocked] of cases) {
    it(`${name} → armed=false, blockedBy 포함`, () => {
      const g = evaluateTradeGate(good(over));
      expect(g.armed).toBe(false);
      expect(g.blockedBy).toContain(blocked);
    });
  }
  it('정규장 아님(주말) → armed=false', () => {
    const g = evaluateTradeGate(good({ nowMs: utc(2026, 7, 4, 14, 0) }));
    expect(g.armed).toBe(false);
    expect(g.blockedBy).toContain('정규장(NY 09:30-16:00)');
  });
  it('gscAgeSec=null(미수신) → armed=false', () => {
    expect(evaluateTradeGate(good({ gscAgeSec: null })).armed).toBe(false);
  });
});

describe('canExecuteLive — 실주문은 삼중 차단', () => {
  it('armed 여도 LIVE=false 면 실행 불가', () => {
    const r = canExecuteLive(true, false, true);
    expect(r.execute).toBe(false);
    expect(r.reason).toMatch(/LS_LIVE_TRADING=false/);
  });
  it('armed + LIVE=true + env취소확인=true 여도 코드 상수(LS_CANCEL_TR_CONFIRMED=false)면 실행 불가', () => {
    const r = canExecuteLive(true, true, true);
    expect(r.execute).toBe(false);   // 코드 상수가 최종 안전장치
    expect(r.reason).toMatch(/COSAT00311|취소/);
  });
  it('env 취소확인=false 면(코드 상수와 무관하게) 실행 불가', () => {
    expect(canExecuteLive(true, true, false).execute).toBe(false);
  });
  it('armed=false 면 무조건 실행 불가', () => {
    expect(canExecuteLive(false, true, true).execute).toBe(false);
  });
});
