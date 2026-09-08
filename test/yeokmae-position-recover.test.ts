// P0-37 — 실보유 managed-position 복원: 증거+broker 일치만 복원, 추측 금지, 수동보유 보호, AMSF 손절. 실 주문 없음.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrderStore } from '../local-runner/order-store';
import { YeokmaePositionStore } from '../local-runner/yeokmae-position-store';
import {
  evaluateManagedRecovery, mergeBuyEvidence, earliestEntryDate, readEntryAvgOverride, readExchcdOverride,
} from '../local-runner/yeokmae/position-recover';
import { evaluateUSExit, type USExitPolicy } from '../local-runner/yeokmae/us-live-core';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'recover2-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const emptyEv = (symbol: string) => mergeBuyEvidence([], symbol);
const policy = (): USExitPolicy => ({ stopLossPct: 5, takeProfitPct: 8, maxHoldDays: 20, emergencyStopPct: 15, confirmed: true, pendingDecisions: [] });

describe('P0-37 OrderStore.buyEvidence — 과거 Vol BUY 증거 추출', () => {
  it('pending 매수(003120 qty4@20400) → confirmedBuyQty/orderPrice/확정봉/hasEvidence', () => {
    const o = new OrderStore('YEOKMAE_KR_003120', dir); o.load();
    o.recordPlaced('buy', '2026-08-13', '20260813', { ordNo: '57888', symbol: '003120', qty: 4, price: 20400, placedAtMs: 1 });
    o.flush();
    const ev = o.buyEvidence();
    expect(ev.hasAnyBuyEvidence).toBe(true);
    expect(ev.confirmedBuyQty).toBe(4); expect(ev.orderPrice).toBe(20400);
    expect(ev.candleDates).toContain('2026-08-13');
  });
  it('수락 응답(COSAT00301 rsp_cd=00040)만 있어도 증거(pending 없이) — 구버전 EXCEPTION 경로', () => {
    const o = new OrderStore('AIOT', dir); o.load();
    o.recordResponse({ atMs: 1, tr: 'COSAT00301', rspCd: '00040', rspMsg: '매수 주문이 완료되었습니다.', ordNo: null });
    o.flush();
    const ev = o.buyEvidence();
    expect(ev.hasAnyBuyEvidence).toBe(true);
    expect(ev.acceptedBuyResponses.length).toBe(1);
    expect(ev.confirmedBuyQty).toBeNull();   // 주문수량 미기록(예외경로)
  });
  it('증거 없음(빈 store) → hasEvidence=false', () => {
    const o = new OrderStore('ZZZZ', dir); o.load();
    expect(o.buyEvidence().hasAnyBuyEvidence).toBe(false);
  });
});

describe('P0-37 evaluateManagedRecovery — 안전규칙', () => {
  it('KR 003120: order qty4@20400 + broker qty4 avg20400 → RECOVER(broker 공식평단)', () => {
    const o = new OrderStore('YEOKMAE_KR_003120', dir); o.load();
    o.recordPlaced('buy', '2026-08-13', '20260813', { ordNo: '57888', symbol: '003120', qty: 4, price: 20400, placedAtMs: 1 }); o.flush();
    const dec = evaluateManagedRecovery({ symbol: '003120', market: 'KR', brokerQty: 4, brokerAvgPrice: 20400, evidence: o.buyEvidence(), exchcd: 'KR', entryAvgOverride: null });
    expect(dec.action).toBe('RECOVER'); expect(dec.qty).toBe(4); expect(dec.entryAvgPrice).toBe(20400); expect(dec.avgSource).toBe('BROKER_OFFICIAL');
    expect(dec.entryDate).toBe('2026-08-13');
  });
  it('broker 만 있고 증거 없음 → MANUAL(managed 생성 금지)', () => {
    const dec = evaluateManagedRecovery({ symbol: 'MANU', market: 'KR', brokerQty: 10, brokerAvgPrice: 5000, evidence: emptyEv('MANU'), exchcd: 'KR', entryAvgOverride: null });
    expect(dec.action).toBe('MANUAL'); expect(dec.reason).toContain('NO_VOL_BUY_EVIDENCE');
  });
  it('증거 있으나 broker 수량 불일치 → FAILCLOSED', () => {
    const o = new OrderStore('YEOKMAE_KR_005930', dir); o.load();
    o.recordPlaced('buy', '2026-08-13', '20260813', { ordNo: '1', symbol: '005930', qty: 4, price: 60000, placedAtMs: 1 }); o.flush();
    const dec = evaluateManagedRecovery({ symbol: '005930', market: 'KR', brokerQty: 5, brokerAvgPrice: 60000, evidence: o.buyEvidence(), exchcd: 'KR', entryAvgOverride: null });
    expect(dec.action).toBe('FAILCLOSED'); expect(dec.reason).toContain('QTY_MISMATCH');
  });
  it('US 00040 과거 BUY + broker 일치 + env 평단 → RECOVER(ENV_OVERRIDE)', () => {
    const o = new OrderStore('AIOT', dir); o.load();
    o.recordResponse({ atMs: 1, tr: 'COSAT00301', rspCd: '00040', rspMsg: '매수 주문이 완료되었습니다.', ordNo: null }); o.flush();
    const dec = evaluateManagedRecovery({ symbol: 'AIOT', market: 'US', brokerQty: 20, brokerAvgPrice: null, evidence: o.buyEvidence(), exchcd: '82', entryAvgOverride: 2.9150 });
    expect(dec.action).toBe('RECOVER'); expect(dec.qty).toBe(20); expect(dec.entryAvgPrice).toBe(2.9150); expect(dec.avgSource).toBe('ENV_OVERRIDE');
  });
  it('US exchcd 미해결 → FAILCLOSED(추측 금지)', () => {
    const o = new OrderStore('AMSF', dir); o.load();
    o.recordResponse({ atMs: 1, tr: 'COSAT00301', rspCd: '00040', rspMsg: 'ok', ordNo: null }); o.flush();
    const dec = evaluateManagedRecovery({ symbol: 'AMSF', market: 'US', brokerQty: 2, brokerAvgPrice: null, evidence: o.buyEvidence(), exchcd: '', entryAvgOverride: 28.12 });
    expect(dec.action).toBe('FAILCLOSED'); expect(dec.reason).toContain('EXCHCD_UNRESOLVED');
  });
  it('US 평단 근거 전무(override/공식/주문가 없음) → FAILCLOSED(추측 금지)', () => {
    const o = new OrderStore('AMSF', dir); o.load();
    o.recordResponse({ atMs: 1, tr: 'COSAT00301', rspCd: '00040', rspMsg: 'ok', ordNo: null }); o.flush();
    const dec = evaluateManagedRecovery({ symbol: 'AMSF', market: 'US', brokerQty: 2, brokerAvgPrice: null, evidence: o.buyEvidence(), exchcd: '81', entryAvgOverride: null });
    expect(dec.action).toBe('FAILCLOSED'); expect(dec.reason).toContain('ENTRY_AVG_UNKNOWN');
  });
  it('order 주문가만 있는 US → ORDER_PRICE 사용(문서화된 제출가, 추측 아님)', () => {
    const o = new OrderStore('YEOKMAE_US_PRGO', dir); o.load();
    o.recordPlaced('buy', '2026-08-13', '20260813', { ordNo: '285', symbol: 'PRGO', qty: 4, price: 13.02, placedAtMs: 1 }); o.flush();
    const dec = evaluateManagedRecovery({ symbol: 'PRGO', market: 'US', brokerQty: 4, brokerAvgPrice: null, evidence: o.buyEvidence(), exchcd: '82', entryAvgOverride: null });
    expect(dec.action).toBe('RECOVER'); expect(dec.entryAvgPrice).toBe(13.02); expect(dec.avgSource).toBe('ORDER_PRICE');
  });
});

