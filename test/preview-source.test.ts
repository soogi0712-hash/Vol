import { describe, it, expect, vi, beforeEach } from 'vitest';

// preview 라우트가 KR 에서 candle_history(15m)를 읽는지 검증.
// 무거운 형제 모듈은 스텁으로 대체(라우트 로딩만 되면 됨).
const kis = vi.hoisted(() => ({
  getAccessToken: vi.fn(async () => 'tok'),
  getKR15MinCandles: vi.fn(),   // 폴백 경로 (이력 있을 땐 호출되면 안 됨)
  getUS15MinCandles: vi.fn(),
}));
vi.mock('../src/lib/kis-api', () => ({
  getAccessToken: kis.getAccessToken,
  getKR15MinCandles: kis.getKR15MinCandles,
  getUS15MinCandles: kis.getUS15MinCandles,
  getKRHoldings: vi.fn(), getUSHoldings: vi.fn(),
  getKROrderableCash: vi.fn(), getUSOrderableCash: vi.fn(),
}));
vi.mock('../src/lib/bollinger', () => ({
  // recent_bands 검증용: datetime 을 그대로 밴드에 실어 보낸다
  calcBB: (_closes: number[], dts: string[]) => dts.map(d => ({ datetime: d, upper: 1, middle: 0, lower: -1, close: 0 })),
  calcRSI: () => [],
  getBBSignal: () => ({ action: 'NONE', reason: 'r', current: {}, prev: {}, above_upper: false, rsi_current: NaN, rsi_prev: NaN, rsi_rising: false, buy_conditions: { rsi_le_35: false }, fail_reasons: [], bb_lower_recovery: false }),
}));
vi.mock('../src/lib/trade-engine', () => ({
  runTradeScan: vi.fn(), syncHoldings: vi.fn(), isKRMarketOpen: () => true, isUSMarketOpen: () => true,
}));
vi.mock('../src/lib/backtest', () => ({ runKISBacktest: vi.fn() }));
vi.mock('../src/lib/stock-universe', () => ({
  loadUniverseToDB: vi.fn(), getScanStats: vi.fn(), getSignalStocks: vi.fn(),
  loadFullUniverseFromKIS: vi.fn(), getDBUniverseStats: vi.fn(),
}));

import trading from '../src/routes/trading';

// 15분 간격 15m 봉 (candle_history 모사)
const bars15m = Array.from({ length: 32 }, (_, i) => {
  const total = 9 * 60 + i * 15;          // 09:00 부터 15분 간격
  const hh = Math.floor(total / 60), mm = total % 60;
  const ts = `20260105${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}00`;
  return { candle_ts: ts, open: 100, high: 101, low: 99, close: 100 + i * 0.1, volume: 1000 };
});

function makeEnv(historyRows: any[]) {
  const stmt = (sql: string): any => ({
    bind: () => stmt(sql),
    all: async () => (/FROM candle_history/.test(sql) ? { results: [...historyRows].reverse() } : { results: [] }),
    first: async () => null,
  });
  const env: any = {
    DB: { prepare: (sql: string) => stmt(sql) },
    KV: undefined, KIS_APP_KEY: 'k', KIS_APP_SECRET: 's', KIS_ACCOUNT_NO: 'n', KIS_ACCOUNT_SUFFIX: '01',
  };
  return env;
}

beforeEach(() => {
  kis.getKR15MinCandles.mockReset();
  kis.getUS15MinCandles.mockReset();
});

describe('preview KR 데이터 소스 (Phase 3)', () => {
  it('candle_history(15m)를 읽어 recent_bands 가 15분 간격, source=candle_history:15m', async () => {
    const env = makeEnv(bars15m);
    const res = await trading.request('/preview/KR/005930', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.candle_source).toBe('candle_history:15m');
    expect(body.timeframe).toBe('15m');
    expect(body.candle_count).toBe(32);
    // 1분봉 경로(getKR15MinCandles)는 호출되지 않아야 한다
    expect(kis.getKR15MinCandles).not.toHaveBeenCalled();
    // recent_bands 간격이 15분인지 확인 (마지막 두 밴드)
    const t = body.recent_bands.map((b: any) => b.datetime);
    const mmOf = (s: string) => parseInt(s.slice(10, 12), 10);
    const hhOf = (s: string) => parseInt(s.slice(8, 10), 10);
    const gap = (hhOf(t[t.length - 1]) * 60 + mmOf(t[t.length - 1])) - (hhOf(t[t.length - 2]) * 60 + mmOf(t[t.length - 2]));
    expect(gap).toBe(15);   // 1분이 아니라 15분
  });

  it('이력이 없으면 1분봉 경로로 폴백하고 source 를 명시한다', async () => {
    kis.getKR15MinCandles.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({ ticker: '005930', market: 'KR', datetime: `202601051526${String(i).padStart(2, '0')}`.slice(0, 14), open: 1, high: 1, low: 1, close: 1, volume: 1 })),
    );
    const env = makeEnv([]);   // candle_history 비어 있음
    const res = await trading.request('/preview/KR/005930', {}, env);
    const body = await res.json() as any;
    expect(kis.getKR15MinCandles).toHaveBeenCalledTimes(1);
    expect(body.candle_source).toContain('kis:1m');
    expect(body.timeframe).toBe('1m');
  });
});
