// 역매공파 신호 타입 + 원본 기본 변수값 (P0-32). 값은 신호.txt 원문 그대로. env/config 로 조정 가능하되 기본=원자료.
export type YeokmaeSignalType = '112_ORIGINAL' | '224_ORIGINAL' | '112_UPGRADE' | '224_UPGRADE' | 'LONG_TERM';

// 신호 평가 결과 — 최종 boolean 뿐 아니라 sub-condition 별 결과 포함(왜 탈락했는지 알 수 있게).
export interface YeokmaeSignalResult {
  type: YeokmaeSignalType;
  matched: boolean;                 // tot(i) && !tot(i-1) [중장기: && !tot(i-2) && !tot(i-3)]
  totNow: boolean;                  // 현재봉 tot
  totPrev: boolean;                 // 직전봉 tot (중복 화살표 차단용)
  conditions: Record<string, boolean>;   // 각 sub-condition 결과(탈락 원인 추적)
  insufficientHistory: boolean;
}

// 112 원본 기본값(신호.txt) — 매집퍼센트12/파란점기간26/매집봉위치50/파란점이격15/일일이이격15/양봉의크기5
export interface Yeokmae112OrigVars { accumPct: number; blueDotPeriod: number; accumBarPos: number; blueDotDev: number; dev112: number; bullSize: number }
export const DEFAULT_112_ORIGINAL: Yeokmae112OrigVars = { accumPct: 12, blueDotPeriod: 26, accumBarPos: 50, blueDotDev: 15, dev112: 15, bullSize: 5 };

// 224 원본 — 파란점이격15/이이사이격15/양봉의크기5
export interface Yeokmae224OrigVars { accumPct: number; blueDotPeriod: number; accumBarPos: number; blueDotDev: number; dev224: number; bullSize: number }
export const DEFAULT_224_ORIGINAL: Yeokmae224OrigVars = { accumPct: 12, blueDotPeriod: 26, accumBarPos: 50, blueDotDev: 15, dev224: 15, bullSize: 5 };

// 112 업글 — 일일이이격8/양봉의크기7/파란점이격5
export const DEFAULT_112_UPGRADE: Yeokmae112OrigVars = { accumPct: 12, blueDotPeriod: 26, accumBarPos: 50, blueDotDev: 5, dev112: 8, bullSize: 7 };
// 224 업글 — 이이사이격8/양봉의크기7/파란점이격5
export const DEFAULT_224_UPGRADE: Yeokmae224OrigVars = { accumPct: 12, blueDotPeriod: 26, accumBarPos: 50, blueDotDev: 5, dev224: 8, bullSize: 7 };

// 중장기 — 매집12/파란점이격15/일일이이격15/이이사이격15/볼밴하이격5/낙폭오이격15/역배열기간200/일일이이사10/이이사육백20/주가기준=시가
export interface YeokmaeLongTermVars {
  accumPct: number; blueDotDev: number; dev112: number; dev224: number; bbLowDev: number; dropEma5Dev: number;
  reverseAlignPeriod: number; gap112to224: number; gap224to600: number; priceBasis: 'open' | 'close';
}
export const DEFAULT_LONG_TERM: YeokmaeLongTermVars = {
  accumPct: 12, blueDotDev: 15, dev112: 15, dev224: 15, bbLowDev: 5, dropEma5Dev: 15,
  reverseAlignPeriod: 200, gap112to224: 10, gap224to600: 20, priceBasis: 'open',
};

// 최소 필요 일봉수(EMA600 + Ichimoku/Bollinger warmup 여유). 부족하면 INSUFFICIENT_HISTORY.
export const YEOKMAE_MIN_BARS = 600;   // EMA600 유효 + 신호(매집봉위치50/역배열200 등) 참조에 최소 필요

// ── P0-32A: HTS 함수 의미 미확정 4종 — A/B 검증용 설정 ([SHIFT-DIR][STDDEV-POP][ICHI-DISP][SEED]) ──
// 기본값 = P0-32 표준 해석. 실제 HTS 수치/화살표와 대조해 어느 조합이 일치하는지 A/B 테스트하고 [YEOKMAE-SEMANTICS] 보고.
export interface YeokmaeSemantics {
  emaSeed: 'first' | 'sma';        // eavg 초기값: first=첫값(표준) / sma=첫 n개 SMA
  shiftDir: 'past' | 'future';     // shift(x,n): past=x[i-n](표준·과거참조) / future=x[i+n](look-ahead·repaint 위험)
  stddevPopulation: boolean;       // Stddevmv flag0: true=모집단(÷N,표준) / false=표본(÷N-1)
  ichimokuDisplaced: boolean;      // 선행스팬: true=26봉 미래변위 span[i]=raw[i-26](표준) / false=변위없음 raw[i]
}
export const DEFAULT_SEMANTICS: YeokmaeSemantics = { emaSeed: 'first', shiftDir: 'past', stddevPopulation: true, ichimokuDisplaced: true };
