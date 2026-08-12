import { describe, it, expect } from 'vitest';
import {
  analyzeSymbol, summarize, rankNearMatches, conditionsLine, UNVERIFIED_EXTERNAL, SIGNAL_TYPES,
  type SymbolDiscovery,
} from '../local-runner/yeokmae/discovery';
import { reverseAlignmentSeries, healthySeries, insufficientSeries } from '../src/lib/yeokmae/fixtures';

describe('P0-32G analyzeSymbol — 계층화/원본 무변경', () => {
  it('상승추세: reverse=false → 2차 계산 안 함(조건 빈값)', () => {
    const d = analyzeSymbol('UP', healthySeries(760));
    expect(d.ready).toBe(true);
    expect(d.reverse).toBe(false);
    expect(d.anyArrow).toBe(false);
    expect(Object.keys(d.conditions).length).toBe(0);   // 2차 미계산
  });
  it('600 미만: ready=false', () => {
    const d = analyzeSymbol('SHORT', insufficientSeries(300));
    expect(d.ready).toBe(false);
    expect(d.reverse).toBe(false);
  });
  it('역배열: 2차 계산 수행, A~U 채워짐, unverified 항상 [A,B,C,T]', () => {
    const d = analyzeSymbol('RV', reverseAlignmentSeries(760));
    expect(d.reverse).toBe(true);
    expect(Object.keys(d.conditions).length).toBeGreaterThanOrEqual(21);
    expect(d.unverifiedExternal).toEqual([...UNVERIFIED_EXTERNAL]);
    // verifiedFailed 는 external(A/B/C/T) 을 포함하지 않는다.
    for (const c of UNVERIFIED_EXTERNAL) expect(d.verifiedFailed).not.toContain(c);
    expect(d.verifiedFailedCount).toBe(d.verifiedFailed.length);
  });
  it('원본 조건 완화 없음 — 단조하락 합성에서 신호 억지로 만들지 않음(arrowCount 는 실제 계산값)', () => {
    const d = analyzeSymbol('RV', reverseAlignmentSeries(760));
    expect(d.arrowCount).toBe(SIGNAL_TYPES.filter(t => d.arrows[t]).length);
    expect(d.anyArrow).toBe(d.arrowCount > 0);
  });
});

describe('P0-32G summarize / rankNearMatches', () => {
  const mk = (symbol: string, reverse: boolean, arrows: Partial<Record<string, boolean>>, vf: string[], searcher = false): SymbolDiscovery => {
    const arr: any = { '112_ORIGINAL': false, '224_ORIGINAL': false, '112_UPGRADE': false, '224_UPGRADE': false, 'LONG_TERM': false, ...arrows };
    const arrowCount = SIGNAL_TYPES.filter(t => arr[t]).length;
    return {
      symbol, ready: true, reverse, bars: 700, lastConfirmed: '2026-08-11', ema112: 1, ema224: 2, ema448: 3,
      conditions: {}, searcherFormulaPass: searcher, arrows: arr, anyArrow: arrowCount > 0, arrowCount,
      verifiedFailed: vf, unverifiedExternal: [...UNVERIFIED_EXTERNAL], verifiedFailedCount: vf.length,
    };
  };
  it('summary 집계', () => {
    const ds = [
      mk('A', true, { '112_ORIGINAL': true }, []),
      mk('B', true, {}, ['E', 'S']),
      mk('C', false, {}, []),
      mk('D', true, { 'LONG_TERM': true }, [], true),
    ];
    const s = summarize(10, ds);
    expect(s.cached).toBe(10);
    expect(s.reverse).toBe(3);
    expect(s.arrow112Original).toBe(1);
    expect(s.longTerm).toBe(1);
    expect(s.anyArrow).toBe(2);
    expect(s.searcherFormulaPass).toBe(1);
    expect(s.bothSearcherAndArrow).toBe(1);   // D: searcher+arrow
  });
  it('rankNearMatches — reverse+무화살표만, verifiedFailedCount 오름차순', () => {
    const ds = [
      mk('HAS_ARROW', true, { '112_ORIGINAL': true }, ['E']),   // 화살표 있음 → 제외
      mk('FAR', true, {}, ['D', 'E', 'S']),
      mk('NEAR', true, {}, ['S']),
      mk('NOTREV', false, {}, []),                              // 역배열 아님 → 제외
    ];
    const r = rankNearMatches(ds);
    expect(r.map(d => d.symbol)).toEqual(['NEAR', 'FAR']);      // 1 < 3
    expect(r[0].verifiedFailedCount).toBe(1);
  });
  it('conditionsLine 포맷', () => {
    expect(conditionsLine({ A: true, B: false })).toBe('A=1B=0C=0D=0E=0F=0G=0H=0I=0J=0K=0L=0M=0N=0O=0P=0Q=0R=0S=0T=0U=0');
  });
});
