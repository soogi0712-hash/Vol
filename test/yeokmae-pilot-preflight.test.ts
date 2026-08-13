import { describe, it, expect } from 'vitest';
import { pilotReconOkUS } from '../local-runner/yeokmae-pilot-core';

describe('P0-35P3 pilotReconOkUS — SUCCESS/EMPTY 만 대사 통과', () => {
  it('SUCCESS → true', () => expect(pilotReconOkUS('SUCCESS')).toBe(true));
  it('EMPTY → true(주문 0건 정상)', () => expect(pilotReconOkUS('EMPTY')).toBe(true));
  it('BUSINESS_ERROR → false(fail-closed)', () => expect(pilotReconOkUS('BUSINESS_ERROR')).toBe(false));
  it('TRANSPORT_ERROR → false(fail-closed)', () => expect(pilotReconOkUS('TRANSPORT_ERROR')).toBe(false));
});
