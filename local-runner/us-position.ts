// 미국 실전 SELL/청산 엔진 (P0-30B) — 보유 포지션 추적 + 실현손익 원장 + SELL 게이트/수량 결정.
//  · BUY 와 완전히 분리된 SELL 경로. 전략은 기존 BB(getBBSignal)만 사용(임의 전략 추가 없음).
//  · SELL 은 일일 횟수로 막지 않는다. 중복은 보유수량/pending SELL/동일 candle lock/체결상태로만 방지.
//  · 실현손익은 gross(수수료·세금 미반영) — LS 응답에 수수료/세금 필드가 없어 net 은 산출 불가(추측 금지).
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const DEFAULT_DIR = resolve(process.cwd(), 'local-runner', 'data');
const VERSION = 1;

// ── 보유 포지션 ──────────────────────────────────────────────
export interface USPosition {
  symbol: string; exchcd: string;
  qty: number;              // 실제 보유수량(실계좌 holdings 가 진실원본)
  sellableQty: number;      // 매도가능수량(holdings)
  avgPrice: number | null;  // 평균매입가 — 우리 BUY 체결에서 축적. 실계좌 조회엔 없음(미상=null)
  aboveUpper: boolean;      // BB 상단선 돌파 이력(매도 트리거 판정용, getBBSignal aboveUpper). 재시작 복원.
}

// ── 순수 로직 (결정적 테스트 가능) ──────────────────────────

// 실계좌 보유(holdings) + 로컬 알려진값(avgPrice/aboveUpper) 병합.
//   · holdings 가 수량/매도가능의 진실원본. 프로그램이 산 종목만 보유로 인식하지 않는다(실계좌 전량 복원).
//   · avgPrice 는 우리 BUY 체결기록에서만 알 수 있음 → 기존 포지션이면 유지, 실계좌에만 있으면 null(미상).
export function mergePositions(
  holdings: { symbol: string; balQty: number; sellableQty: number }[],
  known: Map<string, { exchcd: string; avgPrice: number | null; aboveUpper: boolean }>,
  exchcdOf: (symbol: string) => string,
): USPosition[] {
  return holdings
    .filter(h => h.balQty > 0)
    .map(h => {
      const k = known.get(h.symbol);
      return {
        symbol: h.symbol,
        exchcd: k?.exchcd || exchcdOf(h.symbol) || '',
        qty: h.balQty,
        sellableQty: Math.max(0, Math.min(h.sellableQty, h.balQty)),
        avgPrice: k?.avgPrice ?? null,   // 실계좌에 avg 없음 → 우리 기록 없으면 미상
        aboveUpper: k?.aboveUpper ?? false,
      };
    });
}

// ── P0-31: 미국장 총 운용자금(원화) 한도 + 다종목 분산매수 ──
// committed = 프로그램 관리 투자원금(실보유×평단) + pending BUY. 신규 주문이 한도 초과 시 수량 축소/차단.
//   · 프로그램 관리 = avgPrice!=null(우리 BUY 체결기록). 수동보유(avgPrice=null)는 원금집계에서 제외.
//   · 환율은 LS 기준환율(baseXchRate) — 임의 고정 금지. rate<=0 이면 계산 불가(차단).

// 프로그램 관리 투자원금(USD) = Σ(avgPrice!=null) qty×avgPrice. 실보유 기준 → 수동청산 자동 반영.
export function programInvestedUSD(positions: { qty: number; avgPrice: number | null }[]): number {
  let s = 0;
  for (const p of positions) if (p.avgPrice != null && p.avgPrice > 0 && p.qty > 0) s += p.qty * p.avgPrice;
  return s;
}
// pending BUY 총액(USD) — 모든 us-orders-*.json 의 side='buy' pending 합. 재시작/로테이션 무관 복원.
export function scanPendingBuyUSD(dataDir = DEFAULT_DIR): { totalUSD: number; count: number } {
  if (!existsSync(dataDir)) return { totalUSD: 0, count: 0 };
  let totalUSD = 0; let count = 0;
  for (const f of readdirSync(dataDir)) {
    const m = /^us-orders-(.+)\.json$/.exec(f);
    if (!m || m[1].startsWith('__')) continue;   // 계정 이벤트/레저(__account_events__ 등) 제외
    try {
      const body = JSON.parse(readFileSync(join(dataDir, f), 'utf8'));
      for (const po of (body.pending ?? [])) if (po && po.side === 'buy') { totalUSD += (Number(po.qty) || 0) * (Number(po.price) || 0); count++; }
    } catch { /* 손상 파일 skip */ }
  }
  return { totalUSD, count };
}

