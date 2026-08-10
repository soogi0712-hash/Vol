import { describe, it, expect } from 'vitest';
import { classifyKRSymbol, isPreferredStock, buildUniverse, loadKRUniverse } from '../local-runner/kr-universe';
import type { LSKRMasterRow } from '../src/lib/ls-api';

function row(o: Partial<LSKRMasterRow> = {}): LSKRMasterRow {
  return {
    shcode: '005930', hname: '삼성전자', market: 'KOSPI', gubunRaw: '1',
    spac: false, etf: false, etfgubun: '0',
    prevClose: 70000, upperLimit: 91000, lowerLimit: 49000, basePrice: 70000, memedan: '00001', expcode: 'KR7005930003',
    ...o,
  };
}

describe('P0-22 KR 유니버스 eligibility 필터', () => {
  it('보통주(삼성전자) → eligible', () => {
    expect(classifyKRSymbol(row())).toEqual({ eligible: true, reasons: [] });
  });
  it('ETF/ETN(etfgubun!=0) → 제외(옵션 off), includeEtf 면 허용', () => {
    const etf = row({ shcode: '069500', hname: 'KODEX 200', etf: true, etfgubun: '1' });
    expect(classifyKRSymbol(etf).reasons).toContain('ETF_ETN');
    expect(classifyKRSymbol(etf, { includeEtf: true }).eligible).toBe(true);
  });
  it('SPAC(spac_gubun=Y 또는 이름에 스팩) → 제외', () => {
    expect(classifyKRSymbol(row({ spac: true })).reasons).toContain('SPAC');
    expect(classifyKRSymbol(row({ hname: '엔에이치스팩29호', shcode: '456780' })).reasons).toContain('SPAC');
  });
  it('우선주(이름 접미 우 / 코드 끝자리 non-0) → 제외', () => {
    expect(isPreferredStock({ shcode: '005935', hname: '삼성전자우' })).toBe(true);
    expect(isPreferredStock({ shcode: '005385', hname: '현대차우' })).toBe(true);
    expect(isPreferredStock({ shcode: '005930', hname: '삼성전자' })).toBe(false);
    expect(classifyKRSymbol(row({ shcode: '005935', hname: '삼성전자우' })).reasons).toContain('PREFERRED');
  });
  it('전일종가<=0(신규/거래정지 성격) → 제외', () => {
    expect(classifyKRSymbol(row({ prevClose: 0 })).reasons).toContain('NO_PREV_CLOSE');
  });
  it('KOSDAQ 보통주도 eligible', () => {
    expect(classifyKRSymbol(row({ shcode: '247540', hname: '에코프로비엠', market: 'KOSDAQ', gubunRaw: '2' })).eligible).toBe(true);
  });

  it('buildUniverse — total/eligible/excluded/사유별/시장별 집계', () => {
    const rows = [
      row({ shcode: '005930', hname: '삼성전자' }),                            // eligible KOSPI
      row({ shcode: '247540', hname: '에코프로비엠', market: 'KOSDAQ', gubunRaw: '2' }), // eligible KOSDAQ
      row({ shcode: '069500', hname: 'KODEX 200', etf: true, etfgubun: '1' }),  // ETF
      row({ shcode: '005935', hname: '삼성전자우' }),                          // 우선주
      row({ shcode: '456780', hname: '스팩1호', spac: true }),                 // SPAC
      row({ shcode: '900110', hname: '신규', prevClose: 0 }),                  // no prev close
    ];
    const u = buildUniverse(rows, {});
    expect(u.total).toBe(6);
    expect(u.eligible.map(r => r.shcode).sort()).toEqual(['005930', '247540']);
    expect(u.excluded).toBe(4);
    expect(u.excludedByReason.ETF_ETN).toBe(1);
    expect(u.excludedByReason.PREFERRED).toBeGreaterThanOrEqual(1);
    expect(u.excludedByReason.SPAC).toBe(1);
    expect(u.perMarket.KOSPI).toBeGreaterThanOrEqual(1);
    expect(u.perMarket.KOSDAQ).toBe(1);
  });

  it('loadKRUniverse — KOSPI(gubun=1)+KOSDAQ(gubun=2) 병합 + shcode dedup', async () => {
    const calls: string[] = [];
    const fakeFetch = async (_cfg: any, _tok: string, gubun: string) => {
      calls.push(gubun);
      if (gubun === '1') return { rspCd: '00000', rspMsg: '', diag: {} as any, rows: [row({ shcode: '005930', market: 'KOSPI', gubunRaw: '1' })] };
      return { rspCd: '00000', rspMsg: '', diag: {} as any, rows: [row({ shcode: '247540', hname: '에코프로비엠', market: 'KOSDAQ', gubunRaw: '2' }), row({ shcode: '005930', market: 'KOSPI', gubunRaw: '1' })] };
    };
    const u = await loadKRUniverse({} as any, 'T', fakeFetch as any, {});
    expect(calls).toEqual(['1', '2']);
    expect(u.total).toBe(2);                       // 005930 중복 제거
    expect(u.eligible.length).toBe(2);
    expect(u.ok).toBe(true);
  });
});
