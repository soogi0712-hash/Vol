import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pilotRealOrderEnabled, runYeokmaePilotBuy, buildYeokmaeLiveCandidate,
  type YeokmaeSignalType, type YeokmaePilotBuyDeps,
} from '../src/lib/yeokmae';
import { YeokmaePositionStore } from '../local-runner/yeokmae-position-store';

const arr = (...a: YeokmaeSignalType[]) => a;
const cand = (matched = arr('112_ORIGINAL')) => buildYeokmaeLiveCandidate({ symbol: 'ABC', exchange: 'NASDAQ', confirmedDate: '2026-08-11', matchedSignals: matched, isProvisional: false })!;

function mockDeps(fillStatus = 'placed-filled') {
  const calls: any[] = [];
  const recorded: any[] = [];
  const deps: YeokmaePilotBuyDeps = {
    executeBuy: async (o) => { calls.push(o); return { status: fillStatus, ordNo: 'ORD1', filledQty: fillStatus === 'placed-filled' ? o.qty : 0, fillPrice: o.price }; },
    recordPosition: (o) => { recorded.push(o); },
    log: () => {},
  };
  return { deps, calls, recorded };
}

describe('P0-35P2 pilotRealOrderEnabled — 최종 하드 게이트', () => {
  const base = { liveTrading: true, yeokmaeLive: true, pilotLive: true, gateAllowed: true, currentYeokmaePositions: 0 };
  it('전부 true → enabled', () => expect(pilotRealOrderEnabled(base).enabled).toBe(true));
  it('LS_LIVE_TRADING false → 차단', () => expect(pilotRealOrderEnabled({ ...base, liveTrading: false }).enabled).toBe(false));
  it('YEOKMAE_LIVE_TRADING false → 차단', () => expect(pilotRealOrderEnabled({ ...base, yeokmaeLive: false }).enabled).toBe(false));
  it('YEOKMAE_PILOT_LIVE false → 차단', () => expect(pilotRealOrderEnabled({ ...base, pilotLive: false }).enabled).toBe(false));
  it('gate 차단 → 차단', () => expect(pilotRealOrderEnabled({ ...base, gateAllowed: false }).enabled).toBe(false));
  it('YEOKMAE 포지션 1개 → 차단', () => {
    const r = pilotRealOrderEnabled({ ...base, currentYeokmaePositions: 1 });
    expect(r.enabled).toBe(false);
    expect(r.reasons.some(x => x.startsWith('YEOKMAE_POSITION_NOT_ZERO'))).toBe(true);
  });
});

describe('P0-35P2 runYeokmaePilotBuy — executor 호출 게이트', () => {
  const buyInput = { candidate: cand(), exchcd: '82', qty: 3, price: 20, candleDatetime: '2026-08-11', etDate: '20260811' };

  it('realOrderEnabled=false → executor 미호출(POST 0)', async () => {
    const { deps, calls } = mockDeps();
    const r = await runYeokmaePilotBuy(deps, { ...buyInput, realOrderEnabled: false });
    expect(calls.length).toBe(0);
    expect(r.posted).toBe(false);
    expect(r.reason).toBe('PILOT_REAL_ORDER_DISABLED');
  });
  it('candidate null → 미호출', async () => {
    const { deps, calls } = mockDeps();
    const r = await runYeokmaePilotBuy(deps, { ...buyInput, candidate: null, realOrderEnabled: true });
    expect(calls.length).toBe(0); expect(r.posted).toBe(false);
  });
  it('qty<=0 → 미호출(fail-closed)', async () => {
    const { deps, calls } = mockDeps();
    const r = await runYeokmaePilotBuy(deps, { ...buyInput, qty: 0, realOrderEnabled: true });
    expect(calls.length).toBe(0); expect(r.reason).toBe('NO_QTY');
  });
  it('price<=0(quote stale) → 미호출', async () => {
    const { deps, calls } = mockDeps();
    const r = await runYeokmaePilotBuy(deps, { ...buyInput, price: 0, realOrderEnabled: true });
    expect(calls.length).toBe(0); expect(r.reason).toBe('NO_PRICE');
  });
  it('모든 조건 true → executor 정확히 1회 호출 + 체결 시 recordPosition(strategyTag/matchedSignals)', async () => {
    const { deps, calls, recorded } = mockDeps('placed-filled');
    const r = await runYeokmaePilotBuy(deps, { ...buyInput, realOrderEnabled: true });
    expect(calls.length).toBe(1);
    expect(r.posted).toBe(true);
    expect(recorded.length).toBe(1);
    expect(recorded[0].matchedSignals).toEqual(['112_ORIGINAL']);
    expect(recorded[0].confirmedSignalDate).toBe('2026-08-11');
  });
  it('동일 candle 재실행(executor DUPLICATE) → posted=false', async () => {
    const { deps, recorded } = mockDeps('aborted');
    const r = await runYeokmaePilotBuy(deps, { ...buyInput, realOrderEnabled: true });
    expect(r.posted).toBe(false);
    expect(recorded.length).toBe(0);   // 미체결 → 포지션 기록 없음
  });
});

describe('P0-35P2 포지션 저장 — strategyTag=YEOKMAE + 신호정보 + 재시작 복원', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'yk-pl-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('applyYeokmaeBuyFill → strategyTag/confirmedSignalDate/matchedSignals 저장 + 복원', () => {
    const s1 = new YeokmaePositionStore(dir); s1.load();
    s1.applyYeokmaeBuyFill({ symbol: 'ABC', exchcd: '82', entryDate: '2026-08-12', fillQty: 3, fillPrice: 20, confirmedSignalDate: '2026-08-11', matchedSignals: ['112_ORIGINAL'] });
    s1.flush();
    const s2 = new YeokmaePositionStore(dir); s2.load();
    const p = s2.get('ABC')!;
    expect(p.strategyTag).toBe('YEOKMAE');
    expect(p.confirmedSignalDate).toBe('2026-08-11');
    expect(p.matchedSignals).toEqual(['112_ORIGINAL']);
    // 재시작 후 1포지션 제한 복원 근거
    expect(s2.all().length).toBe(1);
  });
});
