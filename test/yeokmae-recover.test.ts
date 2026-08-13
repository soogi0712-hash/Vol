// P0-35US6 — broker evidence 기반 실보유 복원 검증(재POST/lock 삭제 없음).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildYeokmaeUSRecovery, applyYeokmaeRecoveryToLedger, summarizeYeokmaeLive } from '../local-runner/yeokmae-recover';
import { YeokmaePositionStore } from '../local-runner/yeokmae-position-store';
import type { LSOrderExec, LSUSHolding } from '../src/lib/ls-api';

const buyRow = (o: Partial<LSOrderExec>): LSOrderExec => ({
  ordNo: '141', orgOrdNo: '0', symbol: 'PRGO', ordQty: 4, execQty: 4, unfilledQty: 0, ordPrc: 12.86, ordPtnCode: '02', trxNm: '체결', ...o,
});
const hold = (o: Partial<LSUSHolding>): LSUSHolding => ({ symbol: 'PRGO', balQty: 4, sellableQty: 4, ...o });

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'yeok-recover-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('P0-35US6 buildYeokmaeUSRecovery — broker evidence', () => {
  it('PRGO 전량체결 + 보유 → filled/ledgerQty=4/entryAvg=12.86/ordNo 복원', () => {
    const r = buildYeokmaeUSRecovery({
      symbol: 'PRGO', exchcd: '81',
      rows: [buyRow({})], reconClassification: 'SUCCESS', reconOk: true,
      holdings: [hold({})], holdingsOk: true,
    });
    expect(r.filled).toBe(true);
    expect(r.execQty).toBe(4);
    expect(r.holdingBalQty).toBe(4);
    expect(r.ledgerQty).toBe(4);
    expect(r.entryAvgPrice).toBeCloseTo(12.86, 4);
    expect(r.ordNo).toBe('141');
    expect(r.evidenceOk).toBe(true);
  });

  it('보유수량 우선 — 체결행 없어도 holdings 있으면 ledgerQty=보유수량', () => {
    const r = buildYeokmaeUSRecovery({
      symbol: 'PRGO', exchcd: '81',
      rows: [], reconClassification: 'EMPTY', reconOk: true,
      holdings: [hold({ balQty: 4, sellableQty: 4 })], holdingsOk: true,
    });
    expect(r.filled).toBe(true);
    expect(r.ledgerQty).toBe(4);
  });

  it('부분체결(execQty=2/unfilled=2, 보유 2) → ledgerQty=2, unfilledQty=2', () => {
    const r = buildYeokmaeUSRecovery({
      symbol: 'PRGO', exchcd: '81',
      rows: [buyRow({ ordQty: 4, execQty: 2, unfilledQty: 2 })], reconClassification: 'SUCCESS', reconOk: true,
      holdings: [hold({ balQty: 2, sellableQty: 2 })], holdingsOk: true,
    });
    expect(r.ledgerQty).toBe(2);
    expect(r.unfilledQty).toBe(2);
  });

  it('체결가중 진입가 — 2주@12.00 + 2주@13.00 → 12.50', () => {
    const r = buildYeokmaeUSRecovery({
      symbol: 'PRGO', exchcd: '81',
      rows: [buyRow({ ordNo: 'A', execQty: 2, ordPrc: 12.0 }), buyRow({ ordNo: 'B', execQty: 2, ordPrc: 13.0 })],
      reconClassification: 'SUCCESS', reconOk: true,
      holdings: [hold({ balQty: 4 })], holdingsOk: true,
    });
    expect(r.execQty).toBe(4);
    expect(r.entryAvgPrice).toBeCloseTo(12.5, 4);
  });

  it('evidence 불신(reconOk=false) → evidenceOk=false (원장 미반영 근거)', () => {
    const r = buildYeokmaeUSRecovery({
      symbol: 'PRGO', exchcd: '81',
      rows: [], reconClassification: 'BUSINESS_ERROR', reconOk: false,
      holdings: [hold({})], holdingsOk: true,
    });
    expect(r.evidenceOk).toBe(false);
  });

  it('체결/보유 없음 → filled=false', () => {
    const r = buildYeokmaeUSRecovery({
      symbol: 'PRGO', exchcd: '81',
      rows: [], reconClassification: 'EMPTY', reconOk: true, holdings: [], holdingsOk: true,
    });
    expect(r.filled).toBe(false);
  });
});

