import { describe, it, expect } from 'vitest';
import {
  computeHistoryCapacity, classifyUSCacheState, calDayDiff, needsFetch, reverseAlignmentAt,
} from '../local-runner/yeokmae/us-history-pool';
import { reverseAlignmentSeries, healthySeries, insufficientSeries } from '../src/lib/yeokmae/fixtures';

describe('P0-32F capacity/ETA', () => {
  it('callsNeeded = work × callsPerSymbol, reqPerSec = 1000/interval', () => {
    const cap = computeHistoryCapacity({ universeCount: 100, readyCount: 40, workCount: 60, callsPerSymbol: 3, minIntervalMs: 1100 });
    expect(cap.universe).toBe(100);
    expect(cap.cached).toBe(40);
    expect(cap.missing).toBe(60);
    expect(cap.callsNeeded).toBe(180);
    expect(cap.reqPerSec).toBeCloseTo(0.909, 2);
    expect(cap.etaSeconds).toBe(Math.round(180 / (1000 / 1100)));
    expect(cap.etaHuman).toMatch(/[hms]/);
  });
  it('work=0 → callsNeeded=0 ETA=0', () => {
    const cap = computeHistoryCapacity({ universeCount: 10, readyCount: 10, workCount: 0, callsPerSymbol: 3, minIntervalMs: 1100 });
    expect(cap.callsNeeded).toBe(0);
    expect(cap.etaSeconds).toBe(0);
  });
});

describe('P0-32F 캐시상태 분류(resume/증분)', () => {
  const today = '2026-08-12';
  it('MISSING / INSUFFICIENT / STALE / READY', () => {
    expect(classifyUSCacheState({ confirmedCount: 0, confirmedThrough: null, marketTodayYmd: today })).toBe('MISSING');
    expect(classifyUSCacheState({ confirmedCount: 500, confirmedThrough: '2026-08-11', marketTodayYmd: today })).toBe('INSUFFICIENT');   // <700
    expect(classifyUSCacheState({ confirmedCount: 800, confirmedThrough: '2026-08-01', marketTodayYmd: today })).toBe('STALE');          // 11일 경과
    expect(classifyUSCacheState({ confirmedCount: 800, confirmedThrough: '2026-08-11', marketTodayYmd: today })).toBe('READY');          // 1일 경과(<=3)
  });
  it('needsFetch — READY 만 skip(resume 근거)', () => {
    expect(needsFetch('READY')).toBe(false);
    expect(needsFetch('MISSING')).toBe(true);
    expect(needsFetch('INSUFFICIENT')).toBe(true);
    expect(needsFetch('STALE')).toBe(true);
  });
  it('calDayDiff — 캘린더 일수차(음수 0)', () => {
    expect(calDayDiff('2026-08-01', '2026-08-12')).toBe(11);
    expect(calDayDiff('2026-08-12', '2026-08-12')).toBe(0);
    expect(calDayDiff('2026-08-20', '2026-08-12')).toBe(0);   // 미래 → 0
  });
  it('minConfirmed/staleDays 조정 반영', () => {
    expect(classifyUSCacheState({ confirmedCount: 650, confirmedThrough: '2026-08-11', marketTodayYmd: today, minConfirmed: 600 })).toBe('READY');
    expect(classifyUSCacheState({ confirmedCount: 800, confirmedThrough: '2026-08-10', marketTodayYmd: today, staleDays: 1 })).toBe('STALE');
  });
});

describe('P0-32F 역배열 판정(1차 필터)', () => {
  it('단조하락(역배열) → reverse=true', () => {
    const ra = reverseAlignmentAt(reverseAlignmentSeries(720));
    expect(ra.ready).toBe(true);
    expect(ra.reverse).toBe(true);
    expect(ra.ema112).toBeLessThanOrEqual(ra.ema224);
    expect(ra.ema224).toBeLessThanOrEqual(ra.ema448);
  });
  it('상승추세 → reverse=false', () => {
    const ra = reverseAlignmentAt(healthySeries(720));
    expect(ra.ready).toBe(true);
    expect(ra.reverse).toBe(false);
  });
  it('600봉 미만 → ready=false(2차 계산 안 함)', () => {
    const ra = reverseAlignmentAt(insufficientSeries(300));
    expect(ra.ready).toBe(false);
    expect(ra.reverse).toBe(false);
  });
});
