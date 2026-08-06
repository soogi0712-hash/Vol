import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandleStore, type StoredCandle } from '../local-runner/candle-store';
import {
  RealtimeCandleBuilder, bucket15, evaluateReadiness, aggregateTicksTo15Min,
  GSC_FRESH_MS, GSH_FRESH_MS, MIN_RT_CANDLES,
  type ReadinessState, type RTCandle,
} from '../local-runner/ls-us-websocket';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'candle-store-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sc = (datetime: string, o: number, h: number, l: number, c: number, v: number): StoredCandle =>
  ({ datetime, open: o, high: h, low: l, close: c, volume: v });

// ET(America/New_York) 벽시계 문자열 헬퍼: YYYYMMDD + HHMMSS
const ts = (ymd: string, hhmmss: string) => ymd + hhmmss;

describe('req10-1: 같은 버킷 내 OHLCV 집계', () => {
  it('동일 15분 버킷의 체결들은 하나의 봉으로 O/H/L/C/V 집계', () => {
    const b = new RealtimeCandleBuilder();
    // 09:03, 09:07, 09:14 (모두 0900 버킷)
    expect(b.addTrade(100, 5, ts('20260703', '090300'))).toBeNull();
    expect(b.addTrade(105, 3, ts('20260703', '090700'))).toBeNull();
    expect(b.addTrade(98, 2, ts('20260703', '091400'))).toBeNull();
    const arr = b.candles();
    expect(arr.length).toBe(1);
    expect(arr[0]).toMatchObject({ datetime: '20260703090000', open: 100, high: 105, low: 98, close: 98, volume: 10 });
  });
});

describe('req10-2: 버킷 전환 시 직전 봉 확정', () => {
  it('새 버킷 첫 체결에서 직전 봉을 확정봉으로 반환', () => {
    const b = new RealtimeCandleBuilder();
    b.addTrade(100, 1, ts('20260703', '090100'));   // 0900 형성
    b.addTrade(110, 1, ts('20260703', '091200'));   // 여전히 0900
    const confirmed = b.addTrade(120, 1, ts('20260703', '091600'));   // 0915 시작 → 0900 확정
    expect(confirmed).not.toBeNull();
    expect(confirmed).toMatchObject({ datetime: '20260703090000', open: 100, high: 110, low: 100, close: 110 });
    // 확정 후 형성 봉은 0915
    expect(b.formingCandle()?.datetime).toBe('20260703091500');
  });
});

describe('req10-3: 재시작 복원', () => {
  it('flush → 새 인스턴스 load 시 확정봉이 그대로 복원', () => {
    const s1 = new CandleStore('AAPL', dir);
    s1.upsertConfirmed(sc('20260703090000', 1, 2, 0.5, 1.5, 10));
    s1.upsertConfirmed(sc('20260703091500', 1.5, 3, 1, 2.5, 20));
    s1.setForming(sc('20260703093000', 2.5, 2.6, 2.4, 2.55, 5));
    s1.flush();

    const s2 = new CandleStore('AAPL', dir);
    s2.load();
    expect(s2.confirmedCount).toBe(2);
    const restored = s2.confirmedSorted();
    expect(restored.map(c => c.datetime)).toEqual(['20260703090000', '20260703091500']);
    expect(restored[1]).toMatchObject({ open: 1.5, high: 3, low: 1, close: 2.5, volume: 20 });
    expect(s2.forming?.datetime).toBe('20260703093000');
  });

  it('복원된 확정봉으로 빌더를 시드하면 0개부터 시작하지 않는다(req 2)', () => {
    const s1 = new CandleStore('TSLA', dir);
    // 09:00 부터 15분 간격 25개(시 롤오버 처리)
    for (let i = 0; i < 25; i++) {
      const total = 9 * 60 + i * 15;
      const dt = `20260703${String(Math.floor(total / 60)).padStart(2, '0')}${String(total % 60).padStart(2, '0')}00`;
      s1.upsertConfirmed(sc(dt, 1, 1, 1, 1, 1));
    }
    s1.flush();
    const s2 = new CandleStore('TSLA', dir); s2.load();
    const b = new RealtimeCandleBuilder();
    b.seed(s2.confirmedSorted().map(c => ({ ...c })));
    expect(b.candles().length).toBeGreaterThanOrEqual(25);
  });
});

