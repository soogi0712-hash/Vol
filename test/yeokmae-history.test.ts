import { describe, it, expect } from 'vitest';
import {
  normalizeDailyRows, validateDailyIntegrity, evaluateYeokmaeHistoryReadiness,
  isFieldMapConfirmed, EMPTY_DAILY_FIELD_MAP, YEOKMAE_RECOMMENDED_BARS,
  marketToday, isProvisionalDate, lastConfirmedDate, splitConfirmedProvisional,
  scanYeokmaeAtDate, compareHistoricalCount,
  YEOKMAE_MIN_BARS, type DailyFieldMap, type Candle,
} from '../src/lib/yeokmae';
import { insufficientSeries, reverseAlignmentSeries, brokenSeries, healthySeries } from '../src/lib/yeokmae/fixtures';

const GOOD_MAP: DailyFieldMap = { date: 'd', open: 'o', high: 'h', low: 'l', close: 'c', volume: 'v', turnover: null };

describe('P0-32B history — field-map fail-closed / 정규화', () => {
  it('field-map 미확정이면 normalize 실패(DAILY_FIELD_MAP_UNCONFIRMED)', () => {
    const r = normalizeDailyRows([{ d: '20230101', o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }], EMPTY_DAILY_FIELD_MAP);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('DAILY_FIELD_MAP_UNCONFIRMED');
    expect(isFieldMapConfirmed(EMPTY_DAILY_FIELD_MAP)).toBe(false);
  });
  it('확정 field-map → YYYYMMDD/YYYY-MM-DD 모두 정규화', () => {
    const r = normalizeDailyRows([
      { d: '20230101', o: '1', h: '2', l: '0.5', c: '1.5', v: '100' },
      { d: '2023-01-02', o: 1.5, h: 2.5, l: 1, c: 2, v: 200 },
    ], GOOD_MAP);
    expect(r.ok).toBe(true);
    expect(r.candles.map(c => c.date)).toEqual(['2023-01-01', '2023-01-02']);
    expect(r.candles[0].close).toBe(1.5);
    expect(r.candles[0].turnover).toBeNull();
  });
});

describe('P0-32B history — 무결성 검사', () => {
  it('정상 시계열 valid', () => {
    expect(validateDailyIntegrity(healthySeries(50)).valid).toBe(true);
  });
  it('high<low 위반 감지', () => {
    const r = validateDailyIntegrity(brokenSeries());
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('high<max') || e.includes('low>min'))).toBe(true);
  });
  it('중복 date / 역순 / 음수거래량 감지', () => {
    const bars = [
      { date: '2023-01-02', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { date: '2023-01-01', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },   // 역순
      { date: '2023-01-01', open: 1, high: 2, low: 0.5, close: 1.5, volume: -5 },   // 중복 + 음수
    ];
    const r = validateDailyIntegrity(bars);
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.startsWith('out-of-order'))).toBe(true);
    expect(r.errors.some(e => e.startsWith('dup date'))).toBe(true);
    expect(r.errors.some(e => e.startsWith('volume<0'))).toBe(true);
  });
});

describe('P0-32B history — readiness(600 hard / 700 warmup)', () => {
  it('600 미만 → sufficient=false', () => {
    const r = evaluateYeokmaeHistoryReadiness(insufficientSeries(300));
    expect(r.sufficient).toBe(false);
    expect(r.reason).toBe('INSUFFICIENT_HISTORY');
  });
  it('600~699 → sufficient=true, hasWarmup=false(OK_LOW_WARMUP)', () => {
    const r = evaluateYeokmaeHistoryReadiness(reverseAlignmentSeries(650));
    expect(r.has600).toBe(true);
    expect(r.hasWarmup).toBe(false);
    expect(r.sufficient).toBe(true);
    expect(r.reason).toBe('OK_LOW_WARMUP');
  });
  it('700+ → hasWarmup=true(OK)', () => {
    const r = evaluateYeokmaeHistoryReadiness(reverseAlignmentSeries(720));
    expect(r.hasWarmup).toBe(true);
    expect(r.reason).toBe('OK');
    expect(YEOKMAE_RECOMMENDED_BARS).toBe(700);
  });
  it('confirmedThrough 로 확정봉만 카운트', () => {
    const c = reverseAlignmentSeries(650);
    const cutoff = c[610].date;   // 611봉까지만 확정 → 600 미만이면 false
    const r = evaluateYeokmaeHistoryReadiness(c, cutoff);
    expect(r.confirmedBars).toBe(611);
    expect(r.has600).toBe(true);
  });
});