// 총 운용자금 게이트 — 신규 BUY 허용/수량축소. committed+신규 <= limit 이어야 허용.
//   limitKRW=null(미설정) → 한도 미적용(pass-through). rate<=0 → 계산불가(차단). remaining<1주 → 차단.
export interface USCapitalGuard {
  limitKRW: number; investedKRW: number; pendingKRW: number; remainingKRW: number;
  candidateKRW: number; finalQty: number; canNewBuy: boolean; reason: string;
}
export function computeUSCapitalGuard(p: {
  limitKRW: number | null; investedUSD: number; pendingUSD: number;
  candidateQty: number; bestAsk: number; baseXchRate: number;
}): USCapitalGuard {
  const rate = p.baseXchRate > 0 ? p.baseXchRate : 0;
  const investedKRW = Math.max(0, p.investedUSD) * rate;
  const pendingKRW = Math.max(0, p.pendingUSD) * rate;
  const candQty = Math.max(0, Math.floor(p.candidateQty));
  // 한도 미설정 → guard off(기존 동작). 수량 그대로, 1주 이상이면 허용.
  if (p.limitKRW == null || !(p.limitKRW > 0)) {
    return { limitKRW: 0, investedKRW, pendingKRW, remainingKRW: 0, candidateKRW: rate > 0 ? candQty * p.bestAsk * rate : 0, finalQty: candQty, canNewBuy: candQty >= 1, reason: 'CAPITAL_LIMIT_UNSET(off)' };
  }
  if (!(rate > 0)) return { limitKRW: p.limitKRW, investedKRW, pendingKRW, remainingKRW: 0, candidateKRW: 0, finalQty: 0, canNewBuy: false, reason: 'NO_XCHRATE' };
  const remainingKRW = p.limitKRW - investedKRW - pendingKRW;
  if (!(p.bestAsk > 0)) return { limitKRW: p.limitKRW, investedKRW, pendingKRW, remainingKRW, candidateKRW: 0, finalQty: 0, canNewBuy: false, reason: 'PRICE_UNAVAILABLE' };
  if (remainingKRW <= 0) return { limitKRW: p.limitKRW, investedKRW, pendingKRW, remainingKRW, candidateKRW: 0, finalQty: 0, canNewBuy: false, reason: 'CAPITAL_EXHAUSTED' };
  const maxQty = Math.max(0, Math.floor((remainingKRW / rate) / p.bestAsk));   // 남은자금으로 살 수 있는 최대 주수
  const finalQty = Math.min(candQty, maxQty);
  if (finalQty < 1) return { limitKRW: p.limitKRW, investedKRW, pendingKRW, remainingKRW, candidateKRW: 0, finalQty: 0, canNewBuy: false, reason: 'CAPITAL_INSUFFICIENT_FOR_1SHARE' };
  const candidateKRW = finalQty * p.bestAsk * rate;
  return { limitKRW: p.limitKRW, investedKRW, pendingKRW, remainingKRW, candidateKRW, finalQty, canNewBuy: true, reason: finalQty < candQty ? 'REDUCED_TO_FIT_CAPITAL' : 'OK' };
}
export function formatUSCapitalGuard(g: USCapitalGuard): string {
  return `[US-CAPITAL-GUARD] limitKRW=${Math.round(g.limitKRW)} investedKRW=${Math.round(g.investedKRW)} pendingKRW=${Math.round(g.pendingKRW)}`
    + ` remainingKRW=${Math.round(g.remainingKRW)} candidateKRW=${Math.round(g.candidateKRW)} finalQty=${g.finalQty} canNewBuy=${g.canNewBuy} reason=${g.reason}`;
}

// P0-30D: 실 SELL POST 최종 허용 여부 — 셋 다여야 실매도(코드상수 매도TR확인 AND env kill-switch AND 라이브).
//   SELL 은 일일 횟수제한과 무관(청산/손절 항상 가능). 이 게이트는 '실주문 전송 자체'의 on/off 만 결정한다.
export function sellRealOrderEnabled(p: { confirmed: boolean; sellLiveEnv: boolean; liveTrading: boolean }): boolean {
  return !!(p.confirmed && p.sellLiveEnv && p.liveTrading);
}

