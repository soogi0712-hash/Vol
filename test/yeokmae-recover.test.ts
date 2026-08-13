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

describe('P0-35US8 PRGO BUSINESS_ERROR — recon 진단 + UNRESOLVED 안전장치', () => {
  // PRGO: holdings 4주 확인되나 COSAQ00102 가 미등록 업무코드(BUSINESS_ERROR) 반환 → 원장 미반영.
  const prgoBiz = () => buildYeokmaeUSRecovery({
    symbol: 'PRGO', exchcd: '81',
    rows: [], reconClassification: 'BUSINESS_ERROR', reconOk: false,   // rows 는 fail-closed 로 비워짐
    holdings: [hold({ balQty: 4, sellableQty: 4 })], holdingsOk: true,
    ordDate: '20260813', rspCd: '00001', rspMsg: '조회가 완료되었습니다.', httpStatus: 200, hasEnvelope: true, rawRows: 1,
    parsedRows: [buyRow({ execQty: 4, unfilledQty: 0, ordPrc: 12.86 })],   // 원문 rows(진단 표시용)
    yeokmaeEligible: true,
  });

  it('item1: reconDiag 에 실 rsp_cd/rows/classification 노출(BUSINESS_ERROR 여도 parsedRows 표시)', () => {
    const r = prgoBiz();
    expect(r.reconDiag.rspCd).toBe('00001');
    expect(r.reconDiag.classification).toBe('BUSINESS_ERROR');
    expect(r.reconDiag.symbolRows).toBe(1);          // parsedRows 로 PRGO 행 노출
    expect(r.reconDiag.execQty).toBe(4);
    expect(r.reconDiag.avgExecPrc).toContain('12.86');
    expect(r.reconDiag.failureReason).toContain('NON_SUCCESS');
  });

  it('item4: 실보유>0 + recon 불완전 + YEOKMAE 자격 → unresolvedYeokmaeHolding=true, evidenceOk=false', () => {
    const r = prgoBiz();
    expect(r.evidenceOk).toBe(false);
    expect(r.unresolvedYeokmaeHolding).toBe(true);
    expect(r.reason).toContain('UNRESOLVED_YEOKMAE_HOLDING');
  });

  it('item3: 원장에 임의 평단/수량 삽입 금지(SKIPPED) — holdings 로 avgPrice 추측 안 함', () => {
    const ps = new YeokmaePositionStore(dir); ps.load();
    const out = applyYeokmaeRecoveryToLedger(ps, prgoBiz(), { entryDate: '2026-08-13', confirmedSignalDate: '2026-08-11', matchedSignals: ['112_UPGRADE'] });
    expect(out.applied).toBe('SKIPPED');
    expect(ps.get('PRGO')).toBeNull();   // 평단 미확정 → 원장 미반영
  });

  it('item4: summarize 에 unresolved 전달 시 additionalBuyAllowed=false(중복매수 차단), SELL_ARMED=false', () => {
    const ps = new YeokmaePositionStore(dir); ps.load();   // 원장 비어 있음(복원 실패)
    const s = summarizeYeokmaeLive(ps.all(), 1, [{ symbol: 'PRGO', holdingQty: 4, reason: 'UNRESOLVED_YEOKMAE_HOLDING(recon=BUSINESS_ERROR)' }]);
    expect(s.currentYeokmaePositions).toBe(0);
    expect(s.additionalBuyAllowed).toBe(false);   // ⚠️ 슬롯 남아도 미해결 보유로 차단
    expect(s.sellArmed).toBe(false);              // 평단 미확정 → 자동 SELL 미활성
    expect(s.unresolvedYeokmaeHoldings).toHaveLength(1);
  });

  it('YEOKMAE 자격 없음(AIOT/AMSF) → business error 라도 unresolved 아님(오태깅·오차단 방지)', () => {
    const r = buildYeokmaeUSRecovery({
      symbol: 'AIOT', exchcd: '82', rows: [], reconClassification: 'BUSINESS_ERROR', reconOk: false,
      holdings: [{ symbol: 'AIOT', balQty: 10, sellableQty: 10 }], holdingsOk: true, yeokmaeEligible: false,
    });
    expect(r.unresolvedYeokmaeHolding).toBe(false);
  });

  it('정상 복원 시 unresolved=false(회귀)', () => {
    const r = buildYeokmaeUSRecovery({
      symbol: 'PRGO', exchcd: '81', rows: [buyRow({})], reconClassification: 'SUCCESS', reconOk: true,
      holdings: [hold({})], holdingsOk: true, yeokmaeEligible: true,
    });
    expect(r.unresolvedYeokmaeHolding).toBe(false);
    expect(r.evidenceOk).toBe(true);
  });
});

