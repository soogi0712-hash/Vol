// 역매공파 US SELL 게이트 + 실행 배선 (P0-34) — exit 판정 → 게이트 → executeSellOrder(us-seller) → 일지/원장 반영.
//   ⚠️ SELL 은 BUY 게이트(자본한도/신규중단)와 완전 분리 — 위험청산은 그 상태와 무관하게 평가. 원본 us-seller 안전경로 무변경.
//   ⚠️ 운영 exit(‑5/+8/20/‑15)은 원본 역매공파 SELL 아님(운영 risk policy). 대상=프로그램 원장(수동/기존 보유 제외).
//   실 POST 조건: LS_LIVE_TRADING ∧ YEOKMAE_US_LIVE_TRADING ∧ YEOKMAE_US_EXIT_CONFIRMED ∧ !dryRun ∧ 전 안전게이트.
import { executeSellOrder, type SellDeps, type SellParams, type SellOutcome } from './us-seller';
import type { OrderStore } from './order-store';
import type { YeokmaePositionStore, YeokmaePosition } from './yeokmae-position-store';
import type { USExitReason } from './yeokmae/us-live-core';
import type { TradeJournal } from './yeokmae-trade-journal';
import type { OrderExecClassification } from '../src/lib/ls-api';

export interface USSellGateInput {
  strategyTag: string;                 // YEOKMAE 만 실 SELL(UNKNOWN/LEGACY_BB 금지)
  exitAction: 'HOLD' | 'SELL';
  sellLive: boolean;                   // LS_LIVE_TRADING ∧ YEOKMAE_US_LIVE_TRADING(러너 postEnabled)
  exitConfirmed: boolean;              // YEOKMAE_US_EXIT_CONFIRMED
  dryRun: boolean;
  pendingSell: boolean;
  reconciliationOk: boolean;
}
export interface USSellGateResult { allowed: boolean; reasons: string[] }
// ⚠️ BUY 관련 게이트(자본한도/신규중단)는 여기서 절대 참조하지 않는다 — SELL 독립.
export function evaluateUSSellGate(g: USSellGateInput): USSellGateResult {
  const reasons: string[] = [];
  if (g.strategyTag !== 'YEOKMAE') reasons.push('NOT_YEOKMAE');
  if (g.exitAction !== 'SELL') reasons.push('EXIT_NOT_SELL');
  if (!g.sellLive) reasons.push('SELL_LIVE_OFF');
  if (!g.exitConfirmed) reasons.push('EXIT_NOT_CONFIRMED');
  if (g.dryRun) reasons.push('DRY_RUN');
  if (g.pendingSell) reasons.push('PENDING_SELL');
  if (!g.reconciliationOk) reasons.push('RECON_NOT_OK');
  return { allowed: reasons.length === 0, reasons };
}

