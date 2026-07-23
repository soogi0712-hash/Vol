import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 주문/시세/전략/유니버스 모킹 (hoisted 스파이) ────────────────
const spies = vi.hoisted(() => ({
  buyKR: vi.fn(), sellKR: vi.fn(), buyUS: vi.fn(), sellUS: vi.fn(),
  getKR15: vi.fn(), getUS15: vi.fn(),
}));
// getBBSignal 반환을 테스트별로 제어 (전략 수학은 strategy-unchanged.test.ts 가 검증)
const state = vi.hoisted(() => ({ signal: undefined as any }));

vi.mock('../src/lib/kis-api', () => ({
  getAccessToken: vi.fn(async () => 'tok'),
  getKROrderableCash: vi.fn(async () => 1e9),
  getUSOrderableCash: vi.fn(async () => 1e9),
  getKRHoldings: vi.fn(async () => []),
  getUSHoldings: vi.fn(async () => []),
  getKR15MinCandles: spies.getKR15,
  getUS15MinCandles: spies.getUS15,
  buyKR: spies.buyKR, sellKR: spies.sellKR, buyUS: spies.buyUS, sellUS: spies.sellUS,
}));
vi.mock('../src/lib/bollinger', () => ({
  calcBB: () => [],
  calcRSI: () => [],
  validateCandleData: () => ({ valid: true, reason: '', detail: '' }),
  getBBSignal: () => state.signal,
}));
vi.mock('../src/lib/stock-universe', () => ({
  getNextBatch: vi.fn(async (_db: unknown, _n: number, market: string) => ({
    items: [{
      ticker: market === 'US' ? 'AAPL' : '005930',
      ticker_name: market === 'US' ? 'Apple' : '삼성전자',
      exchange: market === 'US' ? 'NASD' : 'KOSPI',
    }],
    offset: 1, total: 1,
  })),
  updateUniverseScanResult: vi.fn(async () => {}),
  loadUniverseToDB: vi.fn(async () => {}),
}));

import { runTradeScan } from '../src/lib/trade-engine';

// ── 시나리오형 인메모리 D1 ────────────────────────────────────
function makeDB(config: Record<string, string>, holdingsByTicker: Record<string, any> = {}) {
  const writes = {
    trade_logs: [] as any[][], orders: [] as any[][], realized_profits: [] as any[][],
    holdings_deletes: [] as any[][], indicator_upsert: [] as any[][], candle_batch: 0,
  };
  const candleHistory = Array.from({ length: 40 }, (_, i) => ({
    candle_ts: `2026010${String(100000 + i).slice(1)}`, open: 100, high: 101, low: 99, close: 100 + i * 0.1, volume: 1000,
  }));
  const stmtFor = (sql: string) => {
    let binds: any[] = [];
    const stmt: any = {
      bind: (...a: any[]) => { binds = a; return stmt; },
      all: async () => {
        if (/FROM system_config/.test(sql)) return { results: Object.entries(config).map(([key, value]) => ({ key, value })) };
        if (/FROM watch_list/.test(sql)) return { results: [] };
        if (/FROM candle_history/.test(sql)) return { results: [...candleHistory].reverse() }; // DESC
        return { results: [] };
      },
      first: async () => {
        if (/universe_loaded_at/.test(sql)) return { value: 'loaded' };
        if (/history_count AS hc FROM indicator_snapshots/.test(sql)) return null;
        if (/FROM holdings WHERE ticker/.test(sql)) return holdingsByTicker[binds[0]] ?? null;
        if (/FROM system_config WHERE key=/.test(sql)) return config[binds[0]] !== undefined ? { value: config[binds[0]] } : null;
        return null;
      },
      run: async () => {
        if (/INSERT INTO trade_logs/.test(sql)) writes.trade_logs.push(binds);
        else if (/INSERT INTO orders/.test(sql)) writes.orders.push(binds);
        else if (/INSERT INTO realized_profits/.test(sql)) writes.realized_profits.push(binds);
        else if (/DELETE FROM holdings WHERE ticker=\?/.test(sql)) writes.holdings_deletes.push(binds); // 매도 경로 삭제만 (syncHoldings 의 qty=0 정리 제외)
        else if (/INSERT INTO indicator_snapshots/.test(sql)) writes.indicator_upsert.push(binds);
        return { success: true, meta: { last_row_id: 1 } };
      },
    };
    return stmt;
  };
  return {
    _writes: writes,
    prepare: (sql: string) => stmtFor(sql),
    batch: async (stmts: any[]) => { writes.candle_batch += stmts.length; return stmts.map(() => ({ success: true })); },
  } as any;
}