describe('req10-4: 같은 timestamp 중복 저장 금지', () => {
  it('upsertConfirmed 은 동일 봉 재저장 시 false(중복), 값이 바뀌면 true', () => {
    const s = new CandleStore('AAPL', dir);
    expect(s.upsertConfirmed(sc('20260703090000', 1, 2, 0.5, 1.5, 10))).toBe(true);
    expect(s.upsertConfirmed(sc('20260703090000', 1, 2, 0.5, 1.5, 10))).toBe(false);   // 완전 동일 → 중복
    expect(s.upsertConfirmed(sc('20260703090000', 1, 2, 0.5, 1.6, 12))).toBe(true);    // 값 변경 → 갱신
    expect(s.confirmedCount).toBe(1);   // 같은 timestamp 는 1개만
  });

  it('빌더 seed 는 같은 datetime 을 병합/중복제거한다(req 5)', () => {
    const b = new RealtimeCandleBuilder();
    b.seed([sc('20260703090000', 1, 1, 1, 1, 1)]);
    b.seed([sc('20260703090000', 1, 1, 1, 1, 1), sc('20260703091500', 2, 2, 2, 2, 2)]);   // 09:00 중복
    expect(b.candles().length).toBe(2);
  });
});

describe('req10-5: 형성봉은 BB/RSI 입력(확정봉)에서 제외', () => {
  it('시드된 봉은 전부 확정, 실시간 형성봉만 confirmedCandles 에서 제외', () => {
    const b = new RealtimeCandleBuilder();
    // 저장 복원: 3개 모두 확정봉(종료된 봉)
    b.seed([sc('20260703090000', 1, 1, 1, 1, 1), sc('20260703091500', 2, 2, 2, 2, 2), sc('20260703093000', 3, 3, 3, 3, 3)]);
    expect(b.confirmedCount).toBe(3);
    expect(b.hasForming).toBe(false);
    // 실시간 체결 1건 → 다음 버킷 형성봉 생성(확정봉 개수는 그대로)
    b.addTrade(4, 1, '20260703094600');   // 0945 형성 시작
    expect(b.hasForming).toBe(true);
    expect(b.confirmedCount).toBe(3);                                  // 형성봉은 확정에 포함 안 됨
    expect(b.confirmedCandles().map(c => c.datetime)).toEqual(['20260703090000', '20260703091500', '20260703093000']);
    expect(b.formingCandle()?.datetime).toBe('20260703094500');
    expect(b.candles(false).length).toBe(4);                          // 전체 = 확정3 + 형성1
    expect(b.candles(true).length).toBe(3);                           // 확정봉만
  });
});

const NOW = 1_000_000_000;
const goodState = (over: Partial<ReadinessState> = {}): ReadinessState => ({
  websocketConnected: true, lastGSCatMs: NOW - 5000, lastGSHatMs: NOW - 5000,
  lastPrice: 100, bestBid: 99, bestAsk: 101, confirmedCount: MIN_RT_CANDLES, storeCorrupted: false, ...over,
});

describe('req10-6/7: readiness 게이트(확정봉 기준)', () => {
  it('확정봉 <20 → readiness=false, 신규매수 금지', () => {
    const r = evaluateReadiness(goodState({ confirmedCount: 19 }), NOW);
    expect(r.ready).toBe(false);
    expect(r.allowNewBuy).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/Warm-up/);
  });
  it('확정봉 ≥20 + 모두 신선 → readiness=true, 신규매수 허용', () => {
    const r = evaluateReadiness(goodState(), NOW);
    expect(r.ready).toBe(true);
    expect(r.stale).toBe(false);
    expect(r.allowNewBuy).toBe(true);
  });
});

