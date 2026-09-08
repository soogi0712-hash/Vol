// 역매공파 실보유 managed-position 복원 코어 (P0-37) — 순수·테스트용. broker 보유 + 과거 Vol BUY 증거 대조.
//   ⚠️ broker 보유만으로 managed 생성 금지. 반드시 order-store BUY 증거 + (수량 일치) 필요. 애매하면 fail-closed(수동 유지).
//   ⚠️ 평단 추측 금지 — 우선순위: env override > broker 공식(KR t0424) > order-store 주문가. 셋 다 없으면 fail-closed.
import type { OrderBuyEvidence } from '../order-store';
import type { TrackedOrder } from '../order-events';

export type RecoverAction = 'RECOVER' | 'MANUAL' | 'FAILCLOSED';
export type RecoverAvgSource = 'ACTUAL_FILL' | 'ENV_OVERRIDE' | 'BROKER_OFFICIAL' | 'ORDER_PRICE' | '-';
export interface RecoverDecision {
  action: RecoverAction; qty: number; entryAvgPrice: number; avgSource: RecoverAvgSource;
  exchcd: string; entryDate: string | null; reason: string;
}
// P0-37A: 계좌이벤트(AS0 ACCEPTED + AS1 FILLED) 실체결 증거 — 실제 체결평단/체결수량(최우선 진실).
export interface AccountFill { symbol: string; execQty: number; avgExecPrc: number; ordQty: number; ordNo: string; }
export interface RecoverInput {
  symbol: string; market: 'KR' | 'US';
  brokerQty: number;                 // t0424(KR)/COSOQ00201(US) 실보유수량
  brokerAvgPrice: number | null;     // KR t0424 pamt(공식). US 는 미제공(null).
  evidence: OrderBuyEvidence;        // order-store 증거(여러 키 병합 결과)
  accountFill?: AccountFill | null;  // __account_events__ AS0/AS1 실체결(있으면 최우선)
  exchcd: string;                    // KR='KR', US='81'/'82'. '' 이면 미해결.
  entryAvgOverride: number | null;   // env YEOKMAE_<MKT>_ENTRY_AVG_<SYM>
}

