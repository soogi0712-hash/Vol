import { describe, it, expect } from 'vitest';
import {
  clampKisInputHourKST, minusOneMinuteHHMMSS, bucketStart, aggregateTo15Min, collectKR15Min,
} from '../src/lib/kr-candles';
import type { Candle } from '../src/lib/kis-api';

// KST(y,mo,d,hh,mm,ss) → epoch ms  (UTC = KST-9h)
const kstMs = (y: number, mo: number, d: number, hh: number, mm: number, ss = 0) =>
  Date.UTC(y, mo, d, hh - 9, mm, ss);

const c1 = (ts: string, o: number, h: number, l: number, cl: number, v = 10): Candle =>
  ({ ticker: '005930', market: 'KR', datetime: ts, open: o, high: h, low: l, close: cl, volume: v });

// 20260105(월) 09:00~09:00+n분 1분봉 생성 (close=100+i 로 구분)
function oneMinRange(startMin: number, count: number): Candle[] {
  const bars: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const total = 9 * 60 + startMin + i;          // 자정 기준 분
    const hh = Math.floor(total / 60), mm = total % 60;
    const ts = `20260105${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}00`;
    const base = startMin + i;
    bars.push(c1(ts, 100 + base, 100 + base + 0.5, 100 + base - 0.5, 100 + base, 10));
  }
  return bars;
}

describe('clampKisInputHourKST — 미래 시각 미발생', () => {
  it('09:00 이전 → 090000', () => {
    expect(clampKisInputHourKST(kstMs(2026, 0, 5, 8, 30))).toBe('090000');
  });
  it('장중 → 현재 HHMMSS', () => {
    expect(clampKisInputHourKST(kstMs(2026, 0, 5, 10, 7, 5))).toBe('100705');
  });
  it('15:30 이후 → 153000', () => {
    expect(clampKisInputHourKST(kstMs(2026, 0, 5, 16, 0))).toBe('153000');
    expect(clampKisInputHourKST(kstMs(2026, 0, 5, 15, 30, 0))).toBe('153000');
  });
});

describe('minusOneMinuteHHMMSS / bucketStart', () => {
  it('1분 감소(초 00 정규화, 시 borrow)', () => {
    expect(minusOneMinuteHHMMSS('093000')).toBe('092900');
    expect(minusOneMinuteHHMMSS('100000')).toBe('095900');
  });
  it('버킷 시작: 09:00~15:29 만 유효, 15:30↑ 및 09:00↓ 은 null', () => {
    expect(bucketStart('20260105090000')).toBe('20260105090000');
    expect(bucketStart('20260105091412')).toBe('20260105090000');
    expect(bucketStart('20260105091500')).toBe('20260105091500');
    expect(bucketStart('20260105151959')).toBe('20260105151500');
    expect(bucketStart('20260105153000')).toBeNull();   // 15:30 단독봉 금지
    expect(bucketStart('20260105085900')).toBeNull();
  });
});

describe('aggregateTo15Min', () => {
  it('OHLCV 규칙 + 진행봉 분리', () => {
    const bars = oneMinRange(0, 50);   // 09:00~09:49
    const { completed, inProgress } = aggregateTo15Min(bars, kstMs(2026, 0, 5, 9, 50));
    // 완성: 0900,0915,0930 (end ≤ 09:50). 진행: 0945 (end 10:00 > 09:50)
    expect(completed.map(b => b.datetime)).toEqual(['20260105090000', '20260105091500', '20260105093000']);
    expect(inProgress?.datetime).toBe('20260105094500');
    const b0900 = completed[0];
    expect(b0900.open).toBe(100);          // 09:00 시가
    expect(b0900.close).toBe(114);         // 09:14 종가
    expect(b0900.high).toBe(114.5);        // max
    expect(b0900.low).toBe(99.5);          // min
    expect(b0900.volume).toBe(150);        // 15 × 10
  });

  it('timestamp 중복 제거', () => {
    const bars = [...oneMinRange(0, 15), ...oneMinRange(0, 15)];  // 완전 중복
    const { completed } = aggregateTo15Min(bars, kstMs(2026, 0, 5, 9, 30));
    expect(completed).toHaveLength(1);
    expect(completed[0].volume).toBe(150);   // 중복 합산 안 됨
  });

  it('저유동(버킷당 1봉)도 윈도우 경과 시 완성으로 인정', () => {
    const bars = [c1('20260105090000', 100, 100, 100, 100)];
    const { completed } = aggregateTo15Min(bars, kstMs(2026, 0, 5, 9, 20));
    expect(completed).toHaveLength(1);       // 15행 미만이라고 폐기하지 않음
  });

  it('15:30 스탬프는 단독 봉을 만들지 않는다', () => {
    const bars = [c1('20260105152959', 100, 101, 99, 100), c1('20260105153000', 100, 101, 99, 100)];
    const { completed, inProgress } = aggregateTo15Min(bars, kstMs(2026, 0, 5, 16, 0));
    const all = [...completed, ...(inProgress ? [inProgress] : [])].map(b => b.datetime);
    expect(all).toContain('20260105151500');       // 15:29:59 → 15:15 버킷
    expect(all).not.toContain('20260105153000');   // 15:30 단독 없음
  });
});

