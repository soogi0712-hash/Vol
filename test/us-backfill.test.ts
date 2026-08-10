import { describe, it, expect } from 'vitest';
import {
  pickBackfillTarget, computeBackfillCapacity, computeBackfillDelta, BackfillStats,
  BACKFILL_MIN_CONFIRMED, BACKFILL_TARGET, type BackfillCand,
} from '../local-runner/us-backfill';
import { RealtimeCandleBuilder, evaluateReadiness, MIN_RT_CANDLES } from '../local-runner/ls-us-websocket';

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
  it('line — reqPerSec/requests/success/noNewUnique/empty/error 포맷', () => {
    const s = new BackfillStats();
    s.requests = 4; s.success = 2; s.noNewUnique = 1; s.empty = 1; s.error = 0;
    expect(s.line(1)).toBe('reqPerSec=1 requests=4 success=2 noNewUnique=1 empty=1 error=0');
  });
  it('초기값 0', () => {
    expect(new BackfillStats().line(1)).toBe('reqPerSec=1 requests=0 success=0 noNewUnique=0 empty=0 error=0');
  });
});

describe('P0-27 issue2 newUnique 계산(무한루프 방지 req1·2·5)', () => {
  it('반환 4행이 기존 timestamp 와 전부 중복 → newUnique=0, after=before (성공 아님)', () => {
    const existing = ['t1', 't2', 't3', 't4', 't5'];   // before=5
    const d = computeBackfillDelta(existing, ['t2', 't3', 't4', 't5']);   // 전부 중복
    expect(d.rawRows).toBe(4);
    expect(d.newUnique).toBe(0);
    expect(d.before).toBe(5);
    expect(d.after).toBe(5);   // 진전 없음 → 16→16 반복의 원인 (성공 카운트 금지)
  });
  it('continuation 으로 과거 unique 4개 추가 → 16→20 (READY 전환)', () => {
    const existing = Array.from({ length: 16 }, (_, i) => `n${String(i + 5).padStart(2, '0')}`);   // 최신 16개(n05..n20)
    const fetched = ['n01', 'n02', 'n03', 'n04', 'n05', 'n06'];   // 과거 4개(n01..n04) + 중복 2개(n05,n06)
    const d = computeBackfillDelta(existing, fetched);
    expect(d.before).toBe(16);
    expect(d.newUnique).toBe(4);   // n01..n04 만 신규
    expect(d.after).toBe(20);      // 16→20 → READY
  });
  it('fetched 내부 중복은 1회만 카운트', () => {
    const d = computeBackfillDelta(['a'], ['b', 'b', 'c', 'c', 'c']);
    expect(d.newUnique).toBe(2);   // b,c
  });
  it('빈 timestamp 문자열은 무시', () => {
    const d = computeBackfillDelta(['a'], ['', 'b', '']);
    expect(d.newUnique).toBe(1);
  });
  it('동일 페이지 반복 호출 → 매번 newUnique=0 (무한 진전 없음 감지)', () => {
    const existing = ['x1', 'x2', 'x3', 'x4'];
    for (let i = 0; i < 5; i++) {
      const d = computeBackfillDelta(existing, ['x1', 'x2', 'x3', 'x4']);
      expect(d.newUnique).toBe(0);   // 매 호출 진전 0 → 러너는 backoff 후 다음 종목으로 이동해야 함
    }
  });
});

// P0-27a req7: 백필 16→20→READY 전환을 실제 builder + readiness 로 결정적 재현(실계정 등가 증명).
describe('P0-27a 백필 16→20→READY 결정적 재현(req7)', () => {
  const c = (ts: string, px: number) => ({ datetime: ts, open: px, high: px, low: px, close: px, volume: 100 });
  const freshWs = (confirmedCount: number) => evaluateReadiness({
    websocketConnected: true, lastGSCatMs: 1_000, lastGSHatMs: 1_000,
    lastPrice: 200, bestBid: 199, bestAsk: 201, confirmedCount, storeCorrupted: false,
  }, 2_000);   // GSC/GSH 신선(1s 전)

  // 최신 16개 확정봉(HHMM 0505..0520) — 14자리 timestamp
  const have16 = () => Array.from({ length: 16 }, (_, i) => c(`202608101305${String(i).padStart(2, '0')}`, 10 + i));

  it('확정봉 16 → warmup(READY 아님), 백필로 과거 4봉 추가 → 20 → READY', () => {
    const b = new RealtimeCandleBuilder();
    const have = have16();   // 130500..130515
    b.seed(have);
    expect(b.confirmedCount).toBe(16);
    let r = freshWs(b.confirmedCount);
    expect(r.warmup).toBe(true); expect(r.ready).toBe(false);   // 확정봉<20 → 아직 아님

    // 백필: g3203 가 과거 4봉(130101..130104) + 중복 2봉(130500,130501) 반환 → newUnique=4
    const fetched = [
      c('20260810130101', 6), c('20260810130102', 7), c('20260810130103', 8), c('20260810130104', 9),
      c('20260810130500', have[0].close), c('20260810130501', have[1].close),   // 이미 보유(중복)
    ];
    const delta = computeBackfillDelta(have.map(x => x.datetime), fetched.map(x => x.datetime));
    expect(delta.rawRows).toBe(6);
    expect(delta.newUnique).toBe(4);   // ★ rawRows=6 이 아니라 newUnique=4 로 진전 판정
    expect(delta.after).toBe(20);

    b.seed(fetched);                    // 신규 unique 병합(중복 dedup) → 20
    expect(b.confirmedCount).toBe(20);
    r = freshWs(b.confirmedCount);
    expect(r.warmup).toBe(false); expect(r.ready).toBe(true);   // ★ 16→20 → READY 전환(가짜봉 없음)
    expect(b.confirmedCount).toBe(MIN_RT_CANDLES);
  });

  it('newUnique=0(전부 중복)면 confirmedCount 불변 → READY 전환 없음(무한 16 방지)', () => {
    const b = new RealtimeCandleBuilder();
    const have = have16();
    b.seed(have);
    const before = b.confirmedCount;
    const delta = computeBackfillDelta(have.map(x => x.datetime), have.map(x => x.datetime));   // 전부 중복
    expect(delta.newUnique).toBe(0);
    b.seed(have);   // dedup → 변화 없음
    expect(b.confirmedCount).toBe(before);   // 16 유지 → 러너는 backoff 후 다음 종목
  });
});
