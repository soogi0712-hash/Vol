// 역매공파 KR 실전 코어 (P0-33) — 순수·테스트용. BUY 후보선정 / 자본가드 / A·B·C 마스터연결. 주문 0.
//   ⚠️ 원본 검색기/5신호 수식 무변경. 신용·미수 금지(cash-only). UPGRADE 만 실 BUY(ORIGINAL/LONG_TERM 관찰).
import { isPreferredStock } from '../kr-universe';
import { LS_KR_SELL_TR_CONFIRMED } from '../../src/lib/ls-api';
import type { YeokmaeMarketFlags } from '../../src/lib/yeokmae';
import type { SymbolDiscovery } from './discovery';

// ── KR 실주문 최종 게이트 (P0-33B) — KR 전용 명시적 승인경로. ──
//   ⚠️ YEOKMAE_STRATEGY_VALIDATED(코드상수 false, 하드블록)를 요구하지 않는다 — PILOT 과 동일하게 '별도 사용자 승인'.
//     US 는 이 경로로 열리지 않는다(KR 전용). REAL_ORDER_FROM_YEOKMAE 는 표시라벨일 뿐 게이트가 아니다.
//   KR_BUY_PATH_READY: CSPAT00601 매수 실계정 확인(00040) + cash-only 게이트 + candle idempotency 완비.
//   KR_SELL_PATH_READY: CSPAT00601 매도('1') 공식확인(LS_KR_SELL_TR_CONFIRMED) + t0424 매도가능수량 + fail-closed.
export const KR_BUY_PATH_READY = true;
export const KR_SELL_PATH_READY = LS_KR_SELL_TR_CONFIRMED;
export interface KRRealOrderInput { liveTrading: boolean; yeokmaeLive: boolean; krLive: boolean; exitConfirmed: boolean; }
export interface KRRealOrderResult { enabled: boolean; reasons: string[]; buyPathReady: boolean; sellPathReady: boolean; }
export function krRealOrderEnabled(p: KRRealOrderInput): KRRealOrderResult {
  const reasons: string[] = [];
  if (!p.liveTrading) reasons.push('LS_LIVE_TRADING_off');
  if (!p.yeokmaeLive) reasons.push('YEOKMAE_LIVE_TRADING_off');
  if (!p.krLive) reasons.push('YEOKMAE_KR_LIVE_TRADING_off');
  if (!p.exitConfirmed) reasons.push('YEOKMAE_KR_EXIT_CONFIRMED_off');
  if (!KR_BUY_PATH_READY) reasons.push('KR_BUY_PATH_NOT_READY');
  if (!KR_SELL_PATH_READY) reasons.push('KR_SELL_PATH_NOT_READY');
  return { enabled: reasons.length === 0, reasons, buyPathReady: KR_BUY_PATH_READY, sellPathReady: KR_SELL_PATH_READY };
}

// ── item6: A/B/C 를 t8436 마스터 실필드로 연결(permissive 기본값 대신 실제 파생). ──
//   A(제외종목): t8436 은 관리/거래정지/투자위험 실시간 플래그를 제공하지 않음(추측 금지) → 전일종가<=0(신규/정지 성격)
//     만 마스터 단계에서 제외. 실 관리/정지는 런타임 liveness(데이터/거래량 0)로 자연 배제 — A 는 '부분연결'로 보고.
//   B(보통주): isPreferredStock 휴리스틱(종목명 접미/코드 끝자리)의 여집합.
//   C(ETF/ETN/SPAC): t8436 etf/spac 플래그 + 종목명 '스팩'.
export interface KRMasterRowLite { shcode: string; hname: string; etf?: boolean; spac?: boolean; prevClose?: number }
export function krMasterFlags(row: KRMasterRowLite): YeokmaeMarketFlags {
  return {
    excluded: !(row.prevClose == null || row.prevClose > 0),         // 전일종가<=0 → 제외(신규/거래정지 성격)
    isCommonStock: !isPreferredStock({ shcode: row.shcode, hname: row.hname }),
    isEtfEtnSpac: !!row.etf || !!row.spac || /스팩/.test(row.hname ?? ''),
  };
}
// A 실시간(관리/거래정지) 연결 가능 여부 — 현재 t8436 미제공 → false(부분연결). 시작로그/보고에 명시.
export const KR_A_REALTIME_HALT_CONNECTED = false;