// ordNo 정규화 — AS0 zero-padded('0000000378') 과 AS1('378') 매칭용. 선행 0 제거.
export function normOrdNo(s: string): string {
  const t = String(s ?? '').trim();
  if (t === '') return '';
  const stripped = t.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

// __account_events__ tracked(AS0/AS1 상태머신 결과) → 종목별 실체결(체결수량/체결평단).
//   ⚠️ AS0(symbol 보유, exec 0) + AS1(symbol 빈칸, exec 보유)이 ordNo padding 으로 분리 저장될 수 있음 → normOrdNo 로 병합.
//   AS1 symbol 이 비면 같은 ordNo 그룹의 AS0 symbol 로 연결. 여러 주문이면 종목별 합산 + 체결가중 평단.
export function extractAccountFills(tracked: readonly TrackedOrder[]): Map<string, AccountFill> {
  const byOrd = new Map<string, { symbol: string; execQty: number; avgExecPrc: number; ordQty: number; ordNo: string }>();
  for (const t of tracked) {
    const key = normOrdNo(t.ordNo || t.orgOrdNo);
    if (!key) continue;
    const cur = byOrd.get(key) ?? { symbol: '', execQty: 0, avgExecPrc: 0, ordQty: 0, ordNo: key };
    if (t.symbol) cur.symbol = t.symbol;                                // AS0 symbol
    if (t.ordQty > 0) cur.ordQty = Math.max(cur.ordQty, t.ordQty);      // AS0 주문수량
    if (t.cumExecQty > 0) cur.execQty = Math.max(cur.execQty, t.cumExecQty);   // AS1 누적체결
    if (t.avgExecPrc > 0) cur.avgExecPrc = t.avgExecPrc;               // AS1 체결평단
    byOrd.set(key, cur);
  }
  const bySym = new Map<string, { symbol: string; execQty: number; wsum: number; ordQty: number; ordNo: string }>();
  for (const o of byOrd.values()) {
    if (!o.symbol || !(o.execQty > 0) || !(o.avgExecPrc > 0)) continue;   // 실체결(수량>0·평단>0)만
    const a = bySym.get(o.symbol) ?? { symbol: o.symbol, execQty: 0, wsum: 0, ordQty: 0, ordNo: o.ordNo };
    a.execQty += o.execQty; a.wsum += o.execQty * o.avgExecPrc; a.ordQty += o.ordQty; bySym.set(o.symbol, a);
  }
  const out = new Map<string, AccountFill>();
  for (const a of bySym.values()) out.set(a.symbol, { symbol: a.symbol, execQty: a.execQty, avgExecPrc: a.wsum / a.execQty, ordQty: a.ordQty, ordNo: a.ordNo });
  return out;
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
  const base = { qty: 0, entryAvgPrice: 0, avgSource: '-' as RecoverAvgSource, exchcd: p.exchcd, entryDate: null as string | null };
  const fill = p.accountFill && p.accountFill.execQty > 0 && p.accountFill.avgExecPrc > 0 ? p.accountFill : null;
  if (!(p.brokerQty > 0)) return { ...base, action: 'MANUAL', reason: 'NO_BROKER_QTY' };
  // 증거: order-store 증거 또는 계좌이벤트 실체결(AS0/AS1) 중 하나 이상. 둘 다 없으면 수동보유 유지.
  if (!p.evidence.hasAnyBuyEvidence && !fill) return { ...base, action: 'MANUAL', reason: 'NO_VOL_BUY_EVIDENCE(broker-only) → 수동보유 유지' };
  // 수량 검증 — 실체결수량(cumExecQty) 우선, 없으면 주문수량(pending). broker 와 반드시 일치.
  const confirmedQty = fill ? fill.execQty : p.evidence.confirmedBuyQty;
  if (confirmedQty != null && confirmedQty !== p.brokerQty) {
    return { ...base, action: 'FAILCLOSED', reason: `QTY_MISMATCH(${fill ? 'exec' : 'order'}=${confirmedQty} broker=${p.brokerQty}) → 복원 보류(fail-closed)` };
  }
  // US 는 주문 라우팅/시세용 exchcd 필수.
  if (p.market === 'US' && !p.exchcd) {
    return { ...base, action: 'FAILCLOSED', reason: `EXCHCD_UNRESOLVED → env YEOKMAE_US_EXCHCD_${sym} 설정 또는 build-us-history 로 마스터 exchcd 확보 필요(추측 금지)` };
  }
  // 평단 우선순위(추측 금지): 실체결평단(AS1 avgExecPrc) > env override > broker 공식(KR t0424) > order-store 주문가.
  let v = 0; let src: RecoverAvgSource = '-';
  if (fill) { v = fill.avgExecPrc; src = 'ACTUAL_FILL'; }
  else if (p.entryAvgOverride != null && p.entryAvgOverride > 0) { v = p.entryAvgOverride; src = 'ENV_OVERRIDE'; }
  else if (p.brokerAvgPrice != null && p.brokerAvgPrice > 0) { v = p.brokerAvgPrice; src = 'BROKER_OFFICIAL'; }
  else if (p.evidence.orderPrice != null && p.evidence.orderPrice > 0) { v = p.evidence.orderPrice; src = 'ORDER_PRICE'; }
  if (!(v > 0)) {
    return { ...base, action: 'FAILCLOSED', reason: `ENTRY_AVG_UNKNOWN(추측 금지) → env YEOKMAE_${p.market}_ENTRY_AVG_${sym} 로 broker 공식 평단 주입 필요` };
  }
  return {
    action: 'RECOVER', qty: p.brokerQty, entryAvgPrice: v, avgSource: src, exchcd: p.exchcd,
    entryDate: earliestEntryDate(p.evidence.candleDates),
    reason: `MATCH(qty=${p.brokerQty} entryAvg=${v} src=${src}${confirmedQty == null ? ' · 수량근거 미기록→broker수량 사용' : ''})`,
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