describe('P0-32B calendar — 시장 타임존 확정/진행 구분', () => {
  // 2023-06-15 12:00Z: 뉴욕 08:00, 서울 21:00 → 둘 다 같은 날짜(2023-06-15)
  const t = Date.UTC(2023, 5, 15, 12, 0, 0);
  it('marketToday — KR/US 현지 날짜', () => {
    expect(marketToday(t, 'US')).toBe('2023-06-15');
    expect(marketToday(t, 'KR')).toBe('2023-06-15');
  });
  it('UTC 자정 근처 — 서울은 다음날, 뉴욕은 전날', () => {
    // 2023-06-15 02:00Z: 서울 11:00(06-15), 뉴욕 22:00(06-14)
    const t2 = Date.UTC(2023, 5, 15, 2, 0, 0);
    expect(marketToday(t2, 'KR')).toBe('2023-06-15');
    expect(marketToday(t2, 'US')).toBe('2023-06-14');
  });
  it('isProvisionalDate / lastConfirmedDate / split', () => {
    expect(isProvisionalDate('2023-06-15', t, 'US')).toBe(true);
    expect(isProvisionalDate('2023-06-14', t, 'US')).toBe(false);
    const dates = ['2023-06-13', '2023-06-14', '2023-06-15'];
    expect(lastConfirmedDate(dates, t, 'US')).toBe('2023-06-14');   // 오늘(06-15)은 진행중 제외
    const split = splitConfirmedProvisional(dates.map(d => ({ date: d })), t, 'US');
    expect(split.confirmed.map(x => x.date)).toEqual(['2023-06-13', '2023-06-14']);
    expect(split.provisional?.date).toBe('2023-06-15');
  });
});

describe('P0-32B historical — 과거시점 스캐너 look-ahead 금지', () => {
  it('scanYeokmaeAtDate — date 이후 봉 미사용, 부족종목 insufficient 집계', () => {
    const full = healthySeries(720);
    const short = insufficientSeries(100);
    const uni = [
      { symbol: 'FULL', candles: full, flags: { excluded: false, isCommonStock: true, isEtfEtnSpac: false } },
      { symbol: 'SHORT', candles: short, flags: { excluded: false, isCommonStock: true, isEtfEtnSpac: false } },
    ];
    const midDate = full[400].date;   // 401봉까지만 → FULL 도 600 미만 → insufficient
    const r = scanYeokmaeAtDate(uni, midDate);
    expect(r.date).toBe(midDate);
    expect(r.insufficient).toBe(2);
    expect(r.evaluated).toBe(0);
    // 충분한 날짜
    const r2 = scanYeokmaeAtDate(uni, full[719].date);
    expect(r2.evaluated).toBe(1);       // FULL 만 평가
    expect(r2.insufficient).toBe(1);    // SHORT
    const fullRow = r2.perSymbol.find(p => p.symbol === 'FULL');
    expect(fullRow?.ready).toBe(true);
  });
  it('compareHistoricalCount — 차이 원인 구조화(튜닝 금지, adjustmentUnknown 시 정확일치 주장 불가)', () => {
    const cmp = compareHistoricalCount({ expected: 57, actual: 46, insufficientBars: 8, excludedUniverse: 3, adjustmentUnknown: true });
    expect(cmp.difference).toBe(-11);
    expect(cmp.insufficientBars).toBe(8);
    expect(cmp.adjustmentUnknown).toBe(true);
    expect(cmp.note).toContain('정확일치');
  });
});
