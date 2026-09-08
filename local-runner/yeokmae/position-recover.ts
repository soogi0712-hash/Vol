// 역매공파 실보유 managed-position 복원 코어 (P0-37) — 순수·테스트용. broker 보유 + 과거 Vol BUY 증거 대조.
//   ⚠️ broker 보유만으로 managed 생성 금지. 반드시 order-store BUY 증거 + (수량 일치) 필요. 애매하면 fail-closed(수동 유지).
//   ⚠️ 평단 추측 금지 — 우선순위: env override > broker 공식(KR t0424) > order-store 주문가. 셋 다 없으면 fail-closed.
import type { OrderBuyEvidence } from '../order-store';

export type RecoverAction = 'RECOVER' | 'MANUAL' | 'FAILCLOSED';
export interface RecoverDecision {
  action: RecoverAction; qty: number; entryAvgPrice: number; avgSource: 'ENV_OVERRIDE' | 'BROKER_OFFICIAL' | 'ORDER_PRICE' | '-';
  exchcd: string; entryDate: string | null; reason: string;
}
export interface RecoverInput {
  symbol: string; market: 'KR' | 'US';
  brokerQty: number;                 // t0424(KR)/COSOQ00201(US) 실보유수량
  brokerAvgPrice: number | null;     // KR t0424 pamt(공식). US 는 미제공(null).
  evidence: OrderBuyEvidence;        // order-store 증거(여러 키 병합 결과)
  exchcd: string;                    // KR='KR', US='81'/'82'. '' 이면 미해결.
  entryAvgOverride: number | null;   // env YEOKMAE_<MKT>_ENTRY_AVG_<SYM>
}

// 여러 order-store(예: US 레거시 '<sym>' + 신규 'YEOKMAE_US_<sym>')의 증거 병합.
export function mergeBuyEvidence(list: readonly OrderBuyEvidence[], symbol: string): OrderBuyEvidence {
  const orderedBuyCandles: string[] = []; const buyPendings: any[] = []; const acceptedBuyResponses: any[] = []; const candleDates: string[] = [];
  let confirmedBuyQty: number | null = null; let orderPrice: number | null = null;
  for (const e of list) {
    orderedBuyCandles.push(...e.orderedBuyCandles); buyPendings.push(...e.buyPendings); acceptedBuyResponses.push(...e.acceptedBuyResponses); candleDates.push(...e.candleDates);
    if (e.confirmedBuyQty != null) confirmedBuyQty = (confirmedBuyQty ?? 0) + e.confirmedBuyQty;
    if (orderPrice == null && e.orderPrice != null) orderPrice = e.orderPrice;
  }
  return {
    symbol, orderedBuyCandles, buyPendings, acceptedBuyResponses,
    hasAnyBuyEvidence: orderedBuyCandles.length > 0 || buyPendings.length > 0 || acceptedBuyResponses.length > 0,
    confirmedBuyQty, orderPrice, candleDates,
  };
}

// candle 날짜(YYYY-MM-DD 또는 YYYYMMDD) → 진입일 YYYY-MM-DD(기록용). 가장 이른 날짜.
export function earliestEntryDate(candleDates: readonly string[]): string | null {
  const norm = candleDates.map(d => d.length === 8 && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (!norm.length) return null;
  return norm.sort()[0];
}

export function evaluateManagedRecovery(p: RecoverInput): RecoverDecision {
  const sym = p.symbol;
  const base = { qty: 0, entryAvgPrice: 0, avgSource: '-' as const, exchcd: p.exchcd, entryDate: null as string | null };
  if (!(p.brokerQty > 0)) return { ...base, action: 'MANUAL', reason: 'NO_BROKER_QTY' };
  if (!p.evidence.hasAnyBuyEvidence) return { ...base, action: 'MANUAL', reason: 'NO_VOL_BUY_EVIDENCE(broker-only) → 수동보유 유지' };
  // 수량 검증 — 주문수량(pending)이 기록돼 있으면 broker 와 반드시 일치.
  if (p.evidence.confirmedBuyQty != null && p.evidence.confirmedBuyQty !== p.brokerQty) {
    return { ...base, action: 'FAILCLOSED', reason: `QTY_MISMATCH(order=${p.evidence.confirmedBuyQty} broker=${p.brokerQty}) → 복원 보류(fail-closed)` };
  }
  // US 는 주문 라우팅/시세용 exchcd 필수.
  if (p.market === 'US' && !p.exchcd) {
    return { ...base, action: 'FAILCLOSED', reason: `EXCHCD_UNRESOLVED → env YEOKMAE_US_EXCHCD_${sym} 설정 필요(추측 금지)` };
  }
  // 평단 우선순위(추측 금지): env override > broker 공식 > order-store 주문가.
  let v = 0; let src: RecoverDecision['avgSource'] = '-';
  if (p.entryAvgOverride != null && p.entryAvgOverride > 0) { v = p.entryAvgOverride; src = 'ENV_OVERRIDE'; }
  else if (p.brokerAvgPrice != null && p.brokerAvgPrice > 0) { v = p.brokerAvgPrice; src = 'BROKER_OFFICIAL'; }
  else if (p.evidence.orderPrice != null && p.evidence.orderPrice > 0) { v = p.evidence.orderPrice; src = 'ORDER_PRICE'; }
  if (!(v > 0)) {
    return { ...base, action: 'FAILCLOSED', reason: `ENTRY_AVG_UNKNOWN(추측 금지) → env YEOKMAE_${p.market}_ENTRY_AVG_${sym} 로 broker 공식 평단 주입 필요` };
  }
  return {
    action: 'RECOVER', qty: p.brokerQty, entryAvgPrice: v, avgSource: src, exchcd: p.exchcd,
    entryDate: earliestEntryDate(p.evidence.candleDates),
    reason: `MATCH(qty=${p.brokerQty} entryAvg=${v} src=${src}${p.evidence.confirmedBuyQty == null ? ' · 주문수량 미기록→broker수량 사용' : ''})`,
  };
}

// env override 읽기 — 사용자가 HTS 에서 확인한 broker 공식 평단/exchcd 주입(코드 추측 아님).
export function readEntryAvgOverride(env: NodeJS.ProcessEnv, market: 'KR' | 'US', symbol: string): number | null {
  const raw = env[`YEOKMAE_${market}_ENTRY_AVG_${symbol}`];
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw); return Number.isFinite(n) && n > 0 ? n : null;
}
export function readExchcdOverride(env: NodeJS.ProcessEnv, symbol: string): string {
  return (env[`YEOKMAE_US_EXCHCD_${symbol}`] ?? '').trim();
}
