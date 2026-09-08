// 해외주식 주문 이벤트 추적 (계좌 WebSocket AS0~AS4) — 순수 파서 + 상태머신(단위테스트 가능).
// ⚠️ AS0/AS1/AS2/AS3/AS4 는 주문·정정·취소를 "실행"하는 API 가 아니라, 이미 발생한 주문 상태를
//    실시간 통보받는 계좌 이벤트다. 특히 AS3 는 취소 "요청" 이 아니라 취소 "결과 확인" 이벤트다.
//    → AS3 수신만으로 취소 요청 기능이 구현됐다고 판단하지 않는다(REST 취소는 별도, 현재 미구현).
const num = (v: unknown): number => { const n = parseFloat(String(v ?? '').trim()); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string => String(v ?? '').trim();

// ── 이벤트 타입(공식 s 접두 필드) ──────────────────────────────
export interface AS0Accepted { kind: 'AS0'; ordNo: string; orgOrdNo: string; mktCode: string; ptnCode: string; symbol: string; ordQty: number; ordPrc: number; unfilledQty: number; trxPtnCode: string; rejectReason: string; }
export interface AS1Exec { kind: 'AS1'; ordNo: string; orgOrdNo: string; execNo: string; abrdExecId: string; execQty: number; execPrc: number; unfilledQty: number; avgExecPrc: number; execTime: string; rcptExecTime: string; rejectReason: string; }
export interface AS2Modify { kind: 'AS2'; ordNo: string; orgOrdNo: string; mdfyCnfQty: number; mdfyCnfPrc: number; orgOrdMdfyQty: number; unfilledQty: number; trxPtnCode: string; rejectReason: string; }
export interface AS3Cancel { kind: 'AS3'; ordNo: string; orgOrdNo: string; cancCnfQty: number; orgOrdCancQty: number; unfilledQty: number; orgOrdUnercQty: number; trxPtnCode: string; rejectReason: string; }
export interface AS4Reject { kind: 'AS4'; ordNo: string; orgOrdNo: string; rejectReason: string; }
export type OrderEvent = AS0Accepted | AS1Exec | AS2Modify | AS3Cancel | AS4Reject;

const symOf = (b: any) => str(b?.sShtnIsuNo) || str(b?.sIsuNo);

export function parseAccountEvent(trCd: string, b: any): OrderEvent | null {
  switch (trCd) {
    case 'AS0': return { kind: 'AS0', ordNo: str(b?.sOrdNo), orgOrdNo: str(b?.sOrgOrdNo), mktCode: str(b?.sOrdMktCode), ptnCode: str(b?.sOrdPtnCode), symbol: symOf(b), ordQty: num(b?.sOrdQty), ordPrc: num(b?.sOrdPrc), unfilledQty: num(b?.sUnercQty), trxPtnCode: str(b?.sOrdTrxPtnCode), rejectReason: str(b?.sRjtRsn) };
    case 'AS1': return { kind: 'AS1', ordNo: str(b?.sOrdNo), orgOrdNo: str(b?.sOrgOrdNo), execNo: str(b?.sExecNO), abrdExecId: str(b?.sAbrdExecId), execQty: num(b?.sExecQty), execPrc: num(b?.sExecPrc), unfilledQty: num(b?.sUnercQty), avgExecPrc: num(b?.sOrdAvrExecPrc), execTime: str(b?.sExecTime), rcptExecTime: str(b?.sRcptExecTime), rejectReason: str(b?.sRjtRsn) };
    case 'AS2': return { kind: 'AS2', ordNo: str(b?.sOrdNo), orgOrdNo: str(b?.sOrgOrdNo), mdfyCnfQty: num(b?.sMdfyCnfQty), mdfyCnfPrc: num(b?.sMdfyCnfPrc), orgOrdMdfyQty: num(b?.sOrgOrdMdfyQty), unfilledQty: num(b?.sUnercQty), trxPtnCode: str(b?.sOrdTrxPtnCode), rejectReason: str(b?.sRjtRsn) };
    case 'AS3': return { kind: 'AS3', ordNo: str(b?.sOrdNo), orgOrdNo: str(b?.sOrgOrdNo), cancCnfQty: num(b?.sCancCnfQty), orgOrdCancQty: num(b?.sOrgOrdCancQty), unfilledQty: num(b?.sUnercQty), orgOrdUnercQty: num(b?.sOrgOrdUnercQty), trxPtnCode: str(b?.sOrdTrxPtnCode), rejectReason: str(b?.sRjtRsn) };
    case 'AS4': return { kind: 'AS4', ordNo: str(b?.sOrdNo), orgOrdNo: str(b?.sOrgOrdNo), rejectReason: str(b?.sRjtRsn) };
    default: return null;
  }
}

// ── 주문 상태머신 ──────────────────────────────────────────────
export type OrderStatus =
  | 'CREATED' | 'SUBMITTED' | 'ACCEPTED' | 'PARTIALLY_FILLED' | 'FILLED'
  | 'MODIFIED' | 'CANCELLED' | 'PARTIALLY_FILLED_CANCELLED' | 'REJECTED';

export const TERMINAL_STATUSES: OrderStatus[] = ['FILLED', 'CANCELLED', 'PARTIALLY_FILLED_CANCELLED', 'REJECTED'];

// 허용된 전방향 전이만 승인(역방향/불허 전이는 차단).
const ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  CREATED: ['SUBMITTED'],
  SUBMITTED: ['ACCEPTED', 'REJECTED', 'PARTIALLY_FILLED', 'FILLED'],
  ACCEPTED: ['PARTIALLY_FILLED', 'FILLED', 'MODIFIED', 'CANCELLED', 'PARTIALLY_FILLED_CANCELLED', 'REJECTED'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'MODIFIED', 'CANCELLED', 'PARTIALLY_FILLED_CANCELLED'],
  MODIFIED: ['MODIFIED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'PARTIALLY_FILLED_CANCELLED'],
  FILLED: [],
  CANCELLED: [],
  PARTIALLY_FILLED_CANCELLED: [],
  REJECTED: [],
};
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export interface TrackedOrder {
  ordNo: string; orgOrdNo: string; symbol: string;
  status: OrderStatus;
  ordQty: number; ordPrc: number;
  cumExecQty: number; avgExecPrc: number; unfilledQty: number;
  mktCode?: string;               // P0-38: AS0 sOrdMktCode(=주문 OrdMktCode=exchcd) — 향후 복원 exchcd 공식소스
  rejectReason: string;
  restCancelOk: boolean;          // REST 취소 성공 여부(AS3 와 별개) — LIVE 취소완료 판정용
  seenExecIds: string[];          // sExecNO/sAbrdExecId 중복 무시
  seenCancelKeys: string[];       // AS3 idempotent 무시
  updatedAtMs: number;
}

function seedOrder(ordNo: string, ev: OrderEvent): TrackedOrder {
  return { ordNo, orgOrdNo: ev.kind === 'AS3' ? ev.orgOrdNo : (ev as any).orgOrdNo ?? '', symbol: (ev as any).symbol ?? '', status: 'SUBMITTED', ordQty: (ev as any).ordQty ?? 0, ordPrc: (ev as any).ordPrc ?? 0, cumExecQty: 0, avgExecPrc: 0, unfilledQty: 0, rejectReason: '', restCancelOk: false, seenExecIds: [], seenCancelKeys: [], updatedAtMs: 0 };
}

// 이벤트가 지시하는 목표 상태(전이 불필요면 null).
function targetStatus(ev: OrderEvent, cur: TrackedOrder): OrderStatus | null {
  switch (ev.kind) {
    case 'AS0': return 'ACCEPTED';
    case 'AS1':
      if (!(ev.execQty > 0)) return null;
      return ev.unfilledQty === 0 ? 'FILLED' : 'PARTIALLY_FILLED';
    case 'AS2': return 'MODIFIED';
    case 'AS3':
      if (!(ev.cancCnfQty > 0) || ev.rejectReason) return null;   // 취소확인수량 양수 + 거부사유 없을 때만
      return cur.cumExecQty > 0 ? 'PARTIALLY_FILLED_CANCELLED' : 'CANCELLED';
    case 'AS4': return 'REJECTED';
  }
}

export interface ApplyResult { order: TrackedOrder | null; changed: boolean; ignored: boolean; transition: string; reason: string; }

// 이벤트를 tracker(ordNo 키 Map)에 반영. 멱등/전이차단 포함. AS3 는 sOrgOrdNo 로 원주문을 찾는다.
export function applyOrderEvent(map: Map<string, TrackedOrder>, ev: OrderEvent, nowMs: number): ApplyResult {
  const targetKey = ev.kind === 'AS3' ? ev.orgOrdNo : ev.ordNo;   // AS3: 원주문번호 기준
  if (!targetKey) return { order: null, changed: false, ignored: true, transition: '', reason: '주문번호 없음' };
  const cur = map.get(targetKey) ?? seedOrder(targetKey, ev);
  const from = cur.status;

  // 멱등: 중복 체결/취소 이벤트 무시
  if (ev.kind === 'AS1') {
    const eid = ev.execNo || ev.abrdExecId;
    if (eid && cur.seenExecIds.includes(eid)) return { order: cur, changed: false, ignored: true, transition: from, reason: `중복 체결 무시(${eid})` };
  }
  if (ev.kind === 'AS3') {
    const ck = `${ev.ordNo}|${ev.cancCnfQty}`;
    if (cur.seenCancelKeys.includes(ck)) return { order: cur, changed: false, ignored: true, transition: from, reason: '중복 AS3 무시' };
  }

  const target = targetStatus(ev, cur);
  if (target == null) return { order: cur, changed: false, ignored: true, transition: from, reason: '상태 변경 없음(조건 미충족)' };
  if (!canTransition(from, target)) return { order: cur, changed: false, ignored: true, transition: `${from}⨯→${target}`, reason: '역방향/불허 전이 차단' };

  const next: TrackedOrder = { ...cur, status: target, updatedAtMs: nowMs, seenExecIds: [...cur.seenExecIds], seenCancelKeys: [...cur.seenCancelKeys] };
  switch (ev.kind) {
    case 'AS0':
      next.orgOrdNo = ev.orgOrdNo || next.orgOrdNo; next.symbol = ev.symbol || next.symbol;
      next.mktCode = ev.mktCode || next.mktCode;   // P0-38: 주문 거래소코드(exchcd) 보존
      next.ordQty = ev.ordQty || next.ordQty; next.ordPrc = ev.ordPrc || next.ordPrc; next.unfilledQty = ev.unfilledQty;
      if (ev.rejectReason) next.rejectReason = ev.rejectReason;
      break;
    case 'AS1': {
      const eid = ev.execNo || ev.abrdExecId;
      if (eid) next.seenExecIds.push(eid);
      next.cumExecQty = cur.cumExecQty + ev.execQty;   // 누적 체결수량
      next.avgExecPrc = ev.avgExecPrc > 0 ? ev.avgExecPrc : next.avgExecPrc;   // 평균 체결가
      next.unfilledQty = ev.unfilledQty;
      break;
    }
    case 'AS2':
      next.unfilledQty = ev.unfilledQty;
      if (ev.mdfyCnfPrc > 0) next.ordPrc = ev.mdfyCnfPrc;
      break;
    case 'AS3':
      next.seenCancelKeys.push(`${ev.ordNo}|${ev.cancCnfQty}`);
      next.unfilledQty = ev.unfilledQty;
      break;
    case 'AS4':
      next.rejectReason = ev.rejectReason;
      break;
  }
  map.set(targetKey, next);
  return { order: next, changed: true, ignored: false, transition: `${from}→${target}`, reason: '' };
}

// LIVE 취소 오케스트레이션 "완료" 판정 — AS3 만으로는 불충분(REST 취소 성공 + AS3 둘 다 필요).
export function isCancelComplete(o: TrackedOrder): boolean {
  return o.restCancelOk === true && (o.status === 'CANCELLED' || o.status === 'PARTIALLY_FILLED_CANCELLED');
}
