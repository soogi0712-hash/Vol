// 실주문 오케스트레이션 (주입식 의존성 — 단위테스트 가능). place→기록→체결확인→미체결취소.
// ⚠️ 러너는 canExecuteLive().execute===true 일 때만 이 함수를 호출한다. LS_LIVE_TRADING=false
//    또는 취소 TR 미확인이면 절대 호출되지 않는다. 함수 자체도 한도/중복/미체결을 방어적으로 재검증한다.
import type { OrderStore } from './order-store';
import type { LSOrderResult, LSOrderExecResult } from '../src/lib/ls-api';

export interface TraderDeps {
  place: (p: { exchcd: string; symbol: string; qty: number; price: number }) => Promise<LSOrderResult>;
  query: (p: { exchcd: string; symbol?: string; ordDate: string; execYn?: '0' | '1' | '2' }) => Promise<LSOrderExecResult>;
  cancel: (p: { exchcd: string; symbol: string; ordNo: string; qty: number }) => Promise<unknown>;
  log: (m: string) => void;
}
export interface BuyParams { orders: OrderStore; exchcd: string; symbol: string; candleDatetime: string; qty: number; price: number; etDate: string; }
export type BuyStatus = 'placed-filled' | 'placed-unfilled-cancelled' | 'placed-unfilled-pending' | 'aborted';
export interface BuyOutcome { status: BuyStatus; ordNo: string | null; reason: string; }

export async function executeBuyOrder(deps: TraderDeps, p: BuyParams): Promise<BuyOutcome> {
  // 방어적 재검증 (게이트와 별개로 한 번 더 — 중복/한도/미체결 차단)
  if (p.orders.corrupt) return { status: 'aborted', ordNo: null, reason: '주문상태 파일 손상' };
  if (!p.orders.canBuyToday(p.etDate)) return { status: 'aborted', ordNo: null, reason: '하루 매수 한도 초과' };
  if (p.orders.hasOrderedCandle(p.candleDatetime, 'buy')) return { status: 'aborted', ordNo: null, reason: '동일 확정봉 중복주문' };
  if (p.orders.hasPending()) return { status: 'aborted', ordNo: null, reason: '미체결 주문 존재' };

  // ① 지정가 매수 전송
  const res = await deps.place({ exchcd: p.exchcd, symbol: p.symbol, qty: p.qty, price: p.price });
  if (res.rspCd !== '00000') return { status: 'aborted', ordNo: null, reason: `주문 거부 rsp_cd=${res.rspCd} ${res.rspMsg}` };

  // ② 주문번호 확보 — 응답 우선, 없으면 체결내역조회로 매칭
  const exec = await deps.query({ exchcd: p.exchcd, symbol: p.symbol, ordDate: p.etDate });
  let ordNo = res.ordNo;
  if (!ordNo) ordNo = exec.rows.find(r => r.symbol === p.symbol && r.ordPtnCode === '02' && r.ordQty === p.qty)?.ordNo ?? null;

  // ③ 기록 + 즉시 저장 (재시작 중복주문 방지 + 일일 한도 반영)
  p.orders.recordPlaced('buy', p.candleDatetime, p.etDate, { ordNo: ordNo ?? '(unknown)', symbol: p.symbol, qty: p.qty, price: p.price });
  p.orders.flush();
  deps.log(`[ORDER ${p.symbol}] 매수 전송 rsp_cd=${res.rspCd} ordNo=${ordNo ?? '(미확인)'} qty=${p.qty} price=${p.price}`);

  // ④ 체결확인
  const mine = ordNo ? exec.rows.find(r => r.ordNo === ordNo) ?? null : null;
  if (mine && mine.execQty >= p.qty) {
    if (ordNo) { p.orders.resolvePending(ordNo); p.orders.flush(); }
    return { status: 'placed-filled', ordNo, reason: '전량 체결' };
  }

  // ⑤ 미체결 → 취소
  const unfilled = mine ? mine.unfilledQty : p.qty;
  if (ordNo && unfilled > 0) {
    try {
      await deps.cancel({ exchcd: p.exchcd, symbol: p.symbol, ordNo, qty: unfilled });
      p.orders.resolvePending(ordNo);
      p.orders.flush();
      return { status: 'placed-unfilled-cancelled', ordNo, reason: '미체결 취소 완료' };
    } catch (e) {
      return { status: 'placed-unfilled-pending', ordNo, reason: `미체결 취소 실패(${e instanceof Error ? e.message : String(e)}) → pending 유지(수동 확인)` };
    }
  }
  return { status: 'placed-unfilled-pending', ordNo, reason: '미체결 · 주문번호 미확인 → pending 유지' };
}
