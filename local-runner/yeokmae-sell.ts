// 역매공파 P0-34 자동 SELL 실주문 배선 (P0-35US10) — 지속러너 exit 신호를 검증된 us-seller.executeSellOrder 에 연결.
//   ⚠️ 원본 P0-34 정책/임계값(‑5%/+8%/20일)·us-seller 안전경로 무변경. 여기는 '게이트 + 배선 + 로그'만 담당.
//   실 POST 조건: LS_LIVE_TRADING ∧ YEOKMAE_SELL_LIVE ∧ strategyTag=YEOKMAE ∧ exit=SELL ∧ 전 안전게이트 통과 ∧ !dryRun.
//   보유 위험청산은 BUY validation(YEOKMAE_STRATEGY_VALIDATED)과 분리 — 그 값 때문에 SELL 을 막지 않는다.
import { executeSellOrder, type SellDeps, type SellParams, type SellOutcome } from './us-seller';
import type { OrderStore } from './order-store';
import type { YeokmaePositionStore, YeokmaePosition } from './yeokmae-position-store';
import type { YeokmaeExitReason } from '../src/lib/yeokmae';
import type { OrderExecClassification } from '../src/lib/ls-api';

// ── 순수 SELL 게이트(테스트용) — 전량청산 수량 min(programQty, freshSellable) + 모든 차단조건. ──
export interface YeokmaeSellGateInput {
  strategyTag: string;                 // YEOKMAE 만 실 SELL. UNKNOWN/LEGACY_BB 절대 금지.
  exitAction: 'HOLD' | 'SELL' | 'NO_QUOTE';
  sellLive: boolean;                   // LS_LIVE_TRADING ∧ YEOKMAE_SELL_LIVE
  dryRun: boolean;
  freshSellableQty: number;            // 실계좌 신선 매도가능수량(COSOQ00201)
  programQty: number;                  // 원장 보유수량
  pendingSell: boolean;                // 미체결 SELL 존재(중복 매도 금지)
  reconciliationOk: boolean;           // COSAQ00102 SUCCESS/EMPTY
}
export interface YeokmaeSellGateResult { allowed: boolean; sellQty: number; reasons: string[] }
export function evaluateYeokmaeSellGate(g: YeokmaeSellGateInput): YeokmaeSellGateResult {
  const reasons: string[] = [];
  if (g.strategyTag !== 'YEOKMAE') reasons.push('NOT_YEOKMAE');   // AIOT/AMSF/LEGACY 절대 SELL 금지
  if (g.exitAction !== 'SELL') reasons.push('EXIT_NOT_SELL');
  if (!g.sellLive) reasons.push('SELL_LIVE_OFF');
  if (g.dryRun) reasons.push('DRY_RUN');
  if (g.pendingSell) reasons.push('PENDING_SELL');
  if (!g.reconciliationOk) reasons.push('RECON_NOT_OK');
  // 전량청산 수량(P0-34 rule8) = min(원장수량, 실계좌 매도가능). 부분익절 없음.
  const sellQty = Math.max(0, Math.min(Math.floor(g.programQty), Math.floor(g.freshSellableQty)));
  if (sellQty < 1) reasons.push('NO_SELLABLE_QTY');
  return { allowed: reasons.length === 0, sellQty, reasons };
}

// ── IO 주입 인터페이스(테스트에서 mock, 실행에서 LS 함수 배선) ──
export interface YeokmaeSellIO {
  freshSellable: (p: { exchcd: string; symbol: string }) => Promise<{ ok: boolean; qty: number }>;
  reconcile: (p: { exchcd: string; symbol: string; ordDate: string }) => Promise<{ ok: boolean; classification: OrderExecClassification }>;
  executeSell: (deps: SellDeps, params: SellParams) => Promise<SellOutcome>;
  sellDeps: SellDeps;
}
export interface YeokmaeSellRunResult {
  allowed: boolean; gateReasons: string[]; requestedQty: number;
  status: SellOutcome['status'] | 'GATE_BLOCKED'; ordNo: string | null;
  filledQty: number; avgFill: number; realizedPnLGross: number; remainingQty: number;
}

