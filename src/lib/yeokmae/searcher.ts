// 역매공파 검색기 A~U — 검색기 최종본 이미지의 조건을 1:1 코드화 (P0-32). 최종 AND/OR 구조 고정.
// 최종식(이미지 = source of truth):
//   A and B and C and (D or E) and (F or G) and (H or I or J) and K and L
//   and ((M and N) or (O and P)) and (Q or R) and S and T and U
// 지수이평 = EMA. "지수 1 이평" = EMA(1) = 종가. "현재가" = 0봉전 종가. "0봉전" = 현재봉(마지막).
import { eavg, bollingerUp, crossup, ichimokuSpans, type Candle } from './hts';
import { type YeokmaeSemantics, DEFAULT_SEMANTICS } from './types';

// A/B/C 는 시장 마스터 플래그(종목구분/위험등급)로 판정 — 시장별로 다르므로 외부 주입.
export interface YeokmaeMarketFlags {
  excluded: boolean;         // A: 제외종목(정리매매/관리/투자위험/투자경고/거래정지/환기 등) 해당 → 제외
  isCommonStock: boolean;    // B: 주권구분 보통주 여부
  isEtfEtnSpac: boolean;     // C: ETF/ETN/기업인수목적(SPAC) → 결과제외
}
export interface YeokmaeSearcherOpts {
  minTurnoverKRW?: number;   // T: 10봉 평균 거래대금 하한(원). 기본 100,000만원 = 1,000,000,000원
  turnoverKRW?: number[];    // 봉별 원화거래대금(US 는 price×volume×LS환율). 미지정 시 close×volume(KR 원화)
  semantics?: YeokmaeSemantics;   // P0-32A: EMA seed / stddev pop / ichimoku 변위 A/B
}
export interface YeokmaeSearcherResult {
  matched: boolean;
  conditions: Record<string, boolean>;   // A..U
  failed: string[];                        // 탈락 조건들
  insufficientHistory: boolean;
}
export const YEOKMAE_DEFAULT_MIN_TURNOVER_KRW = 1_000_000_000;   // 100,000만원
const SEARCHER_MIN_BARS = 600;   // EMA600(G) + 배열 50봉 검사에 필요

