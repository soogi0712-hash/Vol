import { describe, it, expect } from 'vitest';
import { pilotReconOkUS } from '../local-runner/yeokmae-pilot-core';

describe('P0-35P3 pilotReconOkUS — SUCCESS/EMPTY 만 대사 통과', () => {
  it('SUCCESS → true', () => expect(pilotReconOkUS('SUCCESS')).toBe(true));
  it('EMPTY → true(주문 0건 정상)', () => expect(pilotReconOkUS('EMPTY')).toBe(true));
  it('BUSINESS_ERROR → false(fail-closed)', () => expect(pilotReconOkUS('BUSINESS_ERROR')).toBe(false));
  it('TRANSPORT_ERROR → false(fail-closed)', () => expect(pilotReconOkUS('TRANSPORT_ERROR')).toBe(false));
});

import { classifyKROrderExec } from '../src/lib/ls-api';

describe('P0-35P4 classifyKROrderExec — 0건 정상 vs API 실패 구분(추측 금지)', () => {
  const S = ['00000']; const E: string[] = [];
  it('00000 + envelope → SUCCESS', () => expect(classifyKROrderExec({ rspCd: '00000', hasEnvelope: true, successCodes: S, emptyCodes: E })).toBe('SUCCESS'));
  it('00000 + no envelope → EMPTY(정상 0건)', () => expect(classifyKROrderExec({ rspCd: '00000', hasEnvelope: false, successCodes: S, emptyCodes: E })).toBe('EMPTY'));
  it('empty code 등록분 → EMPTY', () => expect(classifyKROrderExec({ rspCd: '02XYZ', hasEnvelope: false, successCodes: S, emptyCodes: ['02XYZ'] })).toBe('EMPTY'));
  it('미확정 업무코드 → BUSINESS_ERROR(추측으로 통과시키지 않음, fail-closed)', () => expect(classifyKROrderExec({ rspCd: '00136', hasEnvelope: true, successCodes: S, emptyCodes: E })).toBe('BUSINESS_ERROR'));
});