describe('P0-35US6 applyYeokmaeRecoveryToLedger — 원장 반영(재POST/lock 없음)', () => {
  const rec = () => buildYeokmaeUSRecovery({
    symbol: 'PRGO', exchcd: '81', rows: [buyRow({})], reconClassification: 'SUCCESS', reconOk: true, holdings: [hold({})], holdingsOk: true,
  });
  const meta = { entryDate: '2026-08-13', confirmedSignalDate: '2026-08-11', matchedSignals: ['112_UPGRADE'] };

  it('빈 원장 → INSERTED, strategyTag=YEOKMAE + confirmedSignalDate + matchedSignals + entryAvgPrice', () => {
    const ps = new YeokmaePositionStore(dir); ps.load();
    const out = applyYeokmaeRecoveryToLedger(ps, rec(), meta);
    expect(out.applied).toBe('INSERTED');
    const pos = ps.get('PRGO')!;
    expect(pos.strategyTag).toBe('YEOKMAE');
    expect(pos.qty).toBe(4);
    expect(pos.entryAvgPrice).toBeCloseTo(12.86, 4);
    expect(pos.confirmedSignalDate).toBe('2026-08-11');
    expect(pos.matchedSignals).toEqual(['112_UPGRADE']);
    // P0-34 SELL 정책 스냅샷 armed
    expect(pos.stopLossPct).toBe(5);
    expect(pos.takeProfitPct).toBe(8);
    // 재기동 복원 확인
    const ps2 = new YeokmaePositionStore(dir); ps2.load();
    expect(ps2.get('PRGO')!.qty).toBe(4);
  });

  it('이미 원장에 존재 → SYNCED(중복가산 금지, 보유수량 동기화)', () => {
    const ps = new YeokmaePositionStore(dir); ps.load();
    applyYeokmaeRecoveryToLedger(ps, rec(), meta);   // qty=4
    const out = applyYeokmaeRecoveryToLedger(ps, rec(), meta);   // 재실행 — 8 로 늘면 안 됨
    expect(out.applied).toBe('SYNCED');
    expect(ps.get('PRGO')!.qty).toBe(4);
    expect(ps.all().length).toBe(1);
  });

  it('evidence 불신 → SKIPPED(원장 미변경)', () => {
    const ps = new YeokmaePositionStore(dir); ps.load();
    const bad = buildYeokmaeUSRecovery({ symbol: 'PRGO', exchcd: '81', rows: [], reconClassification: 'TRANSPORT_ERROR', reconOk: false, holdings: [], holdingsOk: false });
    const out = applyYeokmaeRecoveryToLedger(ps, bad, meta);
    expect(out.applied).toBe('SKIPPED');
    expect(ps.get('PRGO')).toBeNull();
  });

  it('체결/보유 없음 → SKIPPED', () => {
    const ps = new YeokmaePositionStore(dir); ps.load();
    const empty = buildYeokmaeUSRecovery({ symbol: 'PRGO', exchcd: '81', rows: [], reconClassification: 'EMPTY', reconOk: true, holdings: [], holdingsOk: true });
    expect(applyYeokmaeRecoveryToLedger(ps, empty, meta).applied).toBe('SKIPPED');
  });
});

describe('P0-35US6 summarizeYeokmaeLive — 시작요약(item 3·4 보고값)', () => {
  const rec = buildYeokmaeUSRecovery({ symbol: 'PRGO', exchcd: '81', rows: [buyRow({})], reconClassification: 'SUCCESS', reconOk: true, holdings: [hold({})], holdingsOk: true });
  const meta = { entryDate: '2026-08-13', confirmedSignalDate: '2026-08-11', matchedSignals: ['112_UPGRADE'] };

  it('PRGO 보유 시 → currentYeokmaePositions=1/1, additionalBuyAllowed=false, SELL_ARMED=true', () => {
    const ps = new YeokmaePositionStore(dir); ps.load();
    applyYeokmaeRecoveryToLedger(ps, rec, meta);
    const s = summarizeYeokmaeLive(ps.all(), 1);
    expect(s.currentYeokmaePositions).toBe(1);
    expect(s.maxPositions).toBe(1);
    expect(s.additionalBuyAllowed).toBe(false);
    expect(s.sellArmed).toBe(true);
    const view = s.positions[0];
    expect(view.symbol).toBe('PRGO');
    expect(view.qty).toBe(4);
    expect(view.strategyTag).toBe('YEOKMAE');
    expect(view.confirmedSignalDate).toBe('2026-08-11');
    expect(view.matchedSignals).toEqual(['112_UPGRADE']);
    expect(view.stopLossPct).toBe(5);
    expect(view.takeProfitPct).toBe(8);
    expect(view.maxHoldDays).toBe(20);
    expect(view.sellArmed).toBe(true);
  });

  it('보유 없음 → currentYeokmaePositions=0/1, additionalBuyAllowed=true, SELL_ARMED=false', () => {
    const ps = new YeokmaePositionStore(dir); ps.load();
    const s = summarizeYeokmaeLive(ps.all(), 1);
    expect(s.currentYeokmaePositions).toBe(0);
    expect(s.additionalBuyAllowed).toBe(true);
    expect(s.sellArmed).toBe(false);
  });
});