describe('GSC/GSH 신선도 분리 (이번 수정)', () => {
  it('GSH fresh + GSC age 40초 → stale=false, 신규매수 유지', () => {
    const r = evaluateReadiness(goodState({ lastGSCatMs: NOW - 40_000 }), NOW);
    expect(r.stale).toBe(false);
    expect(r.gscFresh).toBe(true);
    expect(r.allowNewBuy).toBe(true);
  });
  it('GSC age 301초 → 신규매수 금지(+신호계산 중단), 보유매도 허용', () => {
    const r = evaluateReadiness(goodState({ lastGSCatMs: NOW - 301_000 }), NOW);
    expect(r.gscStale).toBe(true);
    expect(r.allowNewBuy).toBe(false);
    expect(r.allowSignal).toBe(false);
    expect(r.allowSellExisting).toBe(true);
  });
  it('GSH age 31초 → 신규매수 금지', () => {
    const r = evaluateReadiness(goodState({ lastGSHatMs: NOW - 31_000 }), NOW);
    expect(r.gshFresh).toBe(false);
    expect(r.allowNewBuy).toBe(false);
  });
  it('임계값 상수 확인: GSH 30초 / GSC 300초', () => {
    expect(GSH_FRESH_MS).toBe(30_000);
    expect(GSC_FRESH_MS).toBe(300_000);
  });
});

describe('req10-8: 미국 현지(NY) 서머타임 버킷팅', () => {
  it('ovsdate+trdtm(ET 벽시계)로 버킷 — UTC 오프셋 보정 없이 HH:MM 그대로', () => {
    // 여름(EDT, UTC-4)과 겨울(EST, UTC-5) 모두 09:37 ET 체결 → 같은 0930 버킷.
    // 문자열이 이미 현지 벽시계이므로 계절별 오프셋 계산이 없다 = 서머타임 자동 반영.
    const summer = bucket15(ts('20260703', '093712'));   // 7월=EDT
    const winter = bucket15(ts('20260115', '093712'));   // 1월=EST
    expect(summer.slice(8)).toBe('093000');
    expect(winter.slice(8)).toBe('093000');   // 동일 HH:MM 버킷
  });
  it('정규장 개장 09:30 ET 는 계절 불문 0930 버킷', () => {
    expect(bucket15(ts('20260703', '093000')).slice(8)).toBe('093000');   // 여름
    expect(bucket15(ts('20260115', '093000')).slice(8)).toBe('093000');   // 겨울
  });
  it('DST 전환 주말 경계에서도 문자열 floor 는 정상 동작', () => {
    // 2026-03-08 미국 DST 시작. 그 전후 ET 체결이 각자 자기 날짜/시각 버킷에 정상 배치.
    expect(bucket15(ts('20260306', '101459'))).toBe('20260306100000');   // 10:14 → 1000 버킷
    expect(bucket15(ts('20260309', '101459'))).toBe('20260309100000');   // 10:14 → 1000 버킷
    expect(bucket15(ts('20260306', '101500'))).toBe('20260306101500');   // 10:15 → 1015 버킷
  });
});

describe('req10-9: 파일 손상 → 신규매수 차단', () => {
  it('손상 JSON load → corrupt=true, .corrupt 백업, flush 무효(추가손상 방지)', () => {
    const s = new CandleStore('AAPL', dir);
    writeFileSync(s.file, '{ this is not valid json ', 'utf8');
    s.load();
    expect(s.corrupt).toBe(true);
    expect(existsSync(s.file + '.corrupt')).toBe(true);
    // flush 는 corrupt 면 아무것도 쓰지 않는다
    s.upsertConfirmed(sc('20260703090000', 1, 1, 1, 1, 1));
    s.flush();
    expect(existsSync(s.file)).toBe(false);   // 손상본은 .corrupt 로 이동, 원본은 재생성 안 함
  });

  it('저장 손상(storeCorrupted=true) → 시세가 준비돼도 신규매수 차단', () => {
    const s = new CandleStore('AAPL', dir);
    writeFileSync(s.file, 'corrupt!!!', 'utf8');
    s.load();
    expect(s.corrupt).toBe(true);
    // 시세는 모두 준비됐지만 저장 손상 → 신규매수 금지
    const ok = evaluateReadiness(goodState({ confirmedCount: 50, storeCorrupted: false }), NOW);
    expect(ok.allowNewBuy).toBe(true);
    const blocked = evaluateReadiness(goodState({ confirmedCount: 50, storeCorrupted: s.corrupt }), NOW);
    expect(blocked.allowNewBuy).toBe(false);
    expect(blocked.reasons.some(x => x.includes('저장손상'))).toBe(true);
  });
});

