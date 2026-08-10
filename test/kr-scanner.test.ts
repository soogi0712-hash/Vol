import { describe, it, expect } from 'vitest';
import { RoundRobinScanner, ConfirmedCandleCache, passesPrefilter, rankBuyCandidates, bbBreakStrength, rsiReboundStrength, krConfirmedBucket } from '../local-runner/kr-scanner';
import { RateLimiter, computeScanCapacity } from '../local-runner/kr-rate-limiter';

describe('P0-22 라운드로빈 스캐너', () => {
  it('nextBatch — 순차 반환 + wrap + cycle 증가', () => {
    const s = new RoundRobinScanner(['A', 'B', 'C']);
    expect(s.nextBatch(2)).toEqual(['A', 'B']);
    expect(s.cycles).toBe(0);
    expect(s.nextBatch(2)).toEqual(['C', 'A']);   // wrap
    expect(s.cycles).toBe(1);
    expect(s.nextBatch(1)).toEqual(['B']);
  });
  it('빈 유니버스 → 빈 배치', () => {
    expect(new RoundRobinScanner([]).nextBatch(5)).toEqual([]);
  });
  it('P0-25 US WS 로테이션: 상시구독(AAPL/TSLA/BA)+로테이션 슬라이스 → batch1≠batch2, 상시구독 유지', () => {
    const alwaysOn = ['AAPL', 'TSLA', 'BA'];
    const rotationPool = ['S1', 'S2', 'S3', 'S4', 'S5'];   // 상시구독 제외 로테이션 대상
    const rotateBatchSize = 2;   // wsMaxSubs(5) - 상시(3)
    const scanner = new RoundRobinScanner(rotationPool);
    const makeBatch = () => [...alwaysOn, ...scanner.nextBatch(rotateBatchSize)];
    const batch1 = makeBatch();   // AAPL,TSLA,BA + S1,S2
    const batch2 = makeBatch();   // AAPL,TSLA,BA + S3,S4  ← 600s 후 전환
    expect(batch1).toEqual(['AAPL', 'TSLA', 'BA', 'S1', 'S2']);
    expect(batch2).toEqual(['AAPL', 'TSLA', 'BA', 'S3', 'S4']);   // ★ batch=2 로 실제 전환(로테이션 슬라이스 이동)
    // 상시구독은 두 배치 모두 유지
    for (const a of alwaysOn) { expect(batch1).toContain(a); expect(batch2).toContain(a); }
    expect(batch1.slice(3)).not.toEqual(batch2.slice(3));         // 로테이션 부분은 달라짐
  });
  it('setSymbols — 커서 범위 밖이면 0으로', () => {
    const s = new RoundRobinScanner(['A', 'B', 'C', 'D']);
    s.nextBatch(3);                 // cursor=3
    s.setSymbols(['X', 'Y']);       // 3 >= 2 → cursor=0
    expect(s.nextBatch(1)).toEqual(['X']);
  });
});

describe('P0-22 확정봉 캐시(요구 6)', () => {
  it('같은 종목·같은 확정봉은 1회만 평가', () => {
    const c = new ConfirmedCandleCache();
    expect(c.shouldEvaluate('A', '202608071030')).toBe(true);
    expect(c.shouldEvaluate('A', '202608071030')).toBe(false);   // 재평가 금지
    expect(c.shouldEvaluate('A', '202608071045')).toBe(true);    // 새 확정봉 → 재평가
    expect(c.shouldEvaluate('B', '202608071030')).toBe(true);    // 다른 종목
  });
  it('빈 확정봉 문자열 → 평가 안 함', () => {
    expect(new ConfirmedCandleCache().shouldEvaluate('A', '')).toBe(false);
  });
});

describe('P0-22 prefilter(요구 7) — 상위 N 컷 아님', () => {
  it('현재가/거래량/거래대금>0 + 미정지 → 통과', () => {
    expect(passesPrefilter({ lastPrice: 1000, volume: 100, tradingValue: 100000 })).toBe(true);
    expect(passesPrefilter({ lastPrice: 0, volume: 100, tradingValue: 0 })).toBe(false);
    expect(passesPrefilter({ lastPrice: 1000, volume: 0, tradingValue: 0 })).toBe(false);
    expect(passesPrefilter({ lastPrice: 1000, volume: 100, tradingValue: 100000, halted: true })).toBe(false);
  });
});

