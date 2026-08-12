import { describe, it, expect } from 'vitest';
import { selectConfirmedBars, selectProvisionalBars } from '../local-runner/yeokmae/diag-select';

// P0-32E 회귀: 확정봉 날짜 off-by-one 수정.
// cache: 08-10 confirmed / 08-11 confirmed / 08-12 provisional
const CACHE = [
  { date: '2026-08-10', confirmed: true },
  { date: '2026-08-11', confirmed: true },
  { date: '2026-08-12', confirmed: false },
];
const PROVISIONAL_DATE = '2026-08-12';

describe('P0-32E diag 계산봉 선택 — off-by-one 수정', () => {
  it('confirmed 08-11 → 마지막 계산봉 08-11 (요청일=확정봉이면 그 날짜)', () => {
    const r = selectConfirmedBars(CACHE, '2026-08-11');
    expect(r.lastDate).toBe('2026-08-11');
    expect(r.bars.map(b => b.date)).toEqual(['2026-08-10', '2026-08-11']);
  });
  it('confirmed 08-10 → 마지막 계산봉 08-10', () => {
    const r = selectConfirmedBars(CACHE, '2026-08-10');
    expect(r.lastDate).toBe('2026-08-10');
    expect(r.bars.map(b => b.date)).toEqual(['2026-08-10']);
  });
  it('provisional → 08-12', () => {
    const r = selectProvisionalBars(CACHE, PROVISIONAL_DATE);
    expect(r.lastDate).toBe('2026-08-12');
    expect(r.bars.map(b => b.date)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
  });
  it('historical confirmed diag 08-11 에 08-12 look-ahead 없음', () => {
    const r = selectConfirmedBars(CACHE, '2026-08-11');
    expect(r.bars.some(b => b.date === '2026-08-12')).toBe(false);
  });
  it('요청일이 진행봉(08-12)이면 confirmed 는 직전 확정봉 08-11 까지만(진행봉 제외)', () => {
    const r = selectConfirmedBars(CACHE, '2026-08-12');
    expect(r.lastDate).toBe('2026-08-11');   // 08-12 는 confirmed=false → 제외
  });
  it('provisionalDate 없으면 provisional 집합은 비어있음(요청일 임의 진행봉화 금지)', () => {
    const r = selectProvisionalBars(CACHE, null);
    expect(r.bars).toEqual([]);
    expect(r.lastDate).toBeNull();
  });
});