export async function runYeokmaeSell(io: YeokmaeSellIO, ctx: {
  posStore: YeokmaePositionStore; orders: OrderStore; position: YeokmaePosition; exchcd: string;
  exitAction: 'HOLD' | 'SELL' | 'NO_QUOTE'; exitReason: YeokmaeExitReason | null; pnlPct: number | null;
  currentPrice: number; etDate: string; sellLive: boolean; dryRun: boolean; log: (m: string) => void;
}): Promise<YeokmaeSellRunResult> {
  const pos = ctx.position;
  const pendingSell = ctx.orders.pending.some(o => o.side === 'sell');
  // 게이트 진단용 신선 매도가능/대사 선조회(POST 아님). executeSellOrder 가 내부에서 다시 권위 재조회한다.
  let freshSellableQty = 0; let reconOk = false;
  try { const s = await io.freshSellable({ exchcd: ctx.exchcd, symbol: pos.symbol }); freshSellableQty = s.ok ? s.qty : 0; } catch { freshSellableQty = 0; }
  try { const r = await io.reconcile({ exchcd: ctx.exchcd, symbol: pos.symbol, ordDate: ctx.etDate }); reconOk = r.ok; } catch { reconOk = false; }

  const gate = evaluateYeokmaeSellGate({
    strategyTag: pos.strategyTag, exitAction: ctx.exitAction, sellLive: ctx.sellLive, dryRun: ctx.dryRun,
    freshSellableQty, programQty: pos.qty, pendingSell, reconciliationOk: reconOk,
  });
  ctx.log(`[YEOKMAE-LIVE-SELL-GATE] symbol=${pos.symbol} qty=${pos.qty} entryAvg=${pos.entryAvgPrice.toFixed(2)} currentPrice=${ctx.currentPrice > 0 ? ctx.currentPrice.toFixed(2) : 'n/a'} pnl=${ctx.pnlPct == null ? 'n/a' : ctx.pnlPct.toFixed(2) + '%'} exitReason=${ctx.exitReason ?? '-'} freshSellable=${freshSellableQty} pending=${pendingSell} reconciliation=${reconOk} sellLive=${ctx.sellLive} dryRun=${ctx.dryRun} sellQty=${gate.sellQty} allowed=${gate.allowed}${gate.allowed ? '' : ` reasons=[${gate.reasons.join(',')}]`}`);

  if (!gate.allowed) {
    return { allowed: false, gateReasons: gate.reasons, requestedQty: gate.sellQty, status: 'GATE_BLOCKED', ordNo: null, filledQty: 0, avgFill: 0, realizedPnLGross: 0, remainingQty: pos.qty };
  }

  // 실 SELL — us-seller 안전경로(대사/신선매도가능/candle idempotency/pending/재전송금지) 전부 경유. candle=etDate(일 1회).
  const outcome = await io.executeSell(io.sellDeps, { orders: ctx.orders, exchcd: ctx.exchcd, symbol: pos.symbol, candleDatetime: ctx.etDate, qty: gate.sellQty, price: ctx.currentPrice, etDate: ctx.etDate });
  ctx.log(`[YEOKMAE-LIVE-SELL-ORDER] symbol=${pos.symbol} requestedQty=${gate.sellQty} effectiveQty=${outcome.execQty} ordNo=${outcome.ordNo ?? '-'} status=${outcome.status}${outcome.abortCode ? ` abort=${outcome.abortCode}` : ''}`);

  let realizedPnLGross = 0; let remainingQty = pos.qty;
  if (outcome.execQty > 0) {
    const rr = ctx.posStore.recordSellFill(pos.symbol, { exitReason: ctx.exitReason ?? 'MANUAL_EXTERNAL', filledQty: outcome.execQty, avgFill: outcome.fillPrice, exitDate: ctx.etDate });
    ctx.posStore.flush();
    realizedPnLGross = rr.realizedPnLGross; remainingQty = rr.remainingQty;
    ctx.log(`[YEOKMAE-LIVE-SELL-FILL] symbol=${pos.symbol} filledQty=${outcome.execQty} avgFill=${outcome.fillPrice.toFixed(2)} realizedPnLGross=${realizedPnLGross.toFixed(2)} remainingQty=${remainingQty} exitReason=${ctx.exitReason ?? '-'}`);
  }
  return { allowed: true, gateReasons: [], requestedQty: gate.sellQty, status: outcome.status, ordNo: outcome.ordNo, filledQty: outcome.execQty, avgFill: outcome.fillPrice, realizedPnLGross, remainingQty };
}
