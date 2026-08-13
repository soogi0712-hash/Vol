import { describe, it, expect } from 'vitest';
import { buildKRBuyInBlock, krIsuNo, LS_KR_BNS_BUY } from '../src/lib/ls-api';

describe('P0-35P7 buildKRBuyInBlock — CSPAT00601 request 필드 검증', () => {
  it('002140 → IsuNo=A002140 + 공식 필드', () => {
    const ib = buildKRBuyInBlock({ shcode: '002140', qty: 1, price: 2135 }).CSPAT00601InBlock1 as any;
    expect(ib.IsuNo).toBe('A002140');
    expect(krIsuNo('002140')).toBe('A002140');
    expect(ib.OrdQty).toBe(1);
    expect(ib.OrdPrc).toBe(2135);
    expect(ib.BnsTpCode).toBe(LS_KR_BNS_BUY);   // '2' 매수
    expect(ib.OrdprcPtnCode).toBe('00');        // 지정가
    expect(ib.MgntrnCode).toBe('000');          // 현금
    expect(ib.LoanDt).toBe('');
    expect(ib.OrdCndiTpCode).toBe('0');
  });
  it('이미 A 접두 종목코드 중복 안 함', () => {
    expect((buildKRBuyInBlock({ shcode: 'A005930', qty: 1, price: 100 }).CSPAT00601InBlock1 as any).IsuNo).toBe('A005930');
  });
  it('MbrNo 미지정 → NXT 기본 / 지정 시 그 값(라우팅 조정 가능)', () => {
    expect((buildKRBuyInBlock({ shcode: '002140', qty: 1, price: 2135 }).CSPAT00601InBlock1 as any).MbrNo).toBe('NXT');
    expect((buildKRBuyInBlock({ shcode: '002140', qty: 1, price: 2135, mbrNo: 'KRX' }).CSPAT00601InBlock1 as any).MbrNo).toBe('KRX');
  });
});
