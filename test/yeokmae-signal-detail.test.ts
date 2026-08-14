// P0-35KR2 — 신호 수집(SEARCHER_PASS||arrow) + 우선순위(112/224_UPGRADE 먼저) + 상세포맷 검증.
import { describe, it, expect } from 'vitest';
import { collectRankedSignals, signalTier, activeSignalLabels, formatKRSignalDetail, signalTierCounts } from '../local-runner/yeokmae/signal-detail';
import type { SymbolDiscovery } from '../local-runner/yeokmae/discovery';
import type { YeokmaeSnapshot } from '../src/lib/yeokmae';

const A0 = { '112_ORIGINAL': false, '224_ORIGINAL': false, '112_UPGRADE': false, '224_UPGRADE': false, 'LONG_TERM': false };
function disc(symbol: string, over: Partial<SymbolDiscovery> & { arrows?: Partial<typeof A0> } = {}): SymbolDiscovery {
  const { arrows: arrowsOver, ...rest } = over;
  const arrows = { ...A0, ...(arrowsOver ?? {}) } as SymbolDiscovery['arrows'];
  const anyArrow = Object.values(arrows).some(Boolean);
  return {
    symbol, ready: true, reverse: true, bars: 800, lastConfirmed: '2026-08-13',
    ema112: 100, ema224: 110, ema448: 120,
    conditions: {}, searcherFormulaPass: false,
    verifiedFailed: over.verifiedFailed ?? [], unverifiedExternal: ['A', 'B', 'C', 'T'], verifiedFailedCount: (over.verifiedFailed ?? []).length,
    ...rest,
    arrows, anyArrow, arrowCount: Object.values(arrows).filter(Boolean).length,
  } as SymbolDiscovery;
}

describe('P0-35KR2 signalTier — UPGRADE > arrow > searcher-only', () => {
  it('112_UPGRADE 또는 224_UPGRADE → UPGRADE', () => {
    expect(signalTier(disc('A', { arrows: { '112_UPGRADE': true } }))).toBe('UPGRADE');
    expect(signalTier(disc('B', { arrows: { '224_UPGRADE': true } }))).toBe('UPGRADE');
  });
  it('기타 arrow(112_ORIGINAL/LONG_TERM) → ARROW', () => {
    expect(signalTier(disc('C', { arrows: { '112_ORIGINAL': true } }))).toBe('ARROW');
    expect(signalTier(disc('D', { arrows: { 'LONG_TERM': true } }))).toBe('ARROW');
  });
  it('arrow 없고 searcherFormulaPass만 → SEARCHER_ONLY', () => {
    expect(signalTier(disc('E', { searcherFormulaPass: true }))).toBe('SEARCHER_ONLY');
  });
});

describe('P0-35KR2 collectRankedSignals — 수집조건 + 정렬', () => {
  it('SEARCHER_PASS 또는 arrow 하나라도 → 수집. 아무것도 아니면 제외', () => {
    const results = [
      disc('NONE'),                                          // 제외
      disc('SRC', { searcherFormulaPass: true }),            // 수집(searcher-only)
      disc('ORIG', { arrows: { '112_ORIGINAL': true } }),    // 수집(arrow)
      disc('UPG', { arrows: { '224_UPGRADE': true } }),      // 수집(upgrade)
    ];
    const ranked = collectRankedSignals(results);
    expect(ranked.map(d => d.symbol)).toEqual(['UPG', 'ORIG', 'SRC']);   // UPGRADE, ARROW, SEARCHER_ONLY 순
    expect(ranked.find(d => d.symbol === 'NONE')).toBeUndefined();
  });
  it('동일 tier 는 symbol 오름차순', () => {
    const ranked = collectRankedSignals([
      disc('ZZZ', { arrows: { '112_UPGRADE': true } }),
      disc('AAA', { arrows: { '112_UPGRADE': true } }),
    ]);
    expect(ranked.map(d => d.symbol)).toEqual(['AAA', 'ZZZ']);
  });
  it('ready=false 또는 reverse=false 는 수집 안 함(1차 미통과)', () => {
    const ranked = collectRankedSignals([
      disc('NR', { reverse: false, arrows: { '112_UPGRADE': true } }),
      disc('NRDY', { ready: false, searcherFormulaPass: true }),
    ]);
    expect(ranked).toHaveLength(0);
  });
});

describe('P0-35KR2 activeSignalLabels + counts', () => {
  it('업그레이드 라벨 우선 + SEARCHER_PASS 부가', () => {
    const d = disc('X', { arrows: { '112_UPGRADE': true, 'LONG_TERM': true }, searcherFormulaPass: true });
    expect(activeSignalLabels(d)).toEqual(['112_UPGRADE', 'LONG_TERM', 'SEARCHER_PASS']);
  });
  it('tier 별 카운트', () => {
    const ranked = collectRankedSignals([
      disc('U1', { arrows: { '112_UPGRADE': true } }), disc('U2', { arrows: { '224_UPGRADE': true } }),
      disc('AR', { arrows: { '112_ORIGINAL': true } }), disc('SR', { searcherFormulaPass: true }),
    ]);
    expect(signalTierCounts(ranked)).toEqual({ upgrade: 2, arrow: 1, searcherOnly: 1, total: 4 });
  });
});

describe('P0-35KR2 formatKRSignalDetail — item4 필드', () => {
  const snap = {
    symbol: '005930', confirmedDate: '2026-08-13', bars: 1002,
    ohlcv: { open: 61000, high: 61800, low: 60800, close: 61400, volume: 12000000 },
    ema: { e5: 61000, e20: 60500, e60: 60000, e112: 100.5, e224: 110.25, e448: 120.75, e600: 130 },
    blueLine: 59500.5, bb40: { upper: 63000.25, lower: 57000 }, ichimoku: { span1: 60000, span2: 59000 },
    reverseAlignment: true,
    searcher: { conditions: { A: true, B: true, C: true, D: false }, matched: false, failed: ['D', 'T'] },
    signals: {} as any, semantics: {} as any, semanticsVerified: false, unverifiedExternal: ['A', 'B', 'C', 'T'],
  } as unknown as YeokmaeSnapshot;

  it('close/EMA112·224·448/blueLine/BB40upper/A~U failed 를 포함', () => {
    const d = disc('005930', { arrows: { '112_UPGRADE': true }, verifiedFailed: ['D'] });
    const lines = formatKRSignalDetail(d, snap, '삼성전자').join('\n');
    expect(lines).toContain('symbol=005930');
    expect(lines).toContain('name=삼성전자');
    expect(lines).toContain('signalType=[112_UPGRADE');
    expect(lines).toContain('signalDate=2026-08-13');
    expect(lines).toContain('close=61400.00');
    expect(lines).toContain('EMA112=100.50');
    expect(lines).toContain('EMA224=110.25');
    expect(lines).toContain('EMA448=120.75');
    expect(lines).toContain('blueLine=59500.50');
    expect(lines).toContain('BB40upper=63000.25');
    expect(lines).toContain('failedConditions=[D,T]');
    expect(lines).toContain('verifiedFailed(core)=[D]');
  });
  it('snapshot 없으면 close/blueLine n/a (bars<600)', () => {
    const d = disc('X', { searcherFormulaPass: true });
    const lines = formatKRSignalDetail(d, null, '테스트').join('\n');
    expect(lines).toContain('close=n/a');
    expect(lines).toContain('snapshot 불가');
  });
});