export interface USSellIO {
  reconcile: (p: { exchcd: string; symbol: string; ordDate: string }) => Promise<{ ok: boolean; classification: OrderExecClassification | string }>;
  executeSell: (deps: SellDeps, params: SellParams) => Promise<SellOutcome>;
  sellDeps: SellDeps;
}
export interface USSellRunResult {
  allowed: boolean; gateReasons: string[];
  status: SellOutcome['status'] | 'GATE_BLOCKED'; ordNo: string | null;
  filledQty: number; avgFill: number; realizedPnLGross: number; remainingQty: number;
}
export async function runYeokmaeUSSell(io: USSellIO, ctx: {
  posStore: YeokmaePositionStore; orders: OrderStore; position: YeokmaePosition; exchcd: string; journal: TradeJournal; name: string;
  exitAction: 'HOLD' | 'SELL'; exitReason: USExitReason | null; pnlPct: number | null;
  currentPrice: number; etDate: string; sellLive: boolean; exitConfirmed: boolean; dryRun: boolean;
  log: (m: string) => void;
}): Promise<USSellRunResult> {
  const pos = ctx.position;
  const pendingSell = ctx.orders.pending.some(o => o.side === 'sell');
  let reconOk = false;
  try { const r = await io.reconcile({ exchcd: ctx.exchcd, symbol: pos.symbol, ordDate: ctx.etDate }); reconOk = r.ok; } catch { reconOk = false; }

  const gate = evaluateUSSellGate({
    strategyTag: pos.strategyTag, exitAction: ctx.exitAction, sellLive: ctx.sellLive,
    exitConfirmed: ctx.exitConfirmed, dryRun: ctx.dryRun, pendingSell, reconciliationOk: reconOk,
  });
  ctx.log(`[YEOKMAE-US-EXIT-GATE] symbol=${pos.symbol} qty=${pos.qty} entryAvg=${pos.entryAvgPrice.toFixed(2)} price=${ctx.currentPrice > 0 ? ctx.currentPrice.toFixed(2) : 'n/a'} pnl=${ctx.pnlPct == null ? 'n/a' : ctx.pnlPct.toFixed(2) + '%'} exitReason=${ctx.exitReason ?? '-'} pending=${pendingSell} reconciliation=${reconOk} sellLive=${ctx.sellLive} exitConfirmed=${ctx.exitConfirmed} dryRun=${ctx.dryRun} allowed=${gate.allowed}${gate.allowed ? '' : ` reasons=[${gate.reasons.join(',')}]`}`);

  if (!gate.allowed) return { allowed: false, gateReasons: gate.reasons, status: 'GATE_BLOCKED', ordNo: null, filledQty: 0, avgFill: 0, realizedPnLGross: 0, remainingQty: pos.qty };

  // 실 SELL — executeSellOrder(대사/신선매도가능/candle idempotency/pending/재전송금지). candle=etDate(일 1회).
  const outcome = await io.executeSell(io.sellDeps, { orders: ctx.orders, exchcd: ctx.exchcd, symbol: pos.symbol, candleDatetime: ctx.etDate, qty: pos.qty, price: ctx.currentPrice, etDate: ctx.etDate });
  ctx.log(`[YEOKMAE-US-SELL] symbol=${pos.symbol} requestedQty=${pos.qty} effectiveQty=${outcome.execQty} ordNo=${outcome.ordNo ?? '-'} status=${outcome.status}${outcome.abortCode ? ` abort=${outcome.abortCode}` : ''}`);

  let realizedPnLGross = 0; let remainingQty = pos.qty;
  if (outcome.execQty > 0) {
    const rr = ctx.posStore.recordSellFill(pos.symbol, { exitReason: (ctx.exitReason ?? 'MANUAL_EXTERNAL') as any, filledQty: outcome.execQty, avgFill: outcome.fillPrice, exitDate: ctx.etDate });
    ctx.posStore.flush();
    realizedPnLGross = rr.realizedPnLGross; remainingQty = rr.remainingQty;
    ctx.journal.append({ ts: new Date().toISOString(), market: 'US', side: 'SELL', symbol: pos.symbol, name: ctx.name, signalType: pos.matchedSignals ?? [], signalDate: pos.confirmedSignalDate ?? null, orderPrice: ctx.currentPrice, fillPrice: outcome.fillPrice, qty: outcome.execQty, investedKRW: null, exitReason: ctx.exitReason ?? null, realizedPnL: realizedPnLGross, ordNo: outcome.ordNo, status: outcome.status });
    ctx.journal.flush();
    ctx.log(`[YEOKMAE-US-FILL] symbol=${pos.symbol} filledQty=${outcome.execQty} avgFill=${outcome.fillPrice.toFixed(2)} realizedPnLGross=${realizedPnLGross.toFixed(2)} remainingQty=${remainingQty} exitReason=${ctx.exitReason ?? '-'}`);
  }
  return { allowed: true, gateReasons: [], status: outcome.status, ordNo: outcome.ordNo, filledQty: outcome.execQty, avgFill: outcome.fillPrice, realizedPnLGross, remainingQty };
}