// ── item1/2/4: UPGRADE-only 실 BUY 후보 선정. CONFIRMED 신호만(discovery 는 confirmed 봉으로 계산됨). ──
//   112_UPGRADE 또는 224_UPGRADE 만. ORIGINAL/LONG_TERM 은 관찰(여기서 제외). 둘 다 UPGRADE 면 최우선.
//   보유/pending/당일주문 종목은 재진입 금지(제외).
export interface KRBuyCandidate {
  symbol: string; tier: 'BOTH_UPGRADE' | 'UPGRADE_112' | 'UPGRADE_224';
  signalTypes: string[]; signalDate: string | null;
  ema112: number; ema224: number; ema448: number;
}
export function selectKRBuyCandidates(
  discoveries: readonly SymbolDiscovery[],
  exclude: { heldSymbols?: Set<string>; pendingSymbols?: Set<string>; orderedTodaySymbols?: Set<string> } = {},
): KRBuyCandidate[] {
  const held = exclude.heldSymbols ?? new Set<string>();
  const pending = exclude.pendingSymbols ?? new Set<string>();
  const orderedToday = exclude.orderedTodaySymbols ?? new Set<string>();
  const out: KRBuyCandidate[] = [];
  for (const d of discoveries) {
    if (!d.ready || !d.reverse) continue;
    const u112 = d.arrows['112_UPGRADE'], u224 = d.arrows['224_UPGRADE'];
    if (!u112 && !u224) continue;                                   // UPGRADE 아니면 실 BUY 후보 아님(ORIGINAL 자동대체 금지)
    if (held.has(d.symbol) || pending.has(d.symbol) || orderedToday.has(d.symbol)) continue;   // 재진입 금지
    const signalTypes = (['112_UPGRADE', '224_UPGRADE', '112_ORIGINAL', '224_ORIGINAL', 'LONG_TERM'] as const).filter(t => d.arrows[t]);
    out.push({
      symbol: d.symbol, tier: (u112 && u224) ? 'BOTH_UPGRADE' : (u112 ? 'UPGRADE_112' : 'UPGRADE_224'),
      signalTypes, signalDate: d.lastConfirmed,
      ema112: d.ema112, ema224: d.ema224, ema448: d.ema448,
    });
  }
  // 둘 다 UPGRADE 최우선 → 그다음 symbol 오름차순(결정적)
  const rank = (t: KRBuyCandidate['tier']) => t === 'BOTH_UPGRADE' ? 0 : 1;
  return out.sort((a, b) => rank(a.tier) - rank(b.tier) || a.symbol.localeCompare(b.symbol));
}

// ── item3/4: KR 자본가드(KRW-native). perTrade(10만) 상한 + total(100만) 초과금지 + cash-only(현금 주문가능) 결합. ──
//   신용/미수 절대 금지 → orderableCash(실 주문가능현금) 상한. 총자본 = 보유원금 + pending + 신규 <= totalCapitalKRW.
//   한도 직전엔 수량 축소(finalQty=min(예산, 자본여력, 현금여력)).
export interface KRCapitalGuard {
  totalCapitalKRW: number; perTradeKRW: number; investedKRW: number; pendingKRW: number; orderableCash: number;
  remainingCapitalKRW: number; budgetQty: number; capacityQty: number; cashQty: number;
  finalQty: number; candidateKRW: number; canNewBuy: boolean; reason: string;
}
export function computeKRCapitalGuard(p: {
  totalCapitalKRW: number; perTradeKRW: number; investedKRW: number; pendingKRW: number;
  price: number; orderableCash: number;
}): KRCapitalGuard {
  const invested = Math.max(0, p.investedKRW), pending = Math.max(0, p.pendingKRW);
  const remainingCapitalKRW = p.totalCapitalKRW - invested - pending;
  const base = { totalCapitalKRW: p.totalCapitalKRW, perTradeKRW: p.perTradeKRW, investedKRW: invested, pendingKRW: pending, orderableCash: p.orderableCash, remainingCapitalKRW };
  const zero = (reason: string): KRCapitalGuard => ({ ...base, budgetQty: 0, capacityQty: 0, cashQty: 0, finalQty: 0, candidateKRW: 0, canNewBuy: false, reason });
  if (!(p.price > 0)) return zero('PRICE_UNAVAILABLE');
  if (!(p.perTradeKRW > 0)) return zero('PER_TRADE_UNSET');
  if (remainingCapitalKRW <= 0) return zero('CAPITAL_EXHAUSTED');
  const budgetQty = Math.floor(p.perTradeKRW / p.price);           // 종목당 10만 상한
  const capacityQty = Math.floor(remainingCapitalKRW / p.price);   // 총자본 100만 여력
  const cashQty = Math.floor(Math.max(0, p.orderableCash) / p.price); // 실 현금 주문가능(신용/미수 배제)
  const finalQty = Math.min(budgetQty, capacityQty, cashQty);
  const full = { ...base, budgetQty, capacityQty, cashQty };
  if (budgetQty < 1) return { ...full, finalQty: 0, candidateKRW: 0, canNewBuy: false, reason: 'PER_TRADE_TOO_SMALL(1주 초과 단가)' };
  if (cashQty < 1) return { ...full, finalQty: 0, candidateKRW: 0, canNewBuy: false, reason: 'CASH_INSUFFICIENT(주문가능현금 부족)' };
  if (capacityQty < 1) return { ...full, finalQty: 0, candidateKRW: 0, canNewBuy: false, reason: 'CAPITAL_INSUFFICIENT_FOR_1SHARE' };
  const candidateKRW = finalQty * p.price;
  return { ...full, finalQty, candidateKRW, canNewBuy: finalQty >= 1, reason: finalQty < budgetQty ? 'REDUCED_TO_FIT(자본/현금 한도)' : 'OK' };
}