describe('P0-37 AMSF 복원 후 손절 — 운영 STOP_LOSS 정상 발생', () => {
  it('entryAvg=28.12, 현재가 25.99(-7.57%) → STOP_LOSS', () => {
    const d = evaluateUSExit({ entryAvgPrice: 28.12, currentPrice: 25.99, holdDays: 1, policy: policy() });
    expect(d.action).toBe('SELL'); expect(d.reason).toBe('STOP_LOSS');
    expect(d.pnlPct!).toBeLessThanOrEqual(-5); expect(d.pnlPct!).toBeGreaterThan(-15);
  });
});

describe('P0-37 restart — 복원 결과 영구저장(재시작 후 managed 유지)', () => {
  it('복원(applyYeokmaeBuyFill)+flush → 새 store 로드 시 유지(MANUAL 로 회귀 안 함)', () => {
    const a = new YeokmaePositionStore(dir); a.load();
    a.applyYeokmaeBuyFill({ symbol: 'AMSF', exchcd: '81', entryDate: '2026-08-13', fillQty: 2, fillPrice: 28.12 });
    a.flush();
    const b = new YeokmaePositionStore(dir); b.load();
    const pos = b.get('AMSF');
    expect(pos).not.toBeNull(); expect(pos!.qty).toBe(2); expect(pos!.entryAvgPrice).toBe(28.12); expect(pos!.exchcd).toBe('81');
    expect(pos!.strategyTag).toBe('YEOKMAE');
  });
});

describe('P0-37 helpers — merge/earliestEntryDate/env override', () => {
  it('mergeBuyEvidence — 여러 order-store 증거 병합', () => {
    const o1 = new OrderStore('AIOT', dir); o1.load(); o1.recordResponse({ atMs: 1, tr: 'COSAT00301', rspCd: '00040', rspMsg: 'ok', ordNo: null }); o1.flush();
    const o2 = new OrderStore('YEOKMAE_US_AIOT', dir); o2.load(); o2.recordPlaced('buy', '2026-08-10', '20260810', { ordNo: '9', symbol: 'AIOT', qty: 20, price: 2.9, placedAtMs: 1 }); o2.flush();
    const ev = mergeBuyEvidence([o1.buyEvidence(), o2.buyEvidence()], 'AIOT');
    expect(ev.hasAnyBuyEvidence).toBe(true); expect(ev.confirmedBuyQty).toBe(20); expect(ev.orderPrice).toBe(2.9);
  });
  it('earliestEntryDate — YYYYMMDD/YYYY-MM-DD 정규화 후 최솟값', () => {
    expect(earliestEntryDate(['20260813', '2026-08-10'])).toBe('2026-08-10');
    expect(earliestEntryDate([])).toBeNull();
  });
  it('env override 읽기(추측 아님, 사용자 주입)', () => {
    const env = { YEOKMAE_US_ENTRY_AVG_AMSF: '28.12', YEOKMAE_US_EXCHCD_AMSF: '81' } as any;
    expect(readEntryAvgOverride(env, 'US', 'AMSF')).toBe(28.12);
    expect(readExchcdOverride(env, 'AMSF')).toBe('81');
    expect(readEntryAvgOverride(env, 'US', 'NONE')).toBeNull();
  });
});