// SELL 게이트 — 신규 매도 POST 허용/차단 + 매도수량 결정. (일일 횟수제한 없음: 청산/손절 항상 가능)
//   전량청산 전략 → sellQty = min(보유수량, 매도가능수량). 중복은 pending/candle/보유로만 차단.
export interface USSellGate {
  holdingQty: number; sellableQty: number; pendingSell: boolean;
  sellQty: number; postAllowed: boolean; reason: string;
}
export function computeUSSellGate(p: {
  signalSell: boolean; holdingQty: number; sellableQty: number;
  pendingSell: boolean; hasOrderedSellCandle: boolean;
}): USSellGate {
  const base = { holdingQty: p.holdingQty, sellableQty: Math.max(0, p.sellableQty), pendingSell: p.pendingSell, sellQty: 0 };
  if (!p.signalSell) return { ...base, postAllowed: false, reason: 'NO_SELL_SIGNAL' };
  if (p.pendingSell) return { ...base, postAllowed: false, reason: 'PENDING_SELL_EXISTS' };   // 동일종목 중복 SELL 금지
  if (p.hasOrderedSellCandle) return { ...base, postAllowed: false, reason: 'DUPLICATE_CANDLE' };   // 동일 candle 재POST 금지
  if (!(p.holdingQty > 0)) return { ...base, postAllowed: false, reason: 'NO_HOLDING' };
  const sellQty = Math.max(0, Math.min(Math.floor(p.holdingQty), Math.floor(p.sellableQty)));
  if (sellQty < 1) return { ...base, postAllowed: false, reason: 'NO_SELLABLE_QTY' };   // 보유는 있으나 매도가능 0(결제전 등)
  return { ...base, sellQty, postAllowed: true, reason: 'OK' };
}

// 실현손익(gross) — 실제 체결가 - 평균매입가 × 수량. avgPrice 미상이면 산출 불가(null).
//   ⚠️ 수수료/세금은 LS 응답에 없어 미반영(gross). net 은 추측하지 않는다.
export function computeRealizedPnL(p: { sellQty: number; sellPrice: number; avgBuyPrice: number | null }): { gross: number | null; pnlPct: number | null } {
  if (p.avgBuyPrice == null || !(p.avgBuyPrice > 0) || !(p.sellQty > 0) || !(p.sellPrice >= 0)) return { gross: null, pnlPct: null };
  return { gross: (p.sellPrice - p.avgBuyPrice) * p.sellQty, pnlPct: (p.sellPrice - p.avgBuyPrice) / p.avgBuyPrice * 100 };
}

// 현재가 대비 평가손익률(%). avgPrice 미상/가격<=0 이면 null.
export function positionPnlPct(avgPrice: number | null, currentPrice: number): number | null {
  if (avgPrice == null || !(avgPrice > 0) || !(currentPrice > 0)) return null;
  return (currentPrice - avgPrice) / avgPrice * 100;
}

// ── 로그 포맷 ──────────────────────────────────────────────
export function formatUSPosition(p: { symbol: string; qty: number; avgPrice: number | null; currentPrice: number; pnlPct: number | null }): string {
  return `[US-POSITION ${p.symbol}] qty=${p.qty} avgPrice=${p.avgPrice == null ? '미상' : p.avgPrice.toFixed(2)}`
    + ` currentPrice=${p.currentPrice > 0 ? p.currentPrice.toFixed(2) : '-'} pnlPct=${p.pnlPct == null ? 'n/a' : p.pnlPct.toFixed(2) + '%'}`;
}
export function formatUSSellSignal(p: { symbol: string; signal: string; reason: string; qty: number }): string {
  return `[US-SELL-SIGNAL ${p.symbol}] signal=${p.signal} reason=${p.reason} qty=${p.qty}`;
}
export function formatUSSellGate(symbol: string, g: USSellGate): string {
  return `[US-SELL-GATE ${symbol}] holdingQty=${g.holdingQty} pendingSell=${g.pendingSell} sellQty=${g.sellQty}`
    + ` POST_ALLOWED=${g.postAllowed}${g.postAllowed ? '' : ` (${g.reason})`}`;
}
export function formatUSSellOrder(p: { symbol: string; qty: number; ordNo: string | null; status: string }): string {
  return `[US-SELL-ORDER ${p.symbol}] qty=${p.qty} ordNo=${p.ordNo ?? '-'} status=${p.status}`;
}
export function formatUSSellFill(p: { symbol: string; qty: number; price: number; realizedPnL: number | null }): string {
  return `[US-SELL-FILL ${p.symbol}] qty=${p.qty} price=${p.price.toFixed(2)} realizedPnL=${p.realizedPnL == null ? 'n/a(avg미상)' : p.realizedPnL.toFixed(2) + '(gross)'}`;
}

