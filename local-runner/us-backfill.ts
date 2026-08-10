// 미국 유니버스 과거 확정봉 백필 — READY 풀 가속 (P0-26).
//   신규 로테이션 종목이 실시간으로 5시간 기다려 20봉을 쌓는 대신, 과거 15분봉(g3203)을 백필해 즉시 READY 화.
//   ⚠️ LS 개인 g3203 = 1req/s 한도 절대 미초과(중앙 큐 1개 + rate limiter). 이미 저장된 봉은 재수집 금지(upsert dedup).
//   ⚠️ 20개 이상 '실제 확정봉' 확보 시에만 READY. 가짜봉/복제봉/형성봉 금지(getLSUS15MinPaged 가 형성봉 제외).

export const BACKFILL_MIN_CONFIRMED = 20;   // READY 기준(전략 요구, 불변)
export const BACKFILL_TARGET = 22;          // 형성봉 제외 후 >=20 확보용 여유

export interface BackfillCand { symbol: string; confirmed: number; failedUntilMs: number; }

// 우선순위(요구 3): confirmed<20 중 20에 가장 가까운 종목 우선(적은 호출로 READY 도달). 실패 백오프 중이면 제외.
export function pickBackfillTarget(cands: BackfillCand[], nowMs: number, minConfirmed = BACKFILL_MIN_CONFIRMED): string | null {
  let best: BackfillCand | null = null;
  for (const c of cands) {
    if (c.confirmed >= minConfirmed) continue;      // 이미 READY → 백필 불필요(요구 1·3)
    if (c.failedUntilMs > nowMs) continue;          // 실패/빈응답 백오프 중 → 스킵(요구 7)
    if (!best || c.confirmed > best.confirmed || (c.confirmed === best.confirmed && c.symbol < best.symbol)) best = c;
  }
  return best ? best.symbol : null;
}

// g3203 1요청당 확보 봉수(비압축 qrycnt=5)를 근거로 종목당 필요 호출수 + READY 풀 성장률 계산(요구 12).
export interface BackfillCapacity {
  eligible: number; alreadyReady: number; toBackfill: number;
  candlesPerRequest: number; callsPerSymbol: number; reqPerSec: number;
  symbolsPerHour: number; hoursForAll: number;
}
export function computeBackfillCapacity(o: { eligible: number; alreadyReady: number; reqPerSec: number; candlesPerRequest?: number; target?: number }): BackfillCapacity {
  const candlesPerRequest = Math.max(1, o.candlesPerRequest ?? 5);   // g3203 비압축 qrycnt=5
  const target = o.target ?? BACKFILL_TARGET;
  const callsPerSymbol = Math.max(1, Math.ceil(target / candlesPerRequest));
  const reqPerSec = Math.max(1, o.reqPerSec);
  const toBackfill = Math.max(0, o.eligible - o.alreadyReady);
  const symbolsPerHour = Math.floor((reqPerSec * 3600) / callsPerSymbol);
  const hoursForAll = symbolsPerHour > 0 ? toBackfill / symbolsPerHour : Infinity;
  return { eligible: o.eligible, alreadyReady: o.alreadyReady, toBackfill, candlesPerRequest, callsPerSymbol, reqPerSec, symbolsPerHour, hoursForAll };
}

// 백필 진행 통계(요구 8).
export class BackfillStats {
  requests = 0; success = 0; empty = 0; error = 0;
  line(reqPerSec: number): string {
    return `reqPerSec=${reqPerSec} requests=${this.requests} success=${this.success} empty=${this.empty} error=${this.error}`;
  }
}