const KR_OPEN = new Date('2026-01-05T05:00:00Z'); // Mon 14:00 KST (KR open, US closed)
const US_OPEN = new Date('2026-01-05T15:00:00Z'); // Mon 10:00 EST (US open, KR closed)

const sig = (action: string) => ({
  action, current: { close: 100, upper: 110, middle: 105, lower: 100 },
  prev: { close: 99, lower: 100 }, above_upper: false, reason: `${action}-signal`,
});
const env = (DB: any) => ({ DB, KV: undefined, KIS_APP_KEY: 'k', KIS_APP_SECRET: 's', KIS_ACCOUNT_NO: 'n', KIS_ACCOUNT_SUFFIX: '01' });
const baseCfg = {
  auto_trade_enabled: '1', kr_trade_enabled: '1', us_trade_enabled: '1',
  scan_kr_enabled: '1', scan_us_enabled: '1', scan_batch_size: '20', indicator_candle_cnt: '150',
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });   // Date 만 고정 (setTimeout 은 실제 → sleep 정상)
  Object.values(spies).forEach(s => s.mockReset());
  spies.buyKR.mockResolvedValue({ order_no: 'o', success: true, message: 'ok', raw: {} });
  spies.sellKR.mockResolvedValue({ order_no: 'o', success: true, message: 'ok', raw: {} });
  spies.buyUS.mockResolvedValue({ order_no: 'o', success: true, message: 'ok', raw: {} });
  spies.sellUS.mockResolvedValue({ order_no: 'o', success: true, message: 'ok', raw: {} });
  const c = Array.from({ length: 41 }, (_, i) => ({ ticker: 'x', market: 'KR', datetime: `2026010${String(100000 + i).slice(1)}`, open: 100, high: 101, low: 99, close: 100 + i * 0.05, volume: 1000 }));
  spies.getKR15.mockResolvedValue(c);
  spies.getUS15.mockResolvedValue(c.map(x => ({ ...x, market: 'US' })));
});

describe('auto_trade_enabled=0 → 조기 반환 (기존 동작 보존)', () => {
  it('스캔·시세조회·주문 모두 없음', async () => {
    vi.setSystemTime(KR_OPEN);
    const db = makeDB({ ...baseCfg, auto_trade_enabled: '0', observe_only_enabled: '1' });
    const res = await runTradeScan(env(db));
    expect(res.actions).toContain('자동매매 비활성화');
    expect(spies.getKR15).not.toHaveBeenCalled();
    expect(spies.buyKR).not.toHaveBeenCalled();
    expect(db._writes.candle_batch).toBe(0);
    expect(db._writes.indicator_upsert).toHaveLength(0);
  });
});