describe('P0-22 BUY 후보 순위(요구 9)', () => {
  it('거래대금 desc → 유동성 → BB강도 → RSI강도', () => {
    const ranked = rankBuyCandidates([
      { shcode: 'LOW', tradingValue: 100, volume: 10, bbBreakStrength: 0.1, rsiReboundStrength: 1 },
      { shcode: 'HIGH', tradingValue: 999, volume: 5, bbBreakStrength: 0.0, rsiReboundStrength: 0 },
      { shcode: 'MID', tradingValue: 500, volume: 7, bbBreakStrength: 0.2, rsiReboundStrength: 3 },
    ]);
    expect(ranked.map(c => c.shcode)).toEqual(['HIGH', 'MID', 'LOW']);
    expect(ranked[0].rank).toBe(1);
  });
  it('거래대금 동률 → 유동성 tie-break', () => {
    const ranked = rankBuyCandidates([
      { shcode: 'A', tradingValue: 100, volume: 5, bbBreakStrength: 0, rsiReboundStrength: 0 },
      { shcode: 'B', tradingValue: 100, volume: 9, bbBreakStrength: 0, rsiReboundStrength: 0 },
    ]);
    expect(ranked[0].shcode).toBe('B');
  });
  it('bbBreakStrength — 하단 이탈 깊이 + 복귀 가점', () => {
    expect(bbBreakStrength(90, 100, 100)).toBeGreaterThan(bbBreakStrength(98, 100, 100));  // 더 깊은 이탈
    expect(bbBreakStrength(90, 100, 100)).toBeGreaterThan(bbBreakStrength(90, 95, 100));   // 복귀(close>=lower) 가점
    expect(bbBreakStrength(90, 100, 0)).toBe(0);   // lower 무효
  });
  it('rsiReboundStrength — 과매도 저점 깊이 + 반등폭', () => {
    expect(rsiReboundStrength([40, 25, 35])).toBeGreaterThan(0);   // 저점25(과매도5) + 반등10
    expect(rsiReboundStrength([50])).toBe(0);
  });
});

describe('P0-22 rate limiter(요구 4)', () => {
  it('초당 reqPerSec 초과 시 대기(주입 clock)', async () => {
    let now = 0; const sleeps: number[] = [];
    const rl = new RateLimiter(2, { now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
    await rl.acquire(); await rl.acquire();   // 2건 즉시(윈도우 여유)
    expect(sleeps).toEqual([]);
    await rl.acquire();                        // 3번째 → 오래된것+1000ms 까지 대기
    expect(sleeps).toEqual([1000]);
    expect(rl.count).toBe(3);
  });
  it('reqPerSec=1 → 매 호출 1000ms 간격', async () => {
    let now = 0; const sleeps: number[] = [];
    const rl = new RateLimiter(1, { now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
    await rl.acquire(); await rl.acquire(); await rl.acquire();
    expect(sleeps).toEqual([1000, 1000]);
  });
});

describe('P0-22 스캔 용량 계산(요구 5·12·보고)', () => {
  it('개인 1/s, eligible 2000 → 15분 커버 불가(순환 2000s)', () => {
    const c = computeScanCapacity(2000, 1, 50, 900);
    expect(c.fullCycleSec).toBe(2000);
    expect(c.symbolsPerCandle).toBe(900);
    expect(c.coversWithinCandle).toBe(false);
  });
  it('법인 3/s, eligible 2000 → 15분 커버 가능(순환 667s)', () => {
    const c = computeScanCapacity(2000, 3, 50, 900);
    expect(c.fullCycleSec).toBe(667);
    expect(c.symbolsPerCandle).toBe(2700);
    expect(c.coversWithinCandle).toBe(true);
  });
});

describe('P0-22 KST 확정봉 버킷', () => {
  it('KST 09:47 → 확정봉 09:30 (직전 종료된 15분봉)', () => {
    // 2026-08-07 09:47 KST = 00:47 UTC
    const utc = Date.UTC(2026, 7, 7, 0, 47, 0);
    expect(krConfirmedBucket(utc)).toBe('202608070930');
  });
  it('KST 09:00 → 확정봉 08:45', () => {
    const utc = Date.UTC(2026, 7, 7, 0, 0, 0);   // 09:00 KST
    expect(krConfirmedBucket(utc)).toBe('202608070845');
  });
  it('같은 15분 구간 내 여러 시각은 같은 버킷', () => {
    const a = krConfirmedBucket(Date.UTC(2026, 7, 7, 1, 31, 0));   // 10:31 KST
    const b = krConfirmedBucket(Date.UTC(2026, 7, 7, 1, 44, 0));   // 10:44 KST
    expect(a).toBe(b);   // 둘 다 확정봉 10:15
    expect(a).toBe('202608071015');
  });
});
