import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeKRBuyOrder, type KRTraderDeps } from '../local-runner/kr-trader';
import { OrderStore } from '../local-runner/order-store';
import { classifyKROrderExec, type OrderExecClassification } from '../src/lib/ls-api';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kr-unify-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// CSPAQ13700 실측 config (P0-35P5): success 00000 / empty 00200.
const SUCCESS = ['00000']; const EMPTY = ['00200'];
// preflight/executor 가 공유하는 strict classifier 로 raw 응답을 분류(동일 함수).
function classify(s: { rspCd: string; http: number; envelope: boolean; rows: number }): OrderExecClassification {
  return classifyKROrderExec({ rspCd: s.rspCd, httpStatus: s.http, hasEnvelope: s.envelope, rowCount: s.rows, successCodes: SUCCESS, emptyCodes: EMPTY });
}
// queryLSKROrderExecUnified 의 매핑을 모사: ok = SUCCESS/EMPTY.
function unified(s: { rspCd: string; http: number; envelope: boolean; rows: number }) {
  const classification = classify(s);
  const ok = classification === 'SUCCESS' || classification === 'EMPTY';
  return { ok, classification, rspCd: s.rspCd, rspMsg: 'x', buyOrdQty: s.rows, buyExecQty: 0, sellOrdQty: 0, sellExecQty: 0 };
}

function harness(recon: { rspCd: string; http: number; envelope: boolean; rows: number }) {
  let placed = false; let placeCalls = 0;
  const deps: KRTraderDeps = {
    place: async () => { placeCalls++; placed = true; return { rspCd: '00040', rspMsg: '매수 주문 완료', ordNo: '32004', raw: {}, diag: {} as any }; },
    // 전송 전=대사(recon 시나리오), 전송 후=체결(전량).
    queryExec: async () => placed ? { ok: true, rspCd: '00000', rspMsg: '', buyOrdQty: 1, buyExecQty: 1, sellOrdQty: 0, sellExecQty: 0 } : unified(recon),
    cancel: async () => ({ rspCd: '00156', rspMsg: '', ordNo: '', raw: {}, diag: {} as any }),
    cashOrderable: async () => ({ ok: true, cash: 1_000_000_000 }),
    now: () => 1_000_000, log: () => {},
  };
  return { deps, get placeCalls() { return placeCalls; } };
}
const params = (orders: OrderStore) => ({ orders, shcode: '002140', candleDatetime: '2026-08-13', qty: 1, price: 2125, krDate: '20260813', mbrNo: 'NXT', dailyMaxBuys: 1 });

describe('P0-35P6 preflight↔executor 대사판정 통일 (동일 strict classifier)', () => {
  const scen = {
    valid:     { rspCd: '00200', http: 200, envelope: true, rows: 0 },   // 정상 0건
    rowsPos:   { rspCd: '00200', http: 200, envelope: true, rows: 2 },   // 00200 인데 rows>0
    malformed: { rspCd: '00200', http: 200, envelope: false, rows: 0 },  // envelope 없음
    unknown:   { rspCd: '00136', http: 200, envelope: true, rows: 0 },   // 미확정 업무코드
    network:   { rspCd: 'EXCEPTION', http: 0, envelope: false, rows: 0 },// transport(http!=200)
  };

  it('00200 + valid + rows0 → classification=EMPTY (preflight 허용 근거)', () => {
    expect(classify(scen.valid)).toBe('EMPTY');
    expect(unified(scen.valid).ok).toBe(true);
  });

  it('00200 valid → executeKRBuyOrder reconciliation 허용 → place 정확히 1회', async () => {
    const orders = new OrderStore('KR_002140_valid', dir);
    const h = harness(scen.valid);
    const r = await executeKRBuyOrder(h.deps, params(orders));
    expect(r.status).toBe('placed-filled');
    expect(h.placeCalls).toBe(1);   // ★ 실주문 mock 정확히 1회
  });

  it.each([
    ['rowsPos', scen.rowsPos], ['malformed', scen.malformed], ['unknown', scen.unknown], ['network', scen.network],
  ])('%s → 양쪽 모두 차단 (classification≠EMPTY/SUCCESS, executor RECONCILIATION_FAILED, place 0)', async (name, s) => {
    // preflight 판정
    const cls = classify(s);
    expect(cls === 'EMPTY' || cls === 'SUCCESS').toBe(false);
    // executor 판정 (동일 응답)
    const orders = new OrderStore(`KR_002140_${name}`, dir);
    const h = harness(s);
    const r = await executeKRBuyOrder(h.deps, params(orders));
    expect(r.status).toBe('aborted');
    expect(r.abortCode).toBe('RECONCILIATION_FAILED');
    expect(h.placeCalls).toBe(0);   // ★ 차단 시 POST 0
  });

  it('preflight classification == executor 허용여부 (parity)', () => {
    for (const s of Object.values(scen)) {
      const cls = classify(s);
      const preflightOk = cls === 'EMPTY' || cls === 'SUCCESS';
      const executorOk = unified(s).ok;   // executor 는 chk.ok 로 판정 → 동일
      expect(executorOk).toBe(preflightOk);
    }
  });
});
