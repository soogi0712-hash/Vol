// P0-35US7 — 지속러너 복원 exchcd 해결 통일 + YEOKMAE 태깅 자격 판정 검증.
//   PRGO 처럼 static universe 에 없어도 signal metadata(exchange=NYSE_AMEX)로 exchcd=81 복원돼야 한다.
import { describe, it, expect } from 'vitest';
import { resolveUSExchcd } from '../src/lib/ls-api';
import { planUSHoldingRecovery } from '../local-runner/yeokmae-recover';

describe('P0-35US7 resolveUSExchcd — signal 우선, universe 교차검증, 충돌 fail-closed', () => {
  it('signal exchcd 직접 제공 → 그대로 사용', () => {
    const r = resolveUSExchcd({ storedExchcd: '81', storedExchange: 'NYSE_AMEX', universeExchcd: null });
    expect(r.exchcd).toBe('81'); expect(r.source).toBe('SIGNAL_EXCHCD');
  });
  it('signal exchange 라벨(NYSE_AMEX)만 있어도 → 81 유도(PRGO 케이스, universe 없음)', () => {
    const r = resolveUSExchcd({ storedExchcd: null, storedExchange: 'NYSE_AMEX', universeExchcd: null });
    expect(r.exchcd).toBe('81'); expect(r.source).toBe('SIGNAL_EXCHANGE');
  });
  it('NASDAQ 라벨 → 82', () => {
    expect(resolveUSExchcd({ storedExchange: 'NASDAQ' }).exchcd).toBe('82');
  });
  it('signal 없고 universe 만 → universe 사용', () => {
    const r = resolveUSExchcd({ storedExchcd: null, storedExchange: null, universeExchcd: '82' });
    expect(r.exchcd).toBe('82'); expect(r.source).toBe('UNIVERSE');
  });
  it('signal vs universe 불일치 → CONFLICT(fail-closed, exchcd 없음)', () => {
    const r = resolveUSExchcd({ storedExchcd: '81', universeExchcd: '82' });
    expect(r.exchcd).toBe(''); expect(r.source).toBe('CONFLICT');
    expect(r.failureReason).toContain('CONFLICT');
  });
  it('근거 전무 → NONE', () => {
    const r = resolveUSExchcd({});
    expect(r.exchcd).toBe(''); expect(r.source).toBe('NONE');
  });
});

describe('P0-35US7 planUSHoldingRecovery — YEOKMAE 태깅 자격(PRGO vs AIOT/AMSF)', () => {
  it('PRGO: signal metadata(NYSE_AMEX) + universe 없음 → RECOVER exchcd=81 YEOKMAE', () => {
    const p = planUSHoldingRecovery({ symbol: 'PRGO', hasSignal: true, signalExchcd: null, signalExchange: 'NYSE_AMEX', ledgerExists: false, universeExchcd: null });
    expect(p.action).toBe('RECOVER');
    expect(p.exchcd).toBe('81');
    expect(p.strategyTag).toBe('YEOKMAE');
    expect(p.source).toBe('SIGNAL_EXCHANGE');
  });
  it('AIOT/AMSF: signal 없음 & YEOKMAE 원장 없음 → SKIP_UNKNOWN(오태깅 금지)', () => {
    const aiot = planUSHoldingRecovery({ symbol: 'AIOT', hasSignal: false, ledgerExists: false, universeExchcd: '82' });
    expect(aiot.action).toBe('SKIP_UNKNOWN');
    expect(aiot.strategyTag).toBe('UNKNOWN');
    const amsf = planUSHoldingRecovery({ symbol: 'AMSF', hasSignal: false, ledgerExists: false, universeExchcd: null });
    expect(amsf.action).toBe('SKIP_UNKNOWN');
    expect(amsf.strategyTag).toBe('UNKNOWN');
  });
  it('재기동: 기존 YEOKMAE 원장 존재(signal 소멸) → 원장 exchcd 로 RECOVER(동기화)', () => {
    const p = planUSHoldingRecovery({ symbol: 'PRGO', hasSignal: false, ledgerExists: true, ledgerExchcd: '81', universeExchcd: null });
    expect(p.action).toBe('RECOVER');
    expect(p.exchcd).toBe('81');
    expect(p.strategyTag).toBe('YEOKMAE');
  });
  it('metadata conflict(signal 81 vs universe 82) → SKIP_CONFLICT(fail-closed, 태깅 안 함)', () => {
    const p = planUSHoldingRecovery({ symbol: 'PRGO', hasSignal: true, signalExchcd: '81', ledgerExists: false, universeExchcd: '82' });
    expect(p.action).toBe('SKIP_CONFLICT');
    expect(p.strategyTag).toBe('UNKNOWN');
  });
  it('signal 있으나 exchcd 근거 전무(exchange=ETC) & universe 없음 → SKIP_NO_EXCHCD', () => {
    const p = planUSHoldingRecovery({ symbol: 'XXX', hasSignal: true, signalExchange: 'ETC', ledgerExists: false, universeExchcd: null });
    expect(p.action).toBe('SKIP_NO_EXCHCD');
  });
});
