// 국내 전 종목 라운드로빈 배치 스캔 + 15분봉 캐시 + BUY 후보 순위 (P0-22).
//   - 전체 eligible 를 커서로 라운드로빈: nextBatch(size) 가 다음 N종목 반환(끝에서 wrap).
//   - 같은 15분 확정봉은 재평가 금지(candle cache): shcode→마지막 평가한 확정봉 datetime.
//   - BUY 후보가 여럿이면 거래대금/유동성/BB강도/RSI강도 로 순위(요구 9).
// 순수 로직만(REST 호출/전략 계산은 러너가 주입). 결정적 테스트 가능.

// KST 기준, 방금 종료된(확정된) 15분봉의 시작 시각 문자열 YYYYMMDDHHMM. 시장 전체가 동일 경계.
export function krConfirmedBucket(nowMs: number): string {
  const k = new Date(nowMs + 9 * 3600 * 1000);
  const y = k.getUTCFullYear(); const mo = k.getUTCMonth() + 1; const d = k.getUTCDate();
  const totalMin = k.getUTCHours() * 60 + k.getUTCMinutes();
  const confirmed = Math.floor(totalMin / 15) * 15 - 15;   // 직전 확정 슬롯 시작(분)
  const cm = Math.max(0, confirmed);
  const hh = Math.floor(cm / 60); const mm = cm % 60;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${y}${p2(mo)}${p2(d)}${p2(hh)}${p2(mm)}`;
}

export class RoundRobinScanner {
  private symbols: string[];
  private cursor = 0;
  private cyclesCompleted = 0;

  constructor(symbols: string[]) { this.symbols = [...symbols]; }

  get size(): number { return this.symbols.length; }
  get position(): number { return this.cursor; }
  get cycles(): number { return this.cyclesCompleted; }

  /** 다음 배치(최대 size개)를 반환하고 커서를 전진. 끝에 닿으면 wrap 하고 cyclesCompleted 증가. */
  nextBatch(size: number): string[] {
    if (this.symbols.length === 0) return [];
    const n = Math.min(Math.max(1, size), this.symbols.length);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      out.push(this.symbols[this.cursor]);
      this.cursor++;
      if (this.cursor >= this.symbols.length) { this.cursor = 0; this.cyclesCompleted++; }
    }
    return out;
  }

  /** 유니버스 교체 시 커서 보존(범위 밖이면 0). */
  setSymbols(symbols: string[]): void {
    this.symbols = [...symbols];
    if (this.cursor >= this.symbols.length) this.cursor = 0;
  }
}

// 15분 확정봉 캐시 — 같은 종목의 같은 확정봉은 한 번만 평가.
export class ConfirmedCandleCache {
  private last = new Map<string, string>();   // shcode → 마지막 평가한 확정봉 datetime
  /** 이 종목의 이 확정봉을 아직 평가하지 않았으면 true(그리고 기록). 이미 평가했으면 false. */
  shouldEvaluate(shcode: string, confirmedDatetime: string): boolean {
    if (!confirmedDatetime) return false;
    if (this.last.get(shcode) === confirmedDatetime) return false;
    this.last.set(shcode, confirmedDatetime);
    return true;
  }
  get trackedCount(): number { return this.last.size; }
}

// lightweight prefilter(요구 7) — 마스터/시세 기본 유효성만. 거래대금 상위 N 컷은 하지 않는다.
export interface PrefilterInput { lastPrice: number; volume: number; tradingValue: number; halted?: boolean; }
export function passesPrefilter(p: PrefilterInput): boolean {
  return p.lastPrice > 0 && p.volume > 0 && p.tradingValue > 0 && !p.halted;
}

// BUY 후보 + 순위 재료.
export interface BuyCandidate {
  shcode: string;
  tradingValue: number;    // 거래대금(원): close*volume 근사 or 실제
  volume: number;          // 유동성
  bbBreakStrength: number; // BB 하단 이탈/복귀 강도(0~1+, 클수록 강함)
  rsiReboundStrength: number; // RSI 반등 강도(예: 30 - rsi 저점, 또는 rsi 상승분)
}
export interface RankedCandidate extends BuyCandidate { rank: number; score: number; }

// 순위: 거래대금 > 유동성 > BB강도 > RSI강도 (사전식). 상위부터 실거래 게이트 적용(요구 9).
export function rankBuyCandidates(cands: BuyCandidate[]): RankedCandidate[] {
  const sorted = [...cands].sort((a, b) =>
    b.tradingValue - a.tradingValue ||
    b.volume - a.volume ||
    b.bbBreakStrength - a.bbBreakStrength ||
    b.rsiReboundStrength - a.rsiReboundStrength,
  );
  return sorted.map((c, i) => ({ ...c, rank: i + 1, score: c.tradingValue }));
}

// ── KR P0 긴급진단: 거래 0건 원인 단계별 누적 카운터 ([KR-NO-TRADE-COUNTS]) ──
// 스캔 파이프라인 각 단계에서 몇 종목이 어디서 걸렀는지 누적한다(추측이 아니라 로그로 확정).
//   SCANNED         : t8412(15분봉) 실제 조회 시도 종목 수
//   HISTORY_OK      : 조회 성공(classifyChart=OK) 종목 수
//   WARMUP          : 조회는 됐으나 확정봉<MIN_CONFIRMED/데이터품질 미달로 전략평가 불가(prefilter/validate 실패)
//   NO_BUY_SIGNAL   : 전략평가 완료 · BUY 아님
//   BUY_SIGNAL      : 전략평가 완료 · signal=BUY (후보 추가)
//   CASH_GATE       : 현금조회 실패/부족으로 주문 차단
//   PENDING         : 미체결 존재로 신규 차단
//   DAILY_LIMIT     : 하루 매수 한도로 차단
//   DUPLICATE_CANDLE: 동일 확정봉 재주문 차단
//   POST_ATTEMPT    : 실주문 함수 호출(러너 게이트 통과, live=true) 수
//   POST_SUCCESS    : 주문 접수 성공(placed-filled/partial/pending) 수
//   FILLED          : 전량 체결 수
export interface KRNoTradeCounts {
  SCANNED: number; HISTORY_OK: number; WARMUP: number; NO_BUY_SIGNAL: number; BUY_SIGNAL: number;
  CASH_GATE: number; PENDING: number; DAILY_LIMIT: number; DUPLICATE_CANDLE: number;
  POST_ATTEMPT: number; POST_SUCCESS: number; FILLED: number;
}
export function newKRNoTradeCounts(): KRNoTradeCounts {
  return { SCANNED: 0, HISTORY_OK: 0, WARMUP: 0, NO_BUY_SIGNAL: 0, BUY_SIGNAL: 0, CASH_GATE: 0, PENDING: 0, DAILY_LIMIT: 0, DUPLICATE_CANDLE: 0, POST_ATTEMPT: 0, POST_SUCCESS: 0, FILLED: 0 };
}
// [KR-NO-TRADE-COUNTS] 한 줄 로그(요구 형식). extra 로 유니크 스캔/커버리지/모드 등 컨텍스트 부가.
export function formatKRNoTradeCounts(c: KRNoTradeCounts, extra = ''): string {
  return `[KR-NO-TRADE-COUNTS] SCANNED=${c.SCANNED} HISTORY_OK=${c.HISTORY_OK} WARMUP=${c.WARMUP}`
    + ` NO_BUY_SIGNAL=${c.NO_BUY_SIGNAL} BUY_SIGNAL=${c.BUY_SIGNAL} CASH_GATE=${c.CASH_GATE} PENDING=${c.PENDING}`
    + ` DAILY_LIMIT=${c.DAILY_LIMIT} DUPLICATE_CANDLE=${c.DUPLICATE_CANDLE} POST_ATTEMPT=${c.POST_ATTEMPT}`
    + ` POST_SUCCESS=${c.POST_SUCCESS} FILLED=${c.FILLED}${extra ? ` · ${extra}` : ''}`;
}

// BB 하단 이탈/복귀 강도: (lower - low)/lower 가 클수록 강한 이탈 후 종가 복귀(close>=lower)면 가점.
export function bbBreakStrength(low: number, close: number, lower: number): number {
  if (!(lower > 0)) return 0;
  const dip = Math.max(0, (lower - low) / lower);   // 하단 아래로 얼마나 팠나
  const recovered = close >= lower ? 1 : 0;         // 종가가 하단 위로 복귀?
  return dip * (0.5 + 0.5 * recovered);
}

// RSI 반등 강도: 최근 RSI 저점 대비 현재 상승분 + 과매도(30 이하) 깊이.
export function rsiReboundStrength(rsiSeries: number[]): number {
  if (rsiSeries.length < 2) return 0;
  const cur = rsiSeries[rsiSeries.length - 1];
  const recent = rsiSeries.slice(-6);
  const trough = Math.min(...recent);
  const oversold = Math.max(0, 30 - trough);   // 저점이 과매도일수록 가점
  const rebound = Math.max(0, cur - trough);   // 저점 대비 반등폭
  return oversold + rebound;
}