// ── item7: KR 청산정책 — 전략적 손절/익절값은 사용자 결정 필요(임의 확정 금지). 비상 손실제한은 최소 안전장치. ──
//   원자료엔 명시적 SELL 공식 없음(NO_SOURCE_BASED_SELL). BB SELL 임의 부착 금지.
//   confirmed=false 이면(사용자 미확정) 실 SELL 을 READY 로 보고하지 않는다. emergencyStop 은 항상 활성(하드 플로어).
export interface KRExitPolicy {
  stopLossPct: number | null;      // 전략 손절(사용자 결정 필요) — 미설정이면 null(관찰만)
  takeProfitPct: number | null;    // 전략 익절(사용자 결정 필요) — 미설정이면 null
  maxHoldDays: number | null;      // 보유일 한도(사용자 결정 필요)
  emergencyStopPct: number;        // 비상 손실제한(항상 활성, 기본 -15%)
  confirmed: boolean;              // YEOKMAE_KR_EXIT_CONFIRMED === 'true' (사용자가 전략값 확정)
  pendingDecisions: string[];      // 확정 안 된 값 목록(보고용)
}
const numEnv = (v: string | undefined): number | null => { if (v == null || v.trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
export function resolveKRExitPolicy(env: NodeJS.ProcessEnv): KRExitPolicy {
  const stopLossPct = numEnv(env.YEOKMAE_KR_STOP_LOSS_PCT);
  const takeProfitPct = numEnv(env.YEOKMAE_KR_TAKE_PROFIT_PCT);
  const maxHoldDays = numEnv(env.YEOKMAE_KR_MAX_HOLD_DAYS);
  const emergencyStopPct = numEnv(env.YEOKMAE_KR_EMERGENCY_STOP_PCT) ?? 15;   // 항상 활성(기본 -15%)
  const confirmed = env.YEOKMAE_KR_EXIT_CONFIRMED === 'true';
  const pendingDecisions: string[] = [];
  if (stopLossPct == null) pendingDecisions.push('YEOKMAE_KR_STOP_LOSS_PCT(전략 손절% 미결정)');
  if (takeProfitPct == null) pendingDecisions.push('YEOKMAE_KR_TAKE_PROFIT_PCT(전략 익절% 미결정)');
  if (maxHoldDays == null) pendingDecisions.push('YEOKMAE_KR_MAX_HOLD_DAYS(보유일 한도 미결정)');
  if (!confirmed) pendingDecisions.push('YEOKMAE_KR_EXIT_CONFIRMED!=true(사용자 최종확인 필요)');
  return { stopLossPct, takeProfitPct, maxHoldDays, emergencyStopPct, confirmed, pendingDecisions };
}

// ── item4: 실전 운영 risk/exit 판정(순수) — ⚠️ 역매공파 원본 SELL 아님(NO_SOURCE_BASED_SELL). 실전 운영용 위험청산 정책. ──
//   우선순위: EMERGENCY_STOP(-emergencyStopPct, 최우선) > STOP_LOSS(-stopLossPct) > TAKE_PROFIT(+takeProfitPct) > MAX_HOLD_DAYS.
//   손익률은 실 체결평단(원장 entryAvgPrice, 실제 fill) 기준. entryAvg/현재가 불명확이면 HOLD(임의 생성 금지).
export type KRExitReason = 'EMERGENCY_STOP' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'MAX_HOLD_DAYS';
export interface KRExitDecision { action: 'HOLD' | 'SELL'; reason: KRExitReason | null; pnlPct: number | null; note: string }
export function evaluateKRExit(p: {
  entryAvgPrice: number; currentPrice: number; holdDays: number; policy: KRExitPolicy;
}): KRExitDecision {
  if (!(p.entryAvgPrice > 0)) return { action: 'HOLD', reason: null, pnlPct: null, note: 'NO_ENTRY_AVG(실 체결평단 불명확 → 판정 보류, 임의 생성 금지)' };
  if (!(p.currentPrice > 0)) return { action: 'HOLD', reason: null, pnlPct: null, note: 'NO_PRICE(현재가 미확보 → 판정 보류)' };
  const pnlPct = (p.currentPrice - p.entryAvgPrice) / p.entryAvgPrice * 100;
  const pol = p.policy;
  // EMERGENCY 최우선(일반 exit 경로와 별개, 항상 활성)
  if (pnlPct <= -pol.emergencyStopPct) return { action: 'SELL', reason: 'EMERGENCY_STOP', pnlPct, note: `pnl=${pnlPct.toFixed(2)}% <= -${pol.emergencyStopPct}%(비상 최우선)` };
  if (pol.stopLossPct != null && pnlPct <= -pol.stopLossPct) return { action: 'SELL', reason: 'STOP_LOSS', pnlPct, note: `pnl=${pnlPct.toFixed(2)}% <= -${pol.stopLossPct}%` };
  if (pol.takeProfitPct != null && pnlPct >= pol.takeProfitPct) return { action: 'SELL', reason: 'TAKE_PROFIT', pnlPct, note: `pnl=${pnlPct.toFixed(2)}% >= +${pol.takeProfitPct}%` };
  if (pol.maxHoldDays != null && p.holdDays >= pol.maxHoldDays) return { action: 'SELL', reason: 'MAX_HOLD_DAYS', pnlPct, note: `holdDays=${p.holdDays} >= ${pol.maxHoldDays}` };
  return { action: 'HOLD', reason: null, pnlPct, note: `pnl=${pnlPct.toFixed(2)}% HOLD` };
}

// ── item2: 시작 시 실계좌(t0424) ↔ 프로그램 원장 reconcile(순수). 원장 qty 를 broker 잔고로 검증. ──
//   broker balQty=0 인데 원장 보유 → 외부청산 의심(원장 stale). broker < 원장 → 원장 과다(수량 하향 필요).
//   ⚠️ 여기서는 판정만(부수효과 없음). 실제 sync 는 러너가 결정(자동삭제 금지, 로그 후 보수적 처리).
export interface KRLedgerReconcileEntry { symbol: string; ledgerQty: number; brokerQty: number; brokerSellable: number; status: 'MATCH' | 'BROKER_LESS' | 'BROKER_ZERO' | 'BROKER_MORE'; }
export function reconcileKRLedgerVsHoldings(
  ledger: readonly { symbol: string; qty: number }[],
  holdings: readonly { symbol: string; balQty: number; sellableQty: number }[],
): KRLedgerReconcileEntry[] {
  const hBySym = new Map(holdings.map(h => [h.symbol, h]));
  return ledger.filter(l => l.qty > 0).map(l => {
    const h = hBySym.get(l.symbol);
    const brokerQty = h?.balQty ?? 0; const brokerSellable = h?.sellableQty ?? 0;
    const status: KRLedgerReconcileEntry['status'] = brokerQty === 0 ? 'BROKER_ZERO'
      : brokerQty < l.qty ? 'BROKER_LESS' : brokerQty > l.qty ? 'BROKER_MORE' : 'MATCH';
    return { symbol: l.symbol, ledgerQty: l.qty, brokerQty, brokerSellable, status };
  });
}
