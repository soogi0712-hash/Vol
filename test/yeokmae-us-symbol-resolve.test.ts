import { describe, it, expect } from 'vitest';
import { usExchcdFromMarket } from '../src/lib/ls-api';

describe('P0-35US2 usExchcdFromMarket — market 라벨 → exchcd 역매핑(추측 아님)', () => {
  it('NASDAQ → 82', () => expect(usExchcdFromMarket('NASDAQ')).toBe('82'));
  it('NYSE_AMEX → 81 (PRGO 케이스)', () => expect(usExchcdFromMarket('NYSE_AMEX')).toBe('81'));
  it('ETC/미상 → null(fail-closed)', () => {
    expect(usExchcdFromMarket('ETC')).toBeNull();
    expect(usExchcdFromMarket('US')).toBeNull();
    expect(usExchcdFromMarket('')).toBeNull();
  });
});
