// 국내(현물) 실주문 오케스트레이션 (주입식 의존성 — 단위테스트 가능).
//  executeKRBuyOrder: 방어재검증 → 지정가 매수 전송 → 주문번호 즉시저장 → 체결조회로 확인(전량/부분).
//  reconcileKRPending: 이후 실행마다 미체결을 체결조회로 재확인(전량체결 시 해소). 실패 시 자동 재주문 없음.
// ⚠️ 러너는 LS_LIVE_TRADING='true' 일 때만 place 를 호출한다. false 면 파라미터만 로그(주문 API 미호출).
//    체결조회 실패/빈응답은 절대 "체결완료"로 오판하지 않는다(미확인 → pending 유지 → 신규주문 차단).
import type { OrderStore } from './order-store';
import type { LSKROrderResult, LSKROrderExec } from '../src/lib/ls-api';

export interface KRTraderDeps {
  place: (p: { shcode: string; qty: number; price: number; mbrNo?: string }) => Promise<LSKROrderResult>;
  queryExec: (p: { shcode: string; ordDate: string; bnsTpCode?: string }) => Promise<LSKROrderExec>;
  cancel: (p: { orgOrdNo: string; shcode: string; qty: number }) => Promise<LSKROrderResult>;   // CSPAT00801
  now: () => number;
  log: (m: string) => void;
}

// CSPAT00801 취소 응답 성공(00000/00156=취소 접수) 판정.
const isKRCancelAccepted = (rspCd: string) => rspCd === '00000' || rspCd === '00156';
export interface KRBuyParams { orders: OrderStore; shcode: string; candleDatetime: string; qty: number; price: number; krDate: string; mbrNo?: string; dailyMaxBuys: number; }
export type KRBuyStatus = 'placed-filled' | 'placed-partial' | 'placed-pending' | 'aborted';
export interface KRBuyOutcome { status: KRBuyStatus; ordNo: string | null; execQty: number; reason: string; }

export async function executeKRBuyOrder(deps: KRTraderDeps, p: KRBuyParams): Promise<KRBuyOutcome> {
  // 방어적 재검증 (손상/한도/중복/미체결 차단)
  if (p.orders.corrupt) return { status: 'aborted', ordNo: null, execQty: 0, reason: '주문상태 파일 손상' };
  if (!p.orders.canBuyToday(p.krDate, p.dailyMaxBuys)) return { status: 'aborted', ordNo: null, execQty: 0, reason: '하루 매수 한도 초과' };
  if (p.orders.hasOrderedCandle(p.candleDatetime, 'buy')) return { status: 'aborted', ordNo: null, execQty: 0, reason: '동일 확정봉 중복주문' };
  if (p.orders.hasPending()) return { status: 'aborted', ordNo: null, execQty: 0, reason: '미체결 주문 존재' };

  // ① 지정가 매수 전송 (CSPAT00601)
  const res = await deps.place({ shcode: p.shcode, qty: p.qty, price: p.price, mbrNo: p.mbrNo });
  p.orders.recordResponse({ atMs: deps.now(), tr: 'CSPAT00601', rspCd: res.rspCd, rspMsg: res.rspMsg, ordNo: res.ordNo, note: '현물매수전송' });
  if (res.rspCd !== '00000') { p.orders.flush(); return { status: 'aborted', ordNo: null, execQty: 0, reason: `주문 거부 rsp_cd=${res.rspCd} ${res.rspMsg}` }; }
  const ordNo = res.ordNo;

  // ② 주문번호 즉시 저장 (재시작 복원 + 일일 한도 + 동일봉 중복 방지)
  p.orders.recordPlaced('buy', p.candleDatetime, p.krDate, { ordNo: ordNo ?? '(unknown)', symbol: p.shcode, qty: p.qty, price: p.price, placedAtMs: deps.now() });
  p.orders.flush();
  deps.log(`[KR-ORDER ${p.shcode}] 매수 전송 rsp_cd=${res.rspCd} ordNo=${ordNo ?? '(미확인)'} qty=${p.qty} price=${p.price}`);

  // ③ 체결조회 (CSPAQ13700 집계) — 전량/부분/미체결 판정
  const ex = await deps.queryExec({ shcode: p.shcode, ordDate: p.krDate, bnsTpCode: '2' });
  p.orders.recordResponse({ atMs: deps.now(), tr: 'CSPAQ13700', rspCd: ex.rspCd, rspMsg: ex.ok ? `buyExec=${ex.buyExecQty}/${ex.buyOrdQty}` : ex.rspMsg, ordNo, note: '체결조회' });
  if (ex.ok && ex.buyExecQty >= p.qty) {
    if (ordNo) p.orders.resolvePending(ordNo);
    p.orders.flush();
    return { status: 'placed-filled', ordNo, execQty: ex.buyExecQty, reason: '전량 체결' };
  }
  p.orders.flush();
  if (ex.ok && ex.buyExecQty > 0) return { status: 'placed-partial', ordNo, execQty: ex.buyExecQty, reason: `부분체결 ${ex.buyExecQty}/${p.qty} → pending 유지` };
  return { status: 'placed-pending', ordNo, execQty: 0, reason: '미체결 → pending 유지(신규주문 차단)' };
}

