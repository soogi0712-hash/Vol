// 역매공파 진단 스냅샷 (P0-33A) — HTS 대조용 상세 스냅샷(순수). 원본 수식/조건 무변경.
//   실제 [YEOKMAE-REAL-SIGNAL] 종목의 confirmedDate 기준 지표·A~U·5신호 sub-condition 을 한 객체로 캡처.
import { computeYeokmaeIndicators } from './signals';
import { evaluateAllYeokmae } from './signals';
import { evaluateYeokmaeSearcher, YEOKMAE_DEFAULT_MIN_TURNOVER_KRW, type YeokmaeMarketFlags } from './searcher';
import { DEFAULT_SEMANTICS, YEOKMAE_MIN_BARS, type YeokmaeSemantics, type YeokmaeSignalType } from './types';
import type { Candle } from './hts';

export interface YeokmaeSnapshot {
  symbol: string;
  confirmedDate: string;
  bars: number;
  ohlcv: { open: number; high: number; low: number; close: number; volume: number };
  ema: { e5: number; e20: number; e60: number; e112: number; e224: number; e448: number; e600: number };
  blueLine: number;
  bb40: { upper: number; lower: number };
  ichimoku: { span1: number; span2: number };
  reverseAlignment: boolean;                       // EMA112<=224<=448
  searcher: { conditions: Record<string, boolean>; matched: boolean; failed: string[] };
  signals: Record<YeokmaeSignalType, { matched: boolean; totNow: boolean; conditions: Record<string, boolean> }>;
  semantics: YeokmaeSemantics;                     // 사용된 의미(기본값)
  semanticsVerified: false;                        // ⚠️ 실 HTS 대조 전까지 항상 false
  unverifiedExternal: string[];                    // [A,B,C,T]
}

const SIGNAL_TYPES: YeokmaeSignalType[] = ['112_ORIGINAL', '224_ORIGINAL', '112_UPGRADE', '224_UPGRADE', 'LONG_TERM'];

// confirmed 봉(마지막)이 기준. 600 미만이면 null. semantics 는 기본값(미검증) — env A/B 는 러너가 넘길 수 있음.
export function buildYeokmaeSnapshot(
  symbol: string, candles: readonly Candle[],
  opts: { semantics?: YeokmaeSemantics; flags?: YeokmaeMarketFlags } = {},
): YeokmaeSnapshot | null {
  const n = candles.length;
  if (n < YEOKMAE_MIN_BARS) return null;
  const sem = opts.semantics ?? DEFAULT_SEMANTICS;
  const flags: YeokmaeMarketFlags = opts.flags ?? { excluded: false, isCommonStock: true, isEtfEtnSpac: false };
  const I = computeYeokmaeIndicators(candles, { semantics: sem });
  const i = n - 1;
  const last = candles[i];
  const searcher = evaluateYeokmaeSearcher(candles, flags, { minTurnoverKRW: YEOKMAE_DEFAULT_MIN_TURNOVER_KRW, semantics: sem });
  const all = evaluateAllYeokmae(candles);
  const signals = {} as YeokmaeSnapshot['signals'];
  for (const t of SIGNAL_TYPES) {
    const s = all[t];
    signals[t] = { matched: s.matched, totNow: s.totNow, conditions: s.conditions };
  }
  return {
    symbol, confirmedDate: last.date, bars: n,
    ohlcv: { open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume },
    ema: { e5: I.e1[i], e20: I.e2[i], e60: I.e3[i], e112: I.e4[i], e224: I.e5[i], e448: I.e6[i], e600: I.e7[i] },
    blueLine: I.blueX[i],
    bb40: { upper: I.bolUp40[i], lower: I.bolDn40[i] },
    ichimoku: { span1: I.span1[i], span2: I.span2[i] },
    reverseAlignment: Number.isFinite(I.e4[i]) && Number.isFinite(I.e5[i]) && Number.isFinite(I.e6[i]) && I.e4[i] <= I.e5[i] && I.e5[i] <= I.e6[i],
    searcher: { conditions: searcher.conditions, matched: searcher.matched, failed: searcher.failed },
    signals,
    semantics: sem, semanticsVerified: false, unverifiedExternal: ['A', 'B', 'C', 'T'],
  };
}

// ── SELL 정책 결론 (P0-33A rule 5) — 자료 재조사 결과 ──
//   역매공파 원자료(검색기 A~U + 5화살표)는 전부 '진입(BUY) 신호'다. crossdn/dead-cross 는 진입 sub-condition
//   (noRecentDeadCross 필터)로만 쓰이며, 명시적 청산(SELL) 수식은 원자료에 존재하지 않는다.
export const YEOKMAE_SELL_INVESTIGATION = {
  hasExitFormulaInSource: false,
  finding: 'NO_SOURCE_BASED_SELL',   // 자료 기반 SELL 없음(확정)
  note: '검색기/5신호는 모두 BUY. crossdn 은 진입 필터(noRecentDeadCross)로만 사용. BB SELL 은 역매공파 포지션에 적용 금지. 임의 손절/익절 추가 금지.',
} as const;

// [YEOKMAE-SNAPSHOT] 사람이 읽는 마크다운(HTS 대조표).
export function snapshotToMarkdown(s: YeokmaeSnapshot): string {
  const f = (x: number) => Number.isFinite(x) ? x.toFixed(4) : 'NaN';
  const au = 'ABCDEFGHIJKLMNOPQRSTU'.split('').map(k => `${k}=${s.searcher.conditions[k] ? 1 : 0}`).join(' ');
  const lines: string[] = [];
  lines.push(`### ${s.symbol} @ ${s.confirmedDate} (bars=${s.bars})`);
  lines.push('');
  lines.push(`- OHLCV: O=${f(s.ohlcv.open)} H=${f(s.ohlcv.high)} L=${f(s.ohlcv.low)} C=${f(s.ohlcv.close)} V=${s.ohlcv.volume}`);
  lines.push(`- EMA: 5=${f(s.ema.e5)} 20=${f(s.ema.e20)} 60=${f(s.ema.e60)} 112=${f(s.ema.e112)} 224=${f(s.ema.e224)} 448=${f(s.ema.e448)} 600=${f(s.ema.e600)}`);
  lines.push(`- reverseAlignment(112<=224<=448)=${s.reverseAlignment}`);
  lines.push(`- blueLine=${f(s.blueLine)}  BB40: upper=${f(s.bb40.upper)} lower=${f(s.bb40.lower)}  Ichimoku: span1=${f(s.ichimoku.span1)} span2=${f(s.ichimoku.span2)}`);
  lines.push(`- SEARCHER A~U: ${au} → formulaMatched=${s.searcher.matched} failed=[${s.searcher.failed.join(',')}]`);
  lines.push(`- semantics(미검증): SHIFT=${s.semantics.shiftDir} STDDEV=${s.semantics.stddevPopulation ? 'pop' : 'sample'} ICHI=${s.semantics.ichimokuDisplaced ? 'disp' : 'nodisp'} SEED=${s.semantics.emaSeed}`);
  lines.push(`- unverifiedExternal: [${s.unverifiedExternal.join(',')}] (A/B/C 매핑·T 환율 미검증)`);
  lines.push('');
  lines.push('| signal | matched | sub-conditions |');
  lines.push('|---|---|---|');
  for (const t of SIGNAL_TYPES) {
    const sg = s.signals[t];
    const sub = Object.entries(sg.conditions).map(([k, v]) => `${k}=${v ? 'T' : 'F'}`).join(', ');
    lines.push(`| ${t} | ${sg.matched} | ${sub} |`);
  }
  return lines.join('\n');
}