// 마지막봉(i=n-1) 기준 A~U 평가. flags 는 시장별 외부 판정. matched=최종식.
export function evaluateYeokmaeSearcher(candles: readonly Candle[], flags: YeokmaeMarketFlags, opts: YeokmaeSearcherOpts = {}): YeokmaeSearcherResult {
  const n = candles.length;
  if (n < SEARCHER_MIN_BARS) return { matched: false, conditions: {}, failed: ['INSUFFICIENT_HISTORY'], insufficientHistory: true };
  const i = n - 1;
  const S = opts.semantics ?? DEFAULT_SEMANTICS;
  const o = candles.map(k => k.open); const c = candles.map(k => k.close);
  const h = candles.map(k => k.high); const l = candles.map(k => k.low); const v = candles.map(k => k.volume);
  const em = (arr: readonly number[], p: number) => eavg(arr, p, S.emaSeed);
  const e1 = c;   // 지수 1 이평 = 종가(EMA period 1)
  const e5 = em(c, 5), e20 = em(c, 20), e60 = em(c, 60), e112 = em(c, 112), e224 = em(c, 224), e448 = em(c, 448), e600 = em(c, 600);
  const tp = candles.map(k => (k.close + k.high + k.low) / 3);
  const bolUp40 = bollingerUp(tp, 2, 40, S.stddevPopulation);
  const { span1, span2 } = ichimokuSpans(h, l, 9, 26, 52, S.ichimokuDisplaced ? 26 : 0);
  const turnover = opts.turnoverKRW ?? c.map((_, k) => c[k] * v[k]);
  const minTurn = opts.minTurnoverKRW ?? YEOKMAE_DEFAULT_MIN_TURNOVER_KRW;
  const price = c[i];   // 현재가 = 0봉전 종가
  const cond: Record<string, boolean> = {};

  // A/B/C — 시장 플래그
  cond.A = !flags.excluded;             // 제외종목 아님
  cond.B = flags.isCommonStock;         // 보통주
  cond.C = !flags.isEtfEtnSpac;         // ETF/ETN/SPAC 아님

  // D: 최근50봉 내, 1봉전 종가 대비 0봉전 고가 등락율 12~30% 발생 1회 이상
  let dCnt = 0, eCnt = 0;
  for (let k = Math.max(1, n - 50); k < n; k++) {
    const pr = (c[k - 1] > 0) ? (h[k] - c[k - 1]) / c[k - 1] * 100 : NaN;
    if (pr >= 12 && pr <= 30) dCnt++;
  }
  for (let k = n - 50; k < n; k++) {
    if (k < 0) continue;
    const pr2 = (o[k] > 0) ? (h[k] - o[k]) / o[k] * 100 : NaN;   // E: 0봉전 시가 대비 0봉전 고가
    if (pr2 >= 12 && pr2 <= 30) eCnt++;
  }
  cond.D = dCnt >= 1 && dCnt <= 50;
  cond.E = eCnt >= 1 && eCnt <= 50;

  // F/G: 최근50봉 '전부'(50~50회) 지수이평 역배열. F=112<=224<=448, G=224<=448<=600
  const allAlign = (a: number[], b: number[], d: number[]) => {
    for (let k = n - 50; k < n; k++) { if (k < 0) return false; if (![a[k], b[k], d[k]].every(Number.isFinite)) return false; if (!(a[k] <= b[k] && b[k] <= d[k])) return false; }
    return true;
  };
  cond.F = allAlign(e112, e224, e448);
  cond.G = allAlign(e224, e448, e600);

  // H/I/J/K/N/P: 이동평균간 비교(현재봉)
  cond.H = e5[i] > e20[i];
  cond.I = e5[i] > e60[i];
  cond.J = e20[i] > e60[i];
  cond.K = e448[i] > e1[i];             // 지수448 > 지수1(종가)
  cond.N = e1[i] > e60[i];              // 지수1(종가) > 지수60
  cond.P = e1[i] > e112[i];             // 지수1(종가) > 지수112

  // L/M/O: 이평 평균대비 현재가 대비율(%) 범위. 20,20,20→EMA20 / 112→EMA112 / 224→EMA224
  const ratio = (ma: number) => (ma > 0 ? price / ma * 100 : NaN);
  cond.L = ratio(e20[i]) >= 90 && ratio(e20[i]) <= 110;
  cond.M = ratio(e112[i]) >= 85 && ratio(e112[i]) <= 115;
  cond.O = ratio(e224[i]) >= 85 && ratio(e224[i]) <= 115;

  // Q/R: 일목균형표 종가 > 선행1/선행2 (기준선 비교)
  cond.Q = Number.isFinite(span1[i]) && c[i] > span1[i];
  cond.R = Number.isFinite(span2[i]) && c[i] > span2[i];

  // S: 최근10봉 내 Bollinger(40,2) 상한선 고가 상향돌파 1회 이상
  const cu = crossup(h, bolUp40);
  let sCnt = 0; for (let k = Math.max(0, n - 10); k < n; k++) if (cu[k]) sCnt++;
  cond.S = sCnt >= 1 && sCnt <= 10;

  // T: 10봉 평균 거래대금 >= minTurnoverKRW
  let tSum = 0, tCnt = 0; for (let k = Math.max(0, n - 10); k < n; k++) { if (Number.isFinite(turnover[k])) { tSum += turnover[k]; tCnt++; } }
  const avgTurn = tCnt > 0 ? tSum / tCnt : 0;
  cond.T = avgTurn >= minTurn;

  // U: 0봉전 시가 대비 0봉전 고가 등락율 0~30%
  const uPr = (o[i] > 0) ? (h[i] - o[i]) / o[i] * 100 : NaN;
  cond.U = uPr >= 0 && uPr <= 30;

  const matched = yeokmaeSearcherFormula(cond);
  const failed = Object.entries(cond).filter(([, val]) => !val).map(([k]) => k);
  return { matched, conditions: cond, failed, insufficientHistory: false };
}

// ── 최종 AND/OR 식 (검색기 최종본 이미지 = source of truth) — 괄호 우선순위 고정(회귀테스트 대상) ──
//   A and B and C and (D or E) and (F or G) and (H or I or J) and K and L
//   and ((M and N) or (O and P)) and (Q or R) and S and T and U
export function yeokmaeSearcherFormula(x: Record<string, boolean>): boolean {
  return !!x.A && !!x.B && !!x.C
    && (!!x.D || !!x.E)
    && (!!x.F || !!x.G)
    && (!!x.H || !!x.I || !!x.J)
    && !!x.K
    && !!x.L
    && ((!!x.M && !!x.N) || (!!x.O && !!x.P))
    && (!!x.Q || !!x.R)
    && !!x.S && !!x.T && !!x.U;
}