export type KRReconcileStatus = 'filled' | 'partial' | 'pending' | 'cancelled' | 'cancel-failed' | 'query-failed';
export interface KRReconcileOutcome { ordNo: string; status: KRReconcileStatus; execQty: number; reason: string; }

// 미체결 재확인 — 실행마다 체결조회. 전량체결이면 해소. timeoutMs 경과 & 미체결이면 CSPAT00801 취소.
//   취소 접수(rsp_cd 00000/00156) 확인 시에만 해소(=다음 주문 허용, req11). 취소 실패/조회실패는 pending 유지(오판 금지).
export async function reconcileKRPending(deps: KRTraderDeps, p: { orders: OrderStore; shcode: string; krDate: string; timeoutMs: number }): Promise<KRReconcileOutcome[]> {
  const out: KRReconcileOutcome[] = [];
  for (const po of p.orders.pending) {
    const ex = await deps.queryExec({ shcode: po.symbol, ordDate: p.krDate, bnsTpCode: '2' });
    p.orders.recordResponse({ atMs: deps.now(), tr: 'CSPAQ13700', rspCd: ex.rspCd, rspMsg: ex.ok ? `buyExec=${ex.buyExecQty}/${ex.buyOrdQty}` : ex.rspMsg, ordNo: po.ordNo, note: '미체결 재확인' });
    if (!ex.ok) { out.push({ ordNo: po.ordNo, status: 'query-failed', execQty: 0, reason: `체결조회 실패(${ex.rspCd}) → pending 유지` }); continue; }
    if (ex.buyExecQty >= po.qty) {
      p.orders.resolvePending(po.ordNo); p.orders.flush();
      out.push({ ordNo: po.ordNo, status: 'filled', execQty: ex.buyExecQty, reason: '전량 체결 → 해소' });
      continue;
    }
    const ageMs = deps.now() - po.placedAtMs;
    if (ageMs < p.timeoutMs) {
      out.push({ ordNo: po.ordNo, status: ex.buyExecQty > 0 ? 'partial' : 'pending', execQty: ex.buyExecQty, reason: `${ex.buyExecQty > 0 ? `부분체결 ${ex.buyExecQty}/${po.qty}` : '미체결'} · ${Math.round(ageMs / 1000)}s(타임아웃 ${Math.round(p.timeoutMs / 1000)}s) → pending 유지` });
      continue;
    }
    // 타임아웃 → 잔량 취소(CSPAT00801)
    const remaining = Math.max(1, po.qty - ex.buyExecQty);
    try {
      const c = await deps.cancel({ orgOrdNo: po.ordNo, shcode: po.symbol, qty: remaining });
      p.orders.recordResponse({ atMs: deps.now(), tr: 'CSPAT00801', rspCd: c.rspCd, rspMsg: c.rspMsg, ordNo: po.ordNo, note: '미체결 취소' });
      if (isKRCancelAccepted(c.rspCd)) {
        p.orders.resolvePending(po.ordNo); p.orders.flush();
        out.push({ ordNo: po.ordNo, status: 'cancelled', execQty: ex.buyExecQty, reason: `취소 접수 rsp_cd=${c.rspCd} ${c.rspMsg} → 해소` });
      } else {
        p.orders.flush();
        out.push({ ordNo: po.ordNo, status: 'cancel-failed', execQty: ex.buyExecQty, reason: `취소 거부 rsp_cd=${c.rspCd} ${c.rspMsg} → pending 유지(다음 주문 금지)` });
      }
    } catch (e) {
      out.push({ ordNo: po.ordNo, status: 'cancel-failed', execQty: ex.buyExecQty, reason: `취소 실패(${e instanceof Error ? e.message : String(e)}) → pending 유지` });
    }
  }
  return out;
}