describe('확정/형성 분리 수명주기 (이번 수정)', () => {
  it('첫 GSC 수신 후 버킷 전환 전에는 confirmed=0, forming=true', () => {
    const b = new RealtimeCandleBuilder();
    expect(b.addTrade(100, 1, ts('20260703', '093012'))).toBeNull();   // 첫 체결 → 형성만
    expect(b.confirmedCount).toBe(0);                                   // 아직 확정봉 없음
    expect(b.hasForming).toBe(true);
    b.addTrade(101, 1, ts('20260703', '094000'));                       // 같은 0930 버킷
    expect(b.confirmedCount).toBe(0);                                   // 여전히 0
  });
  it('버킷 전환이 확인된 뒤에만 confirmed=1 로 승격', () => {
    const b = new RealtimeCandleBuilder();
    b.addTrade(100, 1, ts('20260703', '093012'));   // 0930 형성
    const confirmed = b.addTrade(110, 1, ts('20260703', '094600'));   // 0945 시작 → 0930 확정
    expect(confirmed?.datetime).toBe('20260703093000');
    expect(b.confirmedCount).toBe(1);
    expect(b.formingCandle()?.datetime).toBe('20260703094500');
  });
  it('종료 시 forming 저장 → 재시작 복원 시 confirmed 로 오인하지 않는다', () => {
    // 종료: 확정봉 2개 + 형성봉 1개 저장
    const s1 = new CandleStore('AAPL', dir);
    s1.upsertConfirmed(sc('20260703090000', 1, 1, 1, 1, 1));
    s1.upsertConfirmed(sc('20260703091500', 2, 2, 2, 2, 2));
    s1.setForming(sc('20260703093000', 3, 3, 3, 3, 3));   // confirmed:false 로 별도 저장
    s1.flush();

    // 재시작: 저장 확정봉만 빌더에 시드(형성봉은 넣지 않음, 러너 규칙)
    const s2 = new CandleStore('AAPL', dir); s2.load();
    expect(s2.confirmedCount).toBe(2);                    // 형성봉은 confirmed 에 포함 안 됨
    expect(s2.forming?.datetime).toBe('20260703093000');  // 형성봉은 별도 상태로 복원
    const b = new RealtimeCandleBuilder();
    b.seed(s2.confirmedSorted().map(c => ({ ...c })));    // 확정봉만 시드
    expect(b.confirmedCount).toBe(2);
    expect(b.hasForming).toBe(false);                     // 복원 직후 형성봉 없음
    expect(b.confirmedCandles().some(c => c.datetime === '20260703093000')).toBe(false);   // 형성봉 오인 없음
  });
});

