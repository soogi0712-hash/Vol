import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';

// scheduled() 가 실제 runTradeScan 경로를 호출하는지 검증하기 위해 스파이로 대체.
// (trading/indicator 로직 자체는 변경하지 않으며, 여기서는 배포 경로 연결만 확인)
vi.mock('../src/lib/report-engine', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, runFullDailyReport: vi.fn(async () => {}), getKSTDateStr: () => '2026-01-01' };
});
vi.mock('../src/lib/trade-engine', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    runTradeScan: vi.fn(async () => ({
      scanned: 0, actions: [], errors: [], kr_market_open: false, us_market_open: false, batch_info: '',
    })),
  };
});

import worker from '../src/index';
import { runTradeScan } from '../src/lib/trade-engine';

// 최소 D1 스텁 (체이닝)
function fakeDB(rows: Record<string, unknown>[] = []) {
  const stmt: Record<string, unknown> = {
    bind: () => stmt,
    all: async () => ({ results: rows }),
    first: async () => rows[0] ?? null,
    run: async () => ({ success: true, meta: {} }),
  };
  return { prepare: () => stmt, batch: async () => [] };
}
const env = {
  DB: fakeDB([{ key: 'auto_trade_enabled', value: '0', description: '' }]),
  KIS_APP_KEY: 'k', KIS_APP_SECRET: 's', KIS_ACCOUNT_NO: 'n', KIS_ACCOUNT_SUFFIX: '01',
} as any;
function makeCtx() {
  const p: Promise<unknown>[] = [];
  return { promises: p, waitUntil: (x: Promise<unknown>) => { p.push(x); }, passThroughOnException() {} };
}

describe('Worker 엔트리 (fetch + scheduled 공존)', () => {
  it('default export 가 fetch() 를 노출한다', () => {
    expect(typeof (worker as any).fetch).toBe('function');
  });
  it('default export 가 scheduled() 를 노출한다', () => {
    expect(typeof (worker as any).scheduled).toBe('function');
  });
  it('두 핸들러가 동시에 존재한다', () => {
    expect(typeof (worker as any).fetch).toBe('function');
    expect(typeof (worker as any).scheduled).toBe('function');
  });

  it('API 라우트가 살아 있다: GET /api/config → 200 JSON', async () => {
    const res = await (worker as any).fetch(new Request('http://localhost/api/config'), env, makeCtx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  it('알 수 없는 경로는 404 (Hono 라우팅 동작)', async () => {
    const res = await (worker as any).fetch(new Request('http://localhost/definitely-not-a-route'), env, makeCtx());
    expect(res.status).toBe(404);
  });

  it('scheduled() 가 기존 runTradeScan 경로를 호출한다', async () => {
    (runTradeScan as any).mockClear();
    const ctx = makeCtx();
    await (worker as any).scheduled({} as any, env, ctx);
    await Promise.allSettled(ctx.promises);
    expect(runTradeScan).toHaveBeenCalledTimes(1);
    // 스캔에 동일 env 바인딩(DB/KIS)이 전달되는지 확인
    expect((runTradeScan as any).mock.calls[0][0].DB).toBe(env.DB);
    expect((runTradeScan as any).mock.calls[0][0].KIS_APP_KEY).toBe('k');
  });

  it('정적 자산 소스(public/index.html)가 존재한다 (assets.directory)', () => {
    expect(existsSync('public/index.html')).toBe(true);
    expect(existsSync('public/static/style.css')).toBe(true);
  });
});
