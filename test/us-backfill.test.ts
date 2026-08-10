import { describe, it, expect } from 'vitest';
import {
  pickBackfillTarget, computeBackfillCapacity, BackfillStats,
  BACKFILL_MIN_CONFIRMED, BACKFILL_TARGET, type BackfillCand,
} from '../local-runner/us-backfill';

describe('P0-26 백필 대상 선정(요구 1·3·7)', () => {
  const mk = (symbol: string, confirmed: number, failedUntilMs = 0): BackfillCand => ({ symbol, confirmed, failedUntilMs });

  it('confirmed>=20 은 제외(이미 READY → 백필 불필요, 요구 1·3)', () => {
    const cands = [mk('AAPL', 104), mk('TSLA', 25), mk('BA', 20)];
    expect(pickBackfillTarget(cands, 1000)).toBeNull();   // 모두 READY → 대상 없음
  });

  it('20에 가장 가까운 종목 우선(적은 호출로 READY 도달, 요구 3)', () => {
    const cands = [mk('LO', 2), mk('HI', 18), mk('MID', 10)];
    expect(pickBackfillTarget(cands, 1000)).toBe('HI');   // confirmed=18 가 20 에 최근접
  });

  it('confirmed 동률 → 심볼 오름차순 tie-break(결정적)', () => {
    const cands = [mk('ZZZ', 15), mk('AAA', 15)];
    expect(pickBackfillTarget(cands, 1000)).toBe('AAA');
  });

  it('실패 백오프 중(failedUntil>now)이면 제외 → 다음 후보(요구 7)', () => {
    const cands = [mk('HI', 18, 9999), mk('MID', 10, 0)];
    expect(pickBackfillTarget(cands, 1000)).toBe('MID');   // HI 는 백오프 중 → 스킵
  });

  it('백오프 만료(failedUntil<=now)면 다시 후보', () => {
    const cands = [mk('HI', 18, 500)];
    expect(pickBackfillTarget(cands, 1000)).toBe('HI');    // 500 <= now(1000) → 만료
  });

  it('대상 없으면 null(빈 배열/전부 READY/전부 백오프)', () => {
    expect(pickBackfillTarget([], 1000)).toBeNull();
    expect(pickBackfillTarget([mk('X', 30)], 1000)).toBeNull();
    expect(pickBackfillTarget([mk('X', 5, 5000)], 1000)).toBeNull();
  });

  it('minConfirmed 상수 = 20', () => {
    expect(BACKFILL_MIN_CONFIRMED).toBe(20);
    expect(BACKFILL_TARGET).toBeGreaterThanOrEqual(BACKFILL_MIN_CONFIRMED);
  });
});

describe('P0-26 백필 용량 계산(요구 12·보고)', () => {
  it('g3203 비압축 5봉/요청 → 종목당 ceil(22/5)=5 호출', () => {
    const c = computeBackfillCapacity({ eligible: 5000, alreadyReady: 100, reqPerSec: 1 });
    expect(c.candlesPerRequest).toBe(5);
    expect(c.callsPerSymbol).toBe(5);          // ceil(22/5)
    expect(c.toBackfill).toBe(4900);
    expect(c.symbolsPerHour).toBe(Math.floor((1 * 3600) / 5));   // 720
    expect(c.symbolsPerHour).toBe(720);
    expect(c.hoursForAll).toBeCloseTo(4900 / 720, 3);
  });

  it('개인 1req/s: 10분(=600s) → 120종목 백필 가능', () => {
    const c = computeBackfillCapacity({ eligible: 5000, alreadyReady: 3, reqPerSec: 1 });
    const per10min = Math.floor((c.symbolsPerHour * 600) / 3600);
    expect(per10min).toBe(120);   // 720/시간 × (600/3600)
  });

  it('법인 10req/s → 10배 처리', () => {
    const c = computeBackfillCapacity({ eligible: 5000, alreadyReady: 0, reqPerSec: 10 });
    expect(c.symbolsPerHour).toBe(7200);   // 10*3600/5
  });

  it('alreadyReady>=eligible → toBackfill=0, hoursForAll=0', () => {
    const c = computeBackfillCapacity({ eligible: 30, alreadyReady: 30, reqPerSec: 1 });
    expect(c.toBackfill).toBe(0);
    expect(c.hoursForAll).toBe(0);
  });

  it('candlesPerRequest 커지면 호출수 감소', () => {
    const c = computeBackfillCapacity({ eligible: 100, alreadyReady: 0, reqPerSec: 1, candlesPerRequest: 22 });
    expect(c.callsPerSymbol).toBe(1);          // ceil(22/22)
    expect(c.symbolsPerHour).toBe(3600);
  });
});

describe('P0-26 백필 통계(요구 8)', () => {
  it('line — reqPerSec/requests/success/empty/error 포맷', () => {
    const s = new BackfillStats();
    s.requests = 3; s.success = 2; s.empty = 1; s.error = 0;
    expect(s.line(1)).toBe('reqPerSec=1 requests=3 success=2 empty=1 error=0');
  });
  it('초기값 0', () => {
    expect(new BackfillStats().line(1)).toBe('reqPerSec=1 requests=0 success=0 empty=0 error=0');
  });
});