// ─── collectKR15Min (역방향 페이징 + 저장) ───────────────────
function makeStore() {
  const map = new Map<string, Candle>();
  return {
    map,
    latestStoredTs: async () => {
      const keys = [...map.keys()].sort();
      return keys.length ? keys[keys.length - 1] : null;
    },
    upsert15m: async (bars: Candle[]) => {
      let inserted = 0, updated = 0;
      for (const b of bars) { (map.has(b.datetime) ? updated++ : inserted++); map.set(b.datetime, b); }
      return { inserted, updated };
    },
  };
}
// KIS 흉내: endHHMMSS 기준 ≤ 그 시각의 최근 30개 반환
function makeFetchPage(allBars: Candle[]) {
  const calls: string[] = [];
  const fn = async (endHHMMSS: string) => {
    calls.push(endHHMMSS);
    const endTs = '20260105' + endHHMMSS;
    return allBars.filter(b => b.datetime <= endTs).sort((a, b) => a.datetime.localeCompare(b.datetime)).slice(-30);
  };
  return { fn, calls };
}

describe('collectKR15Min', () => {
  const allBars = oneMinRange(0, 60);   // 09:00~09:59 (60개)
  const now = kstMs(2026, 0, 5, 10, 5);

  it('부트스트랩: 역페이징으로 09:00 도달 후 집계·저장', async () => {
    const store = makeStore();
    const page = makeFetchPage(allBars);
    const r = await collectKR15Min({
      ticker: '005930', nowMs: now, fetchPage: page.fn, ...store,
    });
    expect(r.mode).toBe('bootstrap');
    expect(r.totalKisCalls).toBe(2);           // 30+30
    expect(r.stopReason).toBe('reached_0900');
    expect(r.oneMinAfterDedup).toBe(60);
    expect(r.uniqTs).toBe(60);
    expect(r.completedBars.map(b => b.ts)).toEqual([
      '20260105090000', '20260105091500', '20260105093000', '20260105094500',
    ]);
    expect(r.inProgress).toBeNull();           // 10:05 기준 0945 도 완성
    expect(r.stored).toEqual({ inserted: 4, updated: 0 });
    expect(store.map.size).toBe(4);
  });

  it('증분 재실행: 저장 최신봉 이후만, 중복행 없음', async () => {
    const store = makeStore();
    const page = makeFetchPage(allBars);
    await collectKR15Min({ ticker: '005930', nowMs: now, fetchPage: page.fn, ...store });   // 부트스트랩
    const r2 = await collectKR15Min({ ticker: '005930', nowMs: now, fetchPage: page.fn, ...store });
    expect(r2.mode).toBe('incremental');
    expect(r2.stored.inserted).toBe(0);        // 신규 없음
    expect(store.map.size).toBe(4);            // 중복 캔들 없음
  });

  it('정지조건 미도달 시 maxPages 에서 강제 종료(무제한 호출 방지)', async () => {
    // 매 페이지 새 봉 30개(09:00 미도달·중복·빈페이지 없음) → 오직 maxPages 로만 멈춤
    let call = 0;
    const fetchPage = async () => {
      // p번째: 15:00 기준 30분씩 뒤로. 항상 09:00(540분) 초과, 항상 신규.
      const base = 15 * 60;                    // 900분 = 15:00
      const bars: Candle[] = [];
      for (let i = 0; i < 30; i++) {
        const total = base - 30 * call - i;    // 내림차순
        const hh = Math.floor(total / 60), mm = total % 60;
        const ts = `20260105${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}00`;
        bars.push(c1(ts, 100, 101, 99, 100 + call * 30 + i));
      }
      call++;
      return bars;
    };
    const store = makeStore();
    const r = await collectKR15Min({
      ticker: '005930', nowMs: now, maxPages: 4, fetchPage, ...store,
    });
    expect(r.stopReason).toBe('max_pages');
    expect(r.totalKisCalls).toBe(4);           // maxPages 에서 정확히 멈춤
    expect(call).toBe(4);                       // fetchPage 도 4회만 호출
  });
});
