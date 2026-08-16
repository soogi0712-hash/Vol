// 역매공파 지속실행 루프 코어 (P0-35, 시장무관) — 순수·테스트용. BUY/SELL 주기분리 + 보유 exit 사이클 + stale/MATCH 게이트.
//   ⚠️ 실주문 정책 무변경. 실 POST 는 러너가 주입하는 runSell 안에서만(안전경로 경유). 여기(코어)는 네트워크 IO 없음(주입식).
//   ⚠️ 매 cycle 일봉 재다운로드 금지 — BUY 후보는 persistent cache read only(러너 책임). KR/US 공용.
import { evaluateKRExit, type KRExitPolicy, type KRExitDecision } from './kr-live-core';
import type { YeokmaePosition } from '../yeokmae-position-store';

// ── 주기(ms) — 기존 LS rate limiter(최소 1.1s 직렬) 준수. SELL 짧게 / reconcile 중간 / BUY 낮은빈도(일봉). ──
export interface LoopIntervals { sellMs: number; reconcileMs: number; buyRecalcMs: number; loopLogMs: number; }
export function resolveLoopIntervals(env: NodeJS.ProcessEnv, prefix = 'US'): LoopIntervals {
  const num = (v: string | undefined, d: number, min: number) => { const n = Number(v); return Number.isFinite(n) && n >= min ? n : d; };
  const g = (k: string) => env[`${prefix}_LOOP_${k}`];
  return {
    sellMs: num(g('SELL_MS'), 7_000, 2_000),            // 보유관리(SELL/EXIT) — 짧은 주기(rate limiter ≥1.1s 준수)
    reconcileMs: num(g('RECONCILE_MS'), 60_000, 15_000), // holdings reconcile — 더 긴 주기
    buyRecalcMs: num(g('BUY_MS'), 1_800_000, 60_000),    // 일봉 BUY 후보 재계산+매수 — 낮은 빈도(캐시 read only, 재다운로드 없음)
    loopLogMs: num(g('LOG_MS'), 30_000, 5_000),          // CHECK 상세 로그 throttle
  };
}
// 다음 실행시점 도래 판정(순수). lastAt=null(미실행)이면 즉시 due.
export function isDue(lastAt: number | null, everyMs: number, now: number): boolean { return lastAt == null || (now - lastAt) >= everyMs; }

// ── 현재가(주입) — 임의/오래된 캐시 금지. stale 이면 SELL 판정 금지. ──
export interface Quote { ok: boolean; price: number; stale: boolean; reason?: string; }
export type ManagedExitSkip = 'NO_QUOTE' | 'STALE_QUOTE' | 'BROKER_UNKNOWN' | 'BROKER_MISMATCH' | 'SESSION_CLOSED' | null;

// 단일 포지션 exit 판정(순수) — MATCH 게이트 + stale 게이트 + 운영 exit(EMERGENCY>SL>TP>MAXHOLD). POST 아님.
//   brokerQty=null(reconcile 전) → 판정 보류(fail-closed). broker≠원장(외부변동) → 자동 exit 보류(수동보유 혼합 방지).
export function evaluateManagedExit(p: {
  position: YeokmaePosition; brokerQty: number | null; quote: Quote; policy: KRExitPolicy; sessionOrderable: boolean;
}): { decision: KRExitDecision | null; skip: ManagedExitSkip } {
  if (p.brokerQty == null) return { decision: null, skip: 'BROKER_UNKNOWN' };
  if (p.brokerQty !== p.position.qty) return { decision: null, skip: 'BROKER_MISMATCH' };
  if (!p.quote.ok || !(p.quote.price > 0)) return { decision: null, skip: 'NO_QUOTE' };
  if (p.quote.stale) return { decision: null, skip: 'STALE_QUOTE' };
  const decision = evaluateKRExit({ entryAvgPrice: p.position.entryAvgPrice, currentPrice: p.quote.price, holdDays: p.position.holdDays ?? 0, policy: p.policy });
  if (decision.action === 'SELL' && !p.sessionOrderable) return { decision, skip: 'SESSION_CLOSED' };
  return { decision, skip: null };
}

// ── 보유 exit 사이클(주입식) — 관리 포지션 전체 1회 평가. 실 POST 는 runSell 내부(안전경로) 에서만. ──
export interface ManagedSellCycleDeps {
  quote: (p: { symbol: string; exchcd: string }) => Promise<Quote>;
  brokerQtyOf: (symbol: string) => number | null;   // 마지막 reconcile 스냅샷(더 긴 주기). null=아직 미확보.
  runSell: (a: { position: YeokmaePosition; price: number; decision: KRExitDecision }) => Promise<{ posted: boolean }>;
  log: (m: string) => void;
}
export interface ManagedSellCycleResult { evaluated: number; sells: number; holds: number; skippedStale: number; skippedUnmatched: number; deferredClosed: number; }
export async function runManagedSellCycle(deps: ManagedSellCycleDeps, ctx: {
  positions: readonly YeokmaePosition[]; policy: KRExitPolicy; sessionOrderable: boolean; verbose: boolean; tag: 'KR' | 'US';
}): Promise<ManagedSellCycleResult> {
  const res: ManagedSellCycleResult = { evaluated: 0, sells: 0, holds: 0, skippedStale: 0, skippedUnmatched: 0, deferredClosed: 0 };
  const T = ctx.tag;
  for (const pos of ctx.positions) {
    res.evaluated++;
    const brokerQty = deps.brokerQtyOf(pos.symbol);
    if (brokerQty == null) { res.skippedUnmatched++; if (ctx.verbose) deps.log(`[YEOKMAE-${T}-EXIT-CHECK] symbol=${pos.symbol} skip=BROKER_UNKNOWN(reconcile 대기)`); continue; }
    if (brokerQty !== pos.qty) { res.skippedUnmatched++; deps.log(`[YEOKMAE-${T}-EXIT-CHECK] symbol=${pos.symbol} skip=BROKER_MISMATCH(ledger=${pos.qty} broker=${brokerQty}) — 자동 exit 보류(수동/외부변동 보호)`); continue; }
    const quote = await deps.quote({ symbol: pos.symbol, exchcd: pos.exchcd });
    const ev = evaluateManagedExit({ position: pos, brokerQty, quote, policy: ctx.policy, sessionOrderable: ctx.sessionOrderable });
    if (ev.skip === 'STALE_QUOTE' || ev.skip === 'NO_QUOTE') { res.skippedStale++; deps.log(`[YEOKMAE-${T}-EXIT-CHECK] symbol=${pos.symbol} skip=${ev.skip}(현재가 stale/미확보 → SELL 보류)${quote.reason ? ` reason=${quote.reason}` : ''}`); continue; }
    const d = ev.decision!;
    if (d.action !== 'SELL') { res.holds++; if (ctx.verbose) deps.log(`[YEOKMAE-${T}-EXIT-CHECK] symbol=${pos.symbol} price=${quote.price} pnl=${d.pnlPct == null ? 'n/a' : d.pnlPct.toFixed(2) + '%'} HOLD`); continue; }
    if (ev.skip === 'SESSION_CLOSED') { res.deferredClosed++; deps.log(`[YEOKMAE-${T}-EXIT-GATE] symbol=${pos.symbol} exit=${d.reason} pnl=${d.pnlPct == null ? 'n/a' : d.pnlPct.toFixed(2) + '%'} → 정규장 아님(주문보류, 다음 정규장 POST)`); continue; }
    const out = await deps.runSell({ position: pos, price: quote.price, decision: d });
    if (out.posted) res.sells++;
  }
  return res;
}
