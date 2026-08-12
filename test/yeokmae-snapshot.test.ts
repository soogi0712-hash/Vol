import { describe, it, expect } from 'vitest';
import { buildYeokmaeSnapshot, snapshotToMarkdown, YEOKMAE_SELL_INVESTIGATION } from '../src/lib/yeokmae';
import { reverseAlignmentSeries, insufficientSeries } from '../src/lib/yeokmae/fixtures';

describe('P0-33A 스냅샷 빌더', () => {
  it('600 미만 → null', () => {
    expect(buildYeokmaeSnapshot('X', insufficientSeries(300))).toBeNull();
  });
  it('충분 시 지표/A~U/5신호 sub-condition 캡처', () => {
    const s = buildYeokmaeSnapshot('RV', reverseAlignmentSeries(760))!;
    expect(s).not.toBeNull();
    expect(s.symbol).toBe('RV');
    expect(s.bars).toBe(760);
    // EMA 7종 모두 존재
    for (const k of ['e5', 'e20', 'e60', 'e112', 'e224', 'e448', 'e600'] as const) expect(Number.isFinite(s.ema[k])).toBe(true);
    // 역배열(단조하락) true
    expect(s.reverseAlignment).toBe(true);
    // A~U 21개 조건
    expect(Object.keys(s.searcher.conditions).length).toBeGreaterThanOrEqual(21);
    // 5신호 각각 sub-condition 존재
    for (const t of ['112_ORIGINAL', '224_ORIGINAL', '112_UPGRADE', '224_UPGRADE', 'LONG_TERM'] as const) {
      expect(s.signals[t]).toBeDefined();
      expect(Object.keys(s.signals[t].conditions).length).toBeGreaterThan(0);
    }
    // semantics 미검증 플래그
    expect(s.semanticsVerified).toBe(false);
    expect(s.unverifiedExternal).toEqual(['A', 'B', 'C', 'T']);
    // confirmedDate = 마지막 봉 date, OHLCV 포함
    expect(s.confirmedDate).toBe(reverseAlignmentSeries(760)[759].date);
    expect(s.ohlcv.close).toBeGreaterThan(0);
    // bb40 / ichimoku 필드
    expect(s.bb40).toHaveProperty('upper');
    expect(s.ichimoku).toHaveProperty('span1');
  });
  it('markdown 렌더 — 표/EMA/A~U 포함', () => {
    const s = buildYeokmaeSnapshot('RV', reverseAlignmentSeries(720))!;
    const md = snapshotToMarkdown(s);
    expect(md).toContain('EMA:');
    expect(md).toContain('SEARCHER A~U');
    expect(md).toContain('| signal | matched | sub-conditions |');
  });
});

describe('P0-33A SELL 정책 조사 결론', () => {
  it('자료 기반 SELL 없음(확정)', () => {
    expect(YEOKMAE_SELL_INVESTIGATION.hasExitFormulaInSource).toBe(false);
    expect(YEOKMAE_SELL_INVESTIGATION.finding).toBe('NO_SOURCE_BASED_SELL');
    expect(YEOKMAE_SELL_INVESTIGATION.note).toContain('BB SELL');
  });
});
