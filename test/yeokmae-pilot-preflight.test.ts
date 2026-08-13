import { describe, it, expect } from 'vitest';
import { pilotReconOkUS } from '../local-runner/yeokmae-pilot-core';

describe('P0-35P3 pilotReconOkUS — SUCCESS/EMPTY 만 대사 통과', () => {
  it('SUCCESS → true', () => expect(pilotReconOkUS('SUCCESS')).toBe(true));
  it('EMPTY → true(주문 0건 정상)', () => expect(pilotReconOkUS('EMPTY')).toBe(true));
  it('BUSINESS_ERROR → false(fail-closed)', () => expect(pilotReconOkUS('BUSINESS_ERROR')).toBe(false));
  it('TRANSPORT_ERROR → false(fail-closed)', () => expect(pilotReconOkUS('TRANSPORT_ERROR')).toBe(false));
});

import { classifyKROrderExec, LS_EMPTY_CODES } from '../src/lib/ls-api';

describe('P0-35P5 classifyKROrderExec — CSPAQ13700 00200 EMPTY(엄격) / 그 외 fail-closed', () => {
  const S = ['00000']; const E = LS_EMPTY_CODES['CSPAQ13700'] ?? [];   // ['00200']
  const k = (o: Partial<Parameters<typeof classifyKROrderExec>[0]>) => classifyKROrderExec({ rspCd: '00200', httpStatus: 200, hasEnvelope: true, rowCount: 0, successCodes: S, emptyCodes: E, ...o });

  it('00200 실측 등록 확인', () => expect(E).toContain('00200'));
  it('00200 + rows0 + valid envelope + http200 → EMPTY(reconciliationOk=true 근거)', () => expect(k({})).toBe('EMPTY'));
  it('00200 + rows>0 → BUSINESS_ERROR(fail-closed)', () => expect(k({ rowCount: 3 })).toBe('BUSINESS_ERROR'));
  it('00200 + malformed envelope(없음) → BUSINESS_ERROR', () => expect(k({ hasEnvelope: false })).toBe('BUSINESS_ERROR'));
  it('00200 + httpStatus!=200 → BUSINESS_ERROR', () => expect(k({ httpStatus: 500 })).toBe('BUSINESS_ERROR'));
  it('unknown 업무코드(00136) → BUSINESS_ERROR', () => expect(k({ rspCd: '00136' })).toBe('BUSINESS_ERROR'));
  it('00000 + envelope + rows>0 → SUCCESS', () => expect(k({ rspCd: '00000', rowCount: 2 })).toBe('SUCCESS'));
  it('00000 + envelope + rows0 → EMPTY', () => expect(k({ rspCd: '00000', rowCount: 0 })).toBe('EMPTY'));
  it('00000 + envelope 없음 → BUSINESS_ERROR', () => expect(k({ rspCd: '00000', hasEnvelope: false })).toBe('BUSINESS_ERROR'));
  it('CSPAQ13700 전용 — 다른 TR 전역적용 금지(COSAQ00102 등에는 00200 없음)', () => {
    expect(LS_EMPTY_CODES['COSAQ00102']).toBeUndefined();
  });
});