// ── 영구 저장: 포지션(avgPrice/aboveUpper) + 당일 실현손익 원장 ──────────
interface PositionBody {
  version: number;
  positions: Record<string, { exchcd: string; qty: number; avgPrice: number | null; aboveUpper: boolean }>;
  realized: Record<string, { gross: number; sellCount: number }>;   // etDate → 당일 실현손익(gross)/매도횟수
}
export class PositionStore {
  readonly file: string;
  private tmp: string;
  private body: PositionBody;
  corrupt = false;

  constructor(dir = DEFAULT_DIR) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'us-positions.json');
    this.tmp = this.file + '.tmp';
    this.body = { version: VERSION, positions: {}, realized: {} };
  }
  load(): void {
    if (!existsSync(this.file)) return;
    let raw: string;
    try { raw = readFileSync(this.file, 'utf8'); } catch { this.corrupt = true; return; }
    try {
      const d = JSON.parse(raw) as Partial<PositionBody>;
      this.body = { version: VERSION, positions: d.positions ?? {}, realized: d.realized ?? {} };
    } catch { this.corrupt = true; try { renameSync(this.file, this.file + '.corrupt'); } catch { /* noop */ } }
  }
  // 알려진 포지션(avgPrice/aboveUpper) 조회 — mergePositions 입력용.
  knownMap(): Map<string, { exchcd: string; avgPrice: number | null; aboveUpper: boolean }> {
    const m = new Map<string, { exchcd: string; avgPrice: number | null; aboveUpper: boolean }>();
    for (const [sym, p] of Object.entries(this.body.positions)) m.set(sym, { exchcd: p.exchcd, avgPrice: p.avgPrice, aboveUpper: p.aboveUpper });
    return m;
  }
  // BUY 체결 반영 — 가중평균 매입가 갱신(재시작 후 실현손익 계산 근거). flush 필요.
  applyBuyFill(symbol: string, exchcd: string, fillQty: number, fillPrice: number): void {
    if (!(fillQty > 0)) return;
    const cur = this.body.positions[symbol] ?? { exchcd, qty: 0, avgPrice: null, aboveUpper: false };
    const prevQty = cur.qty; const prevAvg = cur.avgPrice ?? 0;
    const newQty = prevQty + fillQty;
    const newAvg = newQty > 0 ? (prevQty * prevAvg + fillQty * fillPrice) / newQty : fillPrice;
    this.body.positions[symbol] = { exchcd: exchcd || cur.exchcd, qty: newQty, avgPrice: newAvg, aboveUpper: cur.aboveUpper };
  }
  // aboveUpper 플래그 저장(BB 상단돌파 이력) — 매도 트리거 판정. flush 필요.
  setAboveUpper(symbol: string, exchcd: string, aboveUpper: boolean): void {
    const cur = this.body.positions[symbol] ?? { exchcd, qty: 0, avgPrice: null, aboveUpper: false };
    this.body.positions[symbol] = { ...cur, exchcd: exchcd || cur.exchcd, aboveUpper };
  }
  // 실계좌 holdings 로 수량 동기화(진실원본). 보유 0 이면 포지션 제거. flush 필요.
  syncQty(symbol: string, qty: number, sellableQty: number): void {
    const cur = this.body.positions[symbol];
    if (!(qty > 0)) { if (cur) delete this.body.positions[symbol]; return; }
    this.body.positions[symbol] = { exchcd: cur?.exchcd ?? '', qty, avgPrice: cur?.avgPrice ?? null, aboveUpper: cur?.aboveUpper ?? false };
  }
  getPosition(symbol: string): { exchcd: string; qty: number; avgPrice: number | null; aboveUpper: boolean } | null {
    return this.body.positions[symbol] ?? null;
  }
  // SELL 체결 반영 — 보유 차감 + 당일 실현손익(gross) 누적. flush 필요.
  applySellFill(symbol: string, fillQty: number, realizedGross: number | null, etDate: string): void {
    const cur = this.body.positions[symbol];
    if (cur) { cur.qty = Math.max(0, cur.qty - fillQty); if (cur.qty === 0) delete this.body.positions[symbol]; }
    const day = this.body.realized[etDate] ?? { gross: 0, sellCount: 0 };
    if (realizedGross != null) day.gross += realizedGross;
    day.sellCount += 1;
    this.body.realized[etDate] = day;
  }
  realizedToday(etDate: string): { gross: number; sellCount: number } { return this.body.realized[etDate] ?? { gross: 0, sellCount: 0 }; }
  flush(): void {
    if (this.corrupt) return;
    writeFileSync(this.tmp, JSON.stringify(this.body), 'utf8');
    renameSync(this.tmp, this.file);
  }
}
