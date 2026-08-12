import { describe, it, expect } from 'vitest';
import { yeokmaeSearcherFormula, evaluateYeokmaeSearcher } from '../src/lib/yeokmae/searcher';
import type { Candle } from '../src/lib/yeokmae/hts';

const ALL = 'ABCDEFGHIJKLMNOPQRSTU'.split('');
const allTrue = (): Record<string, boolean> => Object.fromEntries(ALL.map(k => [k, true]));

describe('P0-32 검색기 최종식 — 괄호 우선순위 고정(회귀)', () => {
  it('전부 true → matched', () => { expect(yeokmaeSearcherFormula(allTrue())).toBe(true); });

  it('A/B/C/K/L/S/T/U 는 필수(AND) — 하나라도 false → false', () => {
    for (const k of ['A', 'B', 'C', 'K', 'L', 'S', 'T', 'U']) {
      const x = allTrue(); x[k] = false; expect(yeokmaeSearcherFormula(x)).toBe(false);
    }
  });
  it('(D or E) — 둘 다 false 만 탈락', () => {
    let x = allTrue(); x.D = false; x.E = true; expect(yeokmaeSearcherFormula(x)).toBe(true);
    x = allTrue(); x.D = false; x.E = false; expect(yeokmaeSearcherFormula(x)).toBe(false);
  });
  it('(F or G), (H or I or J), (Q or R) — OR 그룹', () => {
    let x = allTrue(); x.F = false; expect(yeokmaeSearcherFormula(x)).toBe(true);
    x = allTrue(); x.F = false; x.G = false; expect(yeokmaeSearcherFormula(x)).toBe(false);
    x = allTrue(); x.H = false; x.I = false; expect(yeokmaeSearcherFormula(x)).toBe(true);   // J 남음
    x = allTrue(); x.H = false; x.I = false; x.J = false; expect(yeokmaeSearcherFormula(x)).toBe(false);
    x = allTrue(); x.Q = false; expect(yeokmaeSearcherFormula(x)).toBe(true);
    x = allTrue(); x.Q = false; x.R = false; expect(yeokmaeSearcherFormula(x)).toBe(false);
  });
  it('((M and N) or (O and P)) — 그룹 우선순위 정확', () => {
    // M&N 참 → 통과(O,P 무관)
    let x = allTrue(); x.O = false; x.P = false; expect(yeokmaeSearcherFormula(x)).toBe(true);
    // O&P 참 → 통과(M,N 무관)
    x = allTrue(); x.M = false; x.N = false; expect(yeokmaeSearcherFormula(x)).toBe(true);
    // 각 그룹 한쪽씩만 참 → 두 그룹 다 false → 탈락 (잘못된 M&&(N||O)&&P 파싱이면 결과가 달라짐)
    x = allTrue(); x.N = false; x.O = false; expect(yeokmaeSearcherFormula(x)).toBe(false);   // M&N=false, O&P=false
    x = allTrue(); x.M = false; x.P = false; expect(yeokmaeSearcherFormula(x)).toBe(false);
    // M=false,N=true,O=true,P=false → (F)||(F)=false
    x = allTrue(); x.M = false; x.P = false; x.N = true; x.O = true; expect(yeokmaeSearcherFormula(x)).toBe(false);
  });
  it('M,N,O,P 모두 false → 탈락', () => {
    const x = allTrue(); x.M = x.N = x.O = x.P = false; expect(yeokmaeSearcherFormula(x)).toBe(false);
  });
});

describe('P0-32 검색기 — 데이터 부족/A~U 구조', () => {
  const flat = (n: number, price = 1000, vol = 1_000_000): Candle[] =>
    Array.from({ length: n }, (_, i) => ({ date: `2020-01-${i}`, open: price, high: price, low: price, close: price, volume: vol }));

  it('600봉 미만 → INSUFFICIENT_HISTORY', () => {
    const r = evaluateYeokmaeSearcher(flat(100), { excluded: false, isCommonStock: true, isEtfEtnSpac: false });
    expect(r.insufficientHistory).toBe(true); expect(r.matched).toBe(false);
  });
  it('A/B/C 시장플래그 반영(제외종목/비보통주/ETF → 탈락)', () => {
    const c = flat(600);
    expect(evaluateYeokmaeSearcher(c, { excluded: true, isCommonStock: true, isEtfEtnSpac: false }).conditions.A).toBe(false);
    expect(evaluateYeokmaeSearcher(c, { excluded: false, isCommonStock: false, isEtfEtnSpac: false }).conditions.B).toBe(false);
    expect(evaluateYeokmaeSearcher(c, { excluded: false, isCommonStock: true, isEtfEtnSpac: true }).conditions.C).toBe(false);
  });
  it('T 거래대금 — 평평한 저거래(close×volume < 10억) → T=false, 충분하면 true', () => {
    const low = evaluateYeokmaeSearcher(flat(600, 1000, 100), { excluded: false, isCommonStock: true, isEtfEtnSpac: false });
    expect(low.conditions.T).toBe(false);   // 1000×100=10만 < 10억
    const high = evaluateYeokmaeSearcher(flat(600, 100000, 100000), { excluded: false, isCommonStock: true, isEtfEtnSpac: false });
    expect(high.conditions.T).toBe(true);   // 100000×100000=100억 >= 10억
  });
  it('U 등락율 — 평평봉(고가=시가) → 0% ∈ [0,30] → U=true', () => {
    const r = evaluateYeokmaeSearcher(flat(600), { excluded: false, isCommonStock: true, isEtfEtnSpac: false });
    expect(r.conditions.U).toBe(true);
  });
  it('A~U 21개 조건이 모두 산출된다(일부 생략 없음)', () => {
    const r = evaluateYeokmaeSearcher(flat(600), { excluded: false, isCommonStock: true, isEtfEtnSpac: false });
    for (const k of ALL) expect(k in r.conditions).toBe(true);
  });
});
