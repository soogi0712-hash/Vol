// 역매공파 KR SELL 게이트 + 실행 배선 (P0-33A) — exit 판정 → 게이트 → executeKRSellOrder → 일지/원장 반영.
//   ⚠️ SELL 은 BUY 게이트(자본한도/하루매수제한/신규중단)와 완전 분리 — 위험청산은 그 상태와 무관하게 항상 평가(item5).
//   실 POST 조건: LS_LIVE_TRADING ∧ YEOKMAE_KR_LIVE_TRADING ∧ 청산정책 확정(exitConfirmed) ∧ !dryRun ∧ 전 안전게이트.
import { executeKRSellOrder, type KRSellDeps, type KRSellParams, type KRSellOutcome } from './kr-seller';
import type { OrderStore } from './order-store';
import type { YeokmaePositionStore, YeokmaePosition } from './yeokmae-position-store';
import type { KRExitReason } from './yeokmae/kr-live-core';
import type { TradeJournal } from './yeokmae-trade-journal';

export interface KRSellGateInput {
  strategyTag: string;                 // YEOKMAE 만 실 SELL(UNKNOWN/LEGACY 금지)
  exitAction: 'HOLD' | 'SELL';
  sellLive: boolean;                   // LS_LIVE_TRADING ∧ YEOKMAE_KR_LIVE_TRADING
  exitConfirmed: boolean;              // YEOKMAE_KR_EXIT_CONFIRMED(사용자 손절/익절 확정)
  dryRun: boolean;
  pendingSell: boolean;
  reconciliationOk: boolean;
}
export interface KRSellGateResult { allowed: boolean; reasons: string[] }
// ⚠️ BUY 관련 게이트(자본한도/하루매수/신규중단)는 여기서 절대 참조하지 않는다 — SELL 독립(item5).
export function evaluateKRSellGate(g: KRSellGateInput): KRSellGateResult {
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

export interface KRSellIO {
  reconcile: (p: { shcode: string; ordDate: string }) => Promise<{ ok: boolean; classification: string }>;
  executeSell: (deps: KRSellDeps, params: KRSellParams) => Promise<KRSellOutcome>;
  sellDeps: KRSellDeps;
}
export interface KRSellRunResult {
  allowed: boolean; gateReasons: string[];
  status: KRSellOutcome['status'] | 'GATE_BLOCKED'; ordNo: string | null;
  filledQty: number; avgFill: number; realizedPnLGross: number; remainingQty: number;
}
export async function runYeokmaeKRSell(io: KRSellIO, ctx: {
  posStore: YeokmaePositionStore; orders: OrderStore; position: YeokmaePosition; journal: TradeJournal; name: string;
  exitAction: 'HOLD' | 'SELL'; exitReason: KRExitReason | null; pnlPct: number | null;
  currentPrice: number; krDate: string; sellLive: boolean; exitConfirmed: boolean; dryRun: boolean; mbrNo?: string;
  log: (m: string) => void;
}): Promise<KRSellRunResult> {
  const pos = ctx.position;
  const pendingSell = ctx.orders.pending.some(o => o.side === 'sell');
  let reconOk = false;
  try { const r = await io.reconcile({ shcode: pos.symbol, ordDate: ctx.krDate }); reconOk = r.ok; } catch { reconOk = false; }

  const gate = evaluateKRSellGate({
    strategyTag: pos.strategyTag, exitAction: ctx.exitAction, sellLive: ctx.sellLive,
    exitConfirmed: ctx.exitConfirmed, dryRun: ctx.dryRun, pendingSell, reconciliationOk: reconOk,
  });
  ctx.log(`[YEOKMAE-KR-EXIT-GATE] symbol=${pos.symbol} qty=${pos.qty} entryAvg=${pos.entryAvgPrice.toFixed(2)} price=${ctx.currentPrice > 0 ? ctx.currentPrice.toFixed(2) : 'n/a'} pnl=${ctx.pnlPct == null ? 'n/a' : ctx.pnlPct.toFixed(2) + '%'} exitReason=${ctx.exitReason ?? '-'} pending=${pendingSell} reconciliation=${reconOk} sellLive=${ctx.sellLive} exitConfirmed=${ctx.exitConfirmed} dryRun=${ctx.dryRun} allowed=${gate.allowed}${gate.allowed ? '' : ` reasons=[${gate.reasons.join(',')}]`}`);

  if (!gate.allowed) return { allowed: false, gateReasons: gate.reasons, status: 'GATE_BLOCKED', ordNo: null, filledQty: 0, avgFill: 0, realizedPnLGross: 0, remainingQty: pos.qty };

  // 실 SELL — executeKRSellOrder(대사/실매도가능/candle idempotency/pending/재전송금지). candle=krDate(일 1회).
  const outcome = await io.executeSell(io.sellDeps, { orders: ctx.orders, shcode: pos.symbol, candleDatetime: ctx.krDate, qty: pos.qty, price: ctx.currentPrice, krDate: ctx.krDate, mbrNo: ctx.mbrNo });
  ctx.log(`[YEOKMAE-KR-SELL] symbol=${pos.symbol} requestedQty=${pos.qty} effectiveQty=${outcome.execQty} ordNo=${outcome.ordNo ?? '-'} status=${outcome.status}${outcome.abortCode ? ` abort=${outcome.abortCode}` : ''}`);

  let realizedPnLGross = 0; let remainingQty = pos.qty;
  if (outcome.execQty > 0) {
    const rr = ctx.posStore.recordSellFill(pos.symbol, { exitReason: (ctx.exitReason ?? 'MANUAL_EXTERNAL') as any, filledQty: outcome.execQty, avgFill: outcome.fillPrice, exitDate: ctx.krDate });
    ctx.posStore.flush();
    realizedPnLGross = rr.realizedPnLGross; remainingQty = rr.remainingQty;
    ctx.journal.append({ ts: new Date(ctx.krDate.length === 8 ? `${ctx.krDate.slice(0, 4)}-${ctx.krDate.slice(4, 6)}-${ctx.krDate.slice(6, 8)}T00:00:00.000Z` : ctx.krDate).toISOString(), market: 'KR', side: 'SELL', symbol: pos.symbol, name: ctx.name, signalType: pos.matchedSignals ?? [], signalDate: pos.confirmedSignalDate ?? null, orderPrice: ctx.currentPrice, fillPrice: outcome.fillPrice, qty: outcome.execQty, investedKRW: null, exitReason: ctx.exitReason ?? null, realizedPnL: realizedPnLGross, ordNo: outcome.ordNo, status: outcome.status });
    ctx.journal.flush();
    ctx.log(`[YEOKMAE-KR-FILL] symbol=${pos.symbol} filledQty=${outcome.execQty} avgFill=${outcome.fillPrice.toFixed(2)} realizedPnLGross=${realizedPnLGross.toFixed(0)} remainingQty=${remainingQty} exitReason=${ctx.exitReason ?? '-'}`);
  }
  return { allowed: true, gateReasons: [], status: outcome.status, ordNo: outcome.ordNo, filledQty: outcome.execQty, avgFill: outcome.fillPrice, realizedPnLGross, remainingQty };
}
