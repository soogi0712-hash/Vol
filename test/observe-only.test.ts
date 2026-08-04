import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 주문/시세/전략/유니버스 모킹 (hoisted 스파이) ────────────────
const spies = vi.hoisted(() => ({
  buyKR: vi.fn(), sellKR: vi.fn(), buyUS: vi.fn(), sellUS: vi.fn(),
  getKR15: vi.fn(), getUS15: vi.fn(), fetchKR1Min: vi.fn(),
  getKROrderableCash: vi.fn(), getUSOrderableCash: vi.fn(), getUSOrderableQty: vi.fn(),
}));
// getBBSignal 반환을 테스트별로 제어 (전략 수학은 strategy-unchanged.test.ts 가 검증)
const state = vi.hoisted(() => ({ signal: undefined as any }));

vi.mock('../src/lib/kis-api', () => ({
  getAccessToken: vi.fn(async () => 'tok'),
  getKROrderableCash: spies.getKROrderableCash,
  getUSOrderableCash: spies.getUSOrderableCash,
  getUSOrderableQty: spies.getUSOrderableQty,
  getKRHoldings: vi.fn(async () => []),
  getUSHoldings: vi.fn(async () => []),
  getKR15MinCandles: spies.getKR15,
  getUS15MinCandles: spies.getUS15,
  fetchKR1MinPage: spies.fetchKR1Min,   // Phase 3 KR 수집 소스
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
const US_OPEN = new Date('2026-01-05T15:00:00Z'); // Mon 15:00 UTC (US 정규장, KR closed)
const MARKET_CLOSED = new Date('2026-01-05T10:00:00Z'); // Mon: KR 19:00 KST 마감 · US 10:00 UTC 개장 전

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
  spies.getKROrderableCash.mockResolvedValue(1e9);
  spies.getUSOrderableCash.mockResolvedValue(1e9);
  spies.getUSOrderableQty.mockResolvedValue({ orderableQty: 100, raw: {} });
  spies.buyKR.mockResolvedValue({ order_no: 'o', success: true, message: 'ok', raw: {} });
  spies.sellKR.mockResolvedValue({ order_no: 'o', success: true, message: 'ok', raw: {} });
  spies.buyUS.mockResolvedValue({ order_no: 'o', success: true, message: 'ok', raw: {} });
  spies.sellUS.mockResolvedValue({ order_no: 'o', success: true, message: 'ok', raw: {} });
  const c = Array.from({ length: 41 }, (_, i) => ({ ticker: 'x', market: 'KR', datetime: `2026010${String(100000 + i).slice(1)}`, open: 100, high: 101, low: 99, close: 100 + i * 0.05, volume: 1000 }));
  spies.getKR15.mockResolvedValue(c);
  spies.getUS15.mockResolvedValue(c.map(x => ({ ...x, market: 'US' })));
  // Phase 3 KR 수집: 09:00~09:29 1분봉 30개 → 완성 15분봉 2개(0900,0915) 저장 후 reached_0900 종료.
  const kr1min = Array.from({ length: 30 }, (_, i) => ({
    ticker: '005930', market: 'KR', datetime: `20260105${'09'}${String(i).padStart(2, '0')}00`,
    open: 100, high: 101, low: 99, close: 100 + i * 0.1, volume: 100,
  }));
  spies.fetchKR1Min.mockResolvedValue(kr1min);
});

describe('수집/주문 분리: auto_trade_enabled=0 (정규장)', () => {
  it('KR 정규장이면 수집·신호는 수행하되 실주문은 없음', async () => {
    vi.setSystemTime(KR_OPEN); state.signal = sig('BUY');
    const db = makeDB({ ...baseCfg, auto_trade_enabled: '0', us_trade_enabled: '0', scan_us_enabled: '0', observe_only_enabled: '0' });
    await runTradeScan(env(db));
    expect(spies.buyKR).not.toHaveBeenCalled();                    // 주문 차단(auto_trade OFF)
    expect(db._writes.orders).toHaveLength(0);
    expect(db._writes.candle_batch).toBeGreaterThan(0);            // 수집은 수행(candle_history 15m)
    expect(db._writes.indicator_upsert.length).toBeGreaterThan(0); // 신호/스냅샷 계산 수행
    expect(db._writes.trade_logs.some(b => b[3] === 'OBSERVE_ONLY_BUY')).toBe(true);
  });

  it('주문가능현금 조회는 주문이 꺼져 있으면 생략된다(불필요 API 차단)', async () => {
    vi.setSystemTime(KR_OPEN); state.signal = sig('NONE');
    const db = makeDB({ ...baseCfg, auto_trade_enabled: '0', us_trade_enabled: '0', scan_us_enabled: '0' });
    await runTradeScan(env(db));
    expect(spies.getKROrderableCash).not.toHaveBeenCalled();
  });

  it('장 마감이면 조기 반환 — 수집·시세·스냅샷 모두 없음', async () => {
    vi.setSystemTime(MARKET_CLOSED);
    const db = makeDB({ ...baseCfg, auto_trade_enabled: '0' });
    const res = await runTradeScan(env(db));
    expect(res.actions.some((a: string) => a.includes('장 마감'))).toBe(true);
    expect(spies.fetchKR1Min).not.toHaveBeenCalled();
    expect(spies.getUS15).not.toHaveBeenCalled();
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
    // Phase 3: 관찰 전용이어도 KR 수집은 동작 → 완성 15분봉이 candle_history 에 누적된다.
    // (주문만 차단, 데이터 수집은 계속 — 이력이 쌓여야 30봉 게이트를 넘을 수 있으므로)
    expect(db._writes.candle_batch).toBeGreaterThan(0);
    // 지표 스냅샷은 기존 이력에서 계산되어 기록됨
    expect(db._writes.indicator_upsert.length).toBeGreaterThan(0);
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

describe('Phase 3: KR 스캔은 candle_history(15m)에 완성봉을 누적한다', () => {
  it('관찰/라이브·신호 무관하게 KR 수집은 15m 완성봉을 저장 (candle_batch>0)', async () => {
    for (const observe of ['1', '0']) {
      vi.setSystemTime(KR_OPEN); state.signal = sig('NONE');
      const db = makeDB({ ...baseCfg, us_trade_enabled: '0', scan_us_enabled: '0', observe_only_enabled: observe });
      await runTradeScan(env(db));
      expect(db._writes.candle_batch).toBeGreaterThan(0);
    }
  });

  it("kr_candle_source='legacy' 이면 수집/저장하지 않는다 (candle_batch=0)", async () => {
    vi.setSystemTime(KR_OPEN); state.signal = sig('NONE');
    const db = makeDB({ ...baseCfg, us_trade_enabled: '0', scan_us_enabled: '0', observe_only_enabled: '1', kr_candle_source: 'legacy' });
    await runTradeScan(env(db));
    expect(db._writes.candle_batch).toBe(0);
    expect(spies.getKR15).toHaveBeenCalled();       // legacy 는 기존 경로 사용
    expect(spies.fetchKR1Min).not.toHaveBeenCalled();
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

describe('US 매수: 외화 주문가능금액 0 이어도 원화주문/통합증거금 계좌는 주문', () => {
  it('us_orderable_cash=0 이어도 buyUS 호출 + orders FILLED (frcr 0 으로 사전차단 안 함)', async () => {
    vi.setSystemTime(US_OPEN); state.signal = sig('BUY');
    spies.getUSOrderableCash.mockResolvedValue(0);                 // 외화 주문가능 0
    spies.getUSOrderableQty.mockResolvedValue({ orderableQty: 10, raw: {} });  // 통합증거금 반영 수량
    const db = makeDB({ ...baseCfg, kr_trade_enabled: '0', scan_kr_enabled: '0', observe_only_enabled: '0' });
    await runTradeScan(env(db));
    expect(spies.buyUS).toHaveBeenCalledTimes(1);                  // 사전 차단되지 않고 실제 주문
    expect(db._writes.orders.some(b => b[7] === 'FILLED')).toBe(true);
  });

  it('종목별 주문가능수량 조회 실패해도 buyUS 진행(최종 판단은 KIS 응답)', async () => {
    vi.setSystemTime(US_OPEN); state.signal = sig('BUY');
    spies.getUSOrderableCash.mockResolvedValue(0);
    spies.getUSOrderableQty.mockRejectedValue(new Error('psamount fail'));
    const db = makeDB({ ...baseCfg, kr_trade_enabled: '0', scan_kr_enabled: '0', observe_only_enabled: '0' });
    await runTradeScan(env(db));
    expect(spies.buyUS).toHaveBeenCalledTimes(1);
  });

  it('KIS 거절 → orders FAILED + BUY_FAIL(코드·메시지) 기록', async () => {
    vi.setSystemTime(US_OPEN); state.signal = sig('BUY');
    spies.getUSOrderableCash.mockResolvedValue(0);
    spies.buyUS.mockResolvedValue({ order_no: '', success: false, message: '주문가능금액 부족', code: '40580000', raw: { rt_cd: '1', msg_cd: '40580000', msg1: '주문가능금액 부족' } });
    const db = makeDB({ ...baseCfg, kr_trade_enabled: '0', scan_kr_enabled: '0', observe_only_enabled: '0' });
    await runTradeScan(env(db));
    expect(spies.buyUS).toHaveBeenCalledTimes(1);
    expect(db._writes.orders.some(b => b[7] === 'FAILED')).toBe(true);   // 실패도 orders 에 기록
    const failLog = db._writes.trade_logs.find(b => b[3] === 'BUY_FAIL');
    expect(failLog).toBeTruthy();
    expect(String(failLog!.join(' '))).toContain('40580000');           // KIS 원문 코드
  });
});

describe('주문 흐름 진단: SIGNAL_BUY 이후 중단 지점', () => {
  it('kr_trade_enabled=0 → BUY_BLOCKED 기록 (기존 무로그 return 제거), 주문 없음', async () => {
    vi.setSystemTime(KR_OPEN); state.signal = sig('BUY');
    // auto_trade=1·observe=0 이라 주문 조건은 충족하지만, 시장별 스위치가 꺼져 있는 경우
    const db = makeDB({ ...baseCfg, kr_trade_enabled: '0', us_trade_enabled: '0', scan_us_enabled: '0', observe_only_enabled: '0' });
    await runTradeScan(env(db));
    expect(spies.buyKR).not.toHaveBeenCalled();
    expect(db._writes.orders).toHaveLength(0);
    expect(db._writes.trade_logs.some(b => b[3] === 'SIGNAL_BUY')).toBe(true);   // 신호는 발생
    expect(db._writes.trade_logs.some(b => b[3] === 'BUY_BLOCKED')).toBe(true);  // 중단 지점이 기록됨
  });
});