describe('관찰 전용 (auto_trade=1, observe_only=1): 스캔·기록 O, 실주문 X', () => {
  it('BUY 신호 → buyKR 미호출, OBSERVE_ONLY_BUY 기록, 체결주문/보유변경 없음', async () => {
    vi.setSystemTime(KR_OPEN); state.signal = sig('BUY');
    const db = makeDB({ ...baseCfg, us_trade_enabled: '0', scan_us_enabled: '0', observe_only_enabled: '1' });
    const res = await runTradeScan(env(db));
    expect(spies.buyKR).toHaveBeenCalledTimes(0);
    expect(spies.buyUS).toHaveBeenCalledTimes(0);
    expect(db._writes.orders).toHaveLength(0);                 // 가짜 체결주문 없음
    expect(db._writes.trade_logs.some(b => b[3] === 'OBSERVE_ONLY_BUY')).toBe(true);
    expect(res.actions.some((a: string) => a.includes('관찰'))).toBe(true);
    // 지표/캔들 기록은 정상 수행
    expect(db._writes.candle_batch).toBeGreaterThan(0);        // candle_history 기록됨
    expect(db._writes.indicator_upsert.length).toBeGreaterThan(0); // indicator_snapshots 기록됨
  });

  it('SELL 신호(보유) → sellKR 미호출, 실현손익/보유삭제 없음', async () => {
    vi.setSystemTime(KR_OPEN); state.signal = sig('SELL');
    const holding = { ticker: '005930', ticker_name: '삼성전자', market: 'KR', exchange: 'KOSPI', qty: 10, avg_price: 90, above_upper: 1 };
    const db = makeDB({ ...baseCfg, us_trade_enabled: '0', scan_us_enabled: '0', observe_only_enabled: '1' }, { '005930': holding });
    await runTradeScan(env(db));
    expect(spies.sellKR).toHaveBeenCalledTimes(0);
    expect(db._writes.realized_profits).toHaveLength(0);       // 실현손익 미생성
    expect(db._writes.holdings_deletes).toHaveLength(0);       // 보유 미삭제
    expect(db._writes.trade_logs.some(b => b[3] === 'OBSERVE_ONLY_SELL')).toBe(true);
  });

  it('US BUY 신호 → buyUS 미호출', async () => {
    vi.setSystemTime(US_OPEN); state.signal = sig('BUY');
    const db = makeDB({ ...baseCfg, kr_trade_enabled: '0', scan_kr_enabled: '0', observe_only_enabled: '1' });
    await runTradeScan(env(db));
    expect(spies.buyUS).toHaveBeenCalledTimes(0);
    expect(db._writes.indicator_upsert.length).toBeGreaterThan(0);
  });

  it('US SELL 신호(보유) → sellUS 미호출', async () => {
    vi.setSystemTime(US_OPEN); state.signal = sig('SELL');
    const holding = { ticker: 'AAPL', ticker_name: 'Apple', market: 'US', exchange: 'NASD', qty: 5, avg_price: 90, above_upper: 1 };
    const db = makeDB({ ...baseCfg, kr_trade_enabled: '0', scan_kr_enabled: '0', observe_only_enabled: '1' }, { AAPL: holding });
    await runTradeScan(env(db));
    expect(spies.sellUS).toHaveBeenCalledTimes(0);
    expect(db._writes.realized_profits).toHaveLength(0);
  });
});

describe('라이브 (auto_trade=1, observe_only=0): 기존 주문 동작 그대로', () => {
  it('BUY 신호 → buyKR 실제 호출', async () => {
    vi.setSystemTime(KR_OPEN); state.signal = sig('BUY');
    const db = makeDB({ ...baseCfg, us_trade_enabled: '0', scan_us_enabled: '0', observe_only_enabled: '0' });
    await runTradeScan(env(db));
    expect(spies.buyKR).toHaveBeenCalledTimes(1);
    expect(db._writes.orders.length).toBeGreaterThan(0);       // 실제 체결주문 기록
  });

  it('SELL 신호(보유) → sellKR 실제 호출 + 실현손익/보유삭제', async () => {
    vi.setSystemTime(KR_OPEN); state.signal = sig('SELL');
    const holding = { ticker: '005930', ticker_name: '삼성전자', market: 'KR', exchange: 'KOSPI', qty: 10, avg_price: 90, above_upper: 1 };
    const db = makeDB({ ...baseCfg, us_trade_enabled: '0', scan_us_enabled: '0', observe_only_enabled: '0' }, { '005930': holding });
    await runTradeScan(env(db));
    expect(spies.sellKR).toHaveBeenCalledTimes(1);
    expect(db._writes.realized_profits.length).toBeGreaterThan(0);
    expect(db._writes.holdings_deletes.length).toBeGreaterThan(0);
  });
});
