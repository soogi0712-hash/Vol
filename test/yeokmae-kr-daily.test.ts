import { describe, it, expect } from 'vitest';
import {
  normalizeDailyRows, estimateTurnoverUnit,
  marketToday, marketSessionClosed, isConfirmedBar,
} from '../src/lib/yeokmae';
import { KR_DAILY_TR } from '../local-runner/yeokmae/daily-tr-config';

// P0-32C probe 실측 샘플행(삼성전자 t8413 OutBlock1)
const KR_SAMPLE = {
  date: '20250708', open: 61600, high: 62400, low: 61000, close: 61400,
  jdiff_vol: 20213724, value: 1243103, jongchk: 0, rate: '0.00', pricechk: 0, ratevalue: 0, sign: '5',
};

describe('P0-32C KR field map — 실측 샘플 정규화', () => {
  it('t8413 실측행 → OHLCV + rawTurnover(value) 매핑', () => {
    const r = normalizeDailyRows([KR_SAMPLE], KR_DAILY_TR.fieldMap);
    expect(r.ok).toBe(true);
    const c = r.candles[0];
    expect(c.date).toBe('2025-07-08');        // YYYYMMDD → YYYY-MM-DD
    expect(c.open).toBe(61600);
    expect(c.high).toBe(62400);
    expect(c.low).toBe(61000);
    expect(c.close).toBe(61400);
    expect(c.volume).toBe(20213724);           // jdiff_vol
    expect(c.turnover).toBe(1243103);          // value(raw, 단위 미단정)
  });
});

describe('P0-32C 거래대금 value 단위 실측 추정', () => {
  it('close×volume ÷ value ≈ 1e6 → 백만원 추정(단정 아님)', () => {
    const est = estimateTurnoverUnit([{ close: 61400, volume: 20213724, rawTurnover: 1243103 }]);
    expect(est.samples).toBe(1);
    // 61400*20213724 / 1243103 = 998,406 ≈ 1e6
    expect(est.medianMultiplier).toBeGreaterThan(5e5);
    expect(est.medianMultiplier).toBeLessThan(5e6);
    expect(est.guessLabel).toContain('MILLION_KRW');
  });
  it('rawTurnover 없으면 UNKNOWN', () => {
    const est = estimateTurnoverUnit([{ close: 100, volume: 10, rawTurnover: null }]);
    expect(est.samples).toBe(0);
    expect(est.guessLabel).toBe('UNKNOWN');
  });
});

describe('P0-32C 오늘 진행봉 분리 — 장중 PROVISIONAL / 종료후 CONFIRMED 승격', () => {
  // 2026-08-12 KST. 장중(예: 05:00Z=14:00 KST) vs 종료후(08:00Z=17:00 KST)
  const intraday = Date.UTC(2026, 7, 12, 5, 0, 0);   // 14:00 KST (15:30 마감 전)
  const afterClose = Date.UTC(2026, 7, 12, 8, 0, 0);  // 17:00 KST (16:00 이후)
  it('marketToday KR', () => {
    expect(marketToday(intraday, 'KR')).toBe('2026-08-12');
  });
  it('장중: 오늘 봉은 미확정(PROVISIONAL)', () => {
    expect(marketSessionClosed(intraday, 'KR')).toBe(false);
    expect(isConfirmedBar('2026-08-12', intraday, 'KR')).toBe(false);   // 오늘=진행봉
    expect(isConfirmedBar('2026-08-11', intraday, 'KR')).toBe(true);    // 전 거래일=확정
  });
  it('장 종료 후: 오늘 봉 CONFIRMED 승격', () => {
    expect(marketSessionClosed(afterClose, 'KR')).toBe(true);
    expect(isConfirmedBar('2026-08-12', afterClose, 'KR')).toBe(true);
  });
  it('미래 date 는 확정 아님', () => {
    expect(isConfirmedBar('2026-08-13', afterClose, 'KR')).toBe(false);
  });
  it('US 정규장 종료(16:30 ET) 기준 승격', () => {
    // 2026-06-15 21:00Z = 17:00 ET (16:30 이후) → 종료
    const usAfter = Date.UTC(2026, 5, 15, 21, 0, 0);
    const usIntraday = Date.UTC(2026, 5, 15, 18, 0, 0);   // 14:00 ET
    expect(marketSessionClosed(usAfter, 'US')).toBe(true);
    expect(marketSessionClosed(usIntraday, 'US')).toBe(false);
  });
});