describe('저장 안전성 + 비밀값 미저장', () => {
  it('flush 는 OHLCV+timestamp 만 기록하고 앱키/토큰/계좌는 담지 않는다(req 4)', () => {
    const s = new CandleStore('AAPL', dir);
    s.upsertConfirmed(sc('20260703090000', 1, 2, 0.5, 1.5, 10));
    s.flush();
    const raw = readFileSync(s.file, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty('confirmed');
    expect(Object.keys(parsed.confirmed['20260703090000']).sort()).toEqual(['close', 'datetime', 'high', 'low', 'open', 'volume']);
    expect(raw).not.toMatch(/appkey|secret|token|acnt|account/i);
  });

  it('atomic write: flush 후 .tmp 잔재가 남지 않는다', () => {
    const s = new CandleStore('AAPL', dir);
    s.upsertConfirmed(sc('20260703090000', 1, 2, 0.5, 1.5, 10));
    s.flush();
    expect(existsSync(s.file)).toBe(true);
    expect(existsSync(s.file + '.tmp')).toBe(false);
  });
});

describe('g3202 틱 → 15분 재집계 fallback (이번 수정)', () => {
  const tk = (dt: string, o: number, h: number, l: number, c: number, v: number): RTCandle =>
    ({ datetime: dt, open: o, high: h, low: l, close: c, volume: v });
  it('같은 15분 버킷 틱들을 OHLCV 로 집계 (open=첫, high=max, low=min, close=마지막, volume=합)', () => {
    const bars = aggregateTicksTo15Min([
      tk('20260703093012', 100, 100, 100, 100, 5),
      tk('20260703093712', 101, 102, 99, 101, 3),
      tk('20260703094400', 100, 100, 98, 98, 2),
      // 다음 버킷(형성봉 → 제외)
      tk('20260703094600', 105, 105, 105, 105, 1),
    ]);
    expect(bars).toHaveLength(1);   // 0930 확정, 0945 형성 제외
    expect(bars[0]).toMatchObject({ datetime: '20260703093000', open: 100, high: 102, low: 98, close: 98, volume: 10 });
  });
  it('같은 loctime 중복 틱도 합산(틱은 timestamp dedup 하지 않음)', () => {
    const bars = aggregateTicksTo15Min([
      tk('20260703093000', 10, 10, 10, 10, 100),
      tk('20260703093000', 11, 11, 11, 11, 50),   // 같은 시각 다른 체결
      tk('20260703094600', 12, 12, 12, 12, 1),     // 다음 버킷(형성 제외)
    ]);
    expect(bars).toHaveLength(1);
    expect(bars[0].volume).toBe(150);              // 중복 시각이지만 둘 다 합산
    expect(bars[0].close).toBe(11);
  });
  it('거래 없는 구간을 임의 봉으로 채우지 않는다(빈 버킷 미생성)', () => {
    const bars = aggregateTicksTo15Min([
      tk('20260703090000', 1, 1, 1, 1, 1),
      // 09:15, 09:30 버킷 거래 없음 — 채우지 않음
      tk('20260703094500', 2, 2, 2, 2, 1),
      tk('20260703100100', 3, 3, 3, 3, 1),   // 10:00 형성 제외
    ]);
    expect(bars.map(b => b.datetime)).toEqual(['20260703090000', '20260703094500']);   // 09:15/09:30 없음
  });
  it('NY 현지(date+loctime) 기준 버킷 — 서머타임 오프셋 보정 없음', () => {
    const bars = aggregateTicksTo15Min([
      tk('20260703093700', 1, 1, 1, 1, 1),   // 여름(EDT)
      tk('20260703095200', 2, 2, 2, 2, 1),
      tk('20260703101200', 3, 3, 3, 3, 1),   // 형성 제외
    ]);
    expect(bars[0].datetime).toBe('20260703093000');
    expect(bars[1].datetime).toBe('20260703094500');
  });
  it('틱이 한 버킷뿐이면 확정봉 0(전부 형성)', () => {
    expect(aggregateTicksTo15Min([tk('20260703093012', 1, 1, 1, 1, 1)])).toHaveLength(0);
  });
});

describe('실시간 집계 → 저장 통합 흐름', () => {
  it('버킷 전환마다 확정봉을 store 에 upsert 하면 중복 없이 누적된다', () => {
    const b = new RealtimeCandleBuilder();
    const s = new CandleStore('AAPL', dir);
    const trades: Array<[number, string]> = [
      [100, ts('20260703', '090100')],
      [101, ts('20260703', '091600')],   // 0900 확정
      [102, ts('20260703', '093100')],   // 0915 확정
      [103, ts('20260703', '093200')],   // 여전히 0930
      [104, ts('20260703', '094600')],   // 0930 확정
    ];
    let saved = 0;
    for (const [p, t] of trades) {
      const confirmed = b.addTrade(p, 1, t);
      if (confirmed && s.upsertConfirmed({ ...confirmed })) { s.flush(); saved++; }
    }
    expect(saved).toBe(3);                 // 0900, 0915, 0930 확정
    expect(s.confirmedCount).toBe(3);
    expect(s.confirmedSorted().map(c => c.datetime)).toEqual(['20260703090000', '20260703091500', '20260703093000']);
  });
});