describe('P0-35US9 PRGO 완전 복원 (00136 SUCCESS → 원장 INSERTED)', () => {
  // 00136 등록 후: COSAQ00102 가 SUCCESS 로 rows 신뢰 → OrdNo=285/ExecQty=4/OvrsOrdPrc=13.02 복원.
  const prgoRow = buyRow({ ordNo: '285', ordQty: 4, execQty: 4, unfilledQty: 0, ordPrc: 13.02 });
  const rec = () => buildYeokmaeUSRecovery({
    symbol: 'PRGO', exchcd: '81',
    rows: [prgoRow], reconClassification: 'SUCCESS', reconOk: true,
    holdings: [hold({ balQty: 4, sellableQty: 4 })], holdingsOk: true,
    ordDate: '20260813', rspCd: '00136', rspMsg: '조회가 완료되었습니다.', httpStatus: 200, hasEnvelope: true, rawRows: 1,
    parsedRows: [prgoRow], yeokmaeEligible: true,
  });
  const meta = { entryDate: '2026-08-13', confirmedSignalDate: '2026-08-11', matchedSignals: ['112_UPGRADE'] };

  it('entryAvgPrice=13.02(OvrsOrdPrc, 하드코딩 아님) · ordNo=285 · qty=4 · evidenceOk=true', () => {
    const r = rec();
    expect(r.reconOk).toBe(true);
    expect(r.evidenceOk).toBe(true);
    expect(r.unresolvedYeokmaeHolding).toBe(false);
    expect(r.ordNo).toBe('285');
    expect(r.execQty).toBe(4);
    expect(r.entryAvgPrice).toBeCloseTo(13.02, 4);
    expect(r.reconDiag.avgExecPrc).toContain('13.02');
    expect(r.reconDiag.avgExecPrc).toContain('OvrsOrdPrc');
    expect(r.reconDiag.avgExecPrc).not.toContain('미확정');
  });

  it('item6: 복원 후 currentYeokmaePositions=1/1, additionalBuyAllowed=false, unresolved=0, SELL_ARMED=true', () => {
    const ps = new YeokmaePositionStore(dir); ps.load();
    const applied = applyYeokmaeRecoveryToLedger(ps, rec(), meta);
    expect(applied.applied).toBe('INSERTED');
    const pos = ps.get('PRGO')!;
    expect(pos.strategyTag).toBe('YEOKMAE');
    expect(pos.exchcd).toBe('81');
    expect(pos.qty).toBe(4);
    expect(pos.entryAvgPrice).toBeCloseTo(13.02, 4);
    expect(pos.confirmedSignalDate).toBe('2026-08-11');
    expect(pos.matchedSignals).toEqual(['112_UPGRADE']);
    const s = summarizeYeokmaeLive(ps.all(), 1, []);   // unresolved 없음(복원 성공)
    expect(s.currentYeokmaePositions).toBe(1);
    expect(s.additionalBuyAllowed).toBe(false);
    expect(s.unresolvedYeokmaeHoldings).toHaveLength(0);
    expect(s.sellArmed).toBe(true);
  });
});
