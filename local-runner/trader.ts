// 실주문 오케스트레이션 (주입식 의존성 — 단위테스트 가능).
//  ① executeBuyOrder: 전송→주문번호 확보→즉시저장→체결확인. 미체결이면 pending 유지.
//  ② reconcilePending: 이후 틱마다 미체결을 재조회, 타임아웃 경과 시 COSAT00311 취소.
// ⚠️ 러너는 canExecuteLive().execute===true 일 때만 호출한다(현재 항상 false). 함수도 방어적 재검증.
//    실패 시 자동 재주문 금지(req 19). 모든 LS 원문 rsp_cd/rsp_msg 저장(req 18).
import type { OrderStore } from './order-store';
import type { LSOrderResult, LSOrderExecResult } from '../src/lib/ls-api';

export interface TraderDeps {
  place: (p: { exchcd: string; symbol: string; qty: number; price: number }) => Promise<LSOrderResult>;
  query: (p: { exchcd: string; symbol?: string; ordDate: string; execYn?: '0' | '1' | '2' }) => Promise<LSOrderExecResult>;
  cancel: (p: { exchcd: string; symbol: string; ordNo: string; qty: number }) => Promise<{ rspCd: string; rspMsg: string }>;
  now: () => number;
  log: (m: string) => void;
}
export interface BuyParams { orders: OrderStore; exchcd: string; symbol: string; candleDatetime: string; qty: number; price: number; etDate: string; dailyMaxBuys: number; }
export type BuyStatus = 'placed-filled' | 'placed-pending' | 'aborted';
export interface BuyOutcome { status: BuyStatus; ordNo: string | null; reason: string; }

export async function executeBuyOrder(deps: TraderDeps, p: BuyParams): Promise<BuyOutcome> {
  // 방어적 재검증 (게이트와 별개로 한 번 더 — 손상/한도/중복/미체결 차단)
  if (p.orders.corrupt) return { status: 'aborted', ordNo: null, reason: '주문상태 파일 손상' };
  if (!p.orders.canBuyToday(p.etDate, p.dailyMaxBuys)) return { status: 'aborted', ordNo: null, reason: '하루 매수 한도 초과' };
  if (p.orders.hasOrderedCandle(p.candleDatetime, 'buy')) return { status: 'aborted', ordNo: null, reason: '동일 확정봉 중복주문' };
  if (p.orders.hasPending()) return { status: 'aborted', ordNo: null, reason: '미체결 주문 존재' };

  // ① 지정가 매수 전송
  const res = await deps.place({ exchcd: p.exchcd, symbol: p.symbol, qty: p.qty, price: p.price });
  p.orders.recordResponse({ atMs: deps.now(), tr: 'COSAT00301', rspCd: res.rspCd, rspMsg: res.rspMsg, ordNo: res.ordNo, note: '매수전송' });
  if (res.rspCd !== '00000') { p.orders.flush(); return { status: 'aborted', ordNo: null, reason: `주문 거부 rsp_cd=${res.rspCd} ${res.rspMsg}` }; }

  // ② 주문번호 확보 — 응답 우선, 없으면 체결내역조회로 매칭
  const exec = await deps.query({ exchcd: p.exchcd, symbol: p.symbol, ordDate: p.etDate });
  p.orders.recordResponse({ atMs: deps.now(), tr: 'COSAQ00102', rspCd: exec.rspCd, rspMsg: exec.rspMsg, ordNo: res.ordNo, note: '체결확인' });
  let ordNo = res.ordNo;
  if (!ordNo) ordNo = exec.rows.find(r => r.symbol === p.symbol && r.ordPtnCode === '02' && r.ordQty === p.qty)?.ordNo ?? null;

  // ③ 기록 + 즉시 저장 (주문번호 디스크 저장 req12 + 재시작 중복주문 방지 + 일일 한도)
  p.orders.recordPlaced('buy', p.candleDatetime, p.etDate, { ordNo: ordNo ?? '(unknown)', symbol: p.symbol, qty: p.qty, price: p.price, placedAtMs: deps.now() });
  p.orders.flush();
  deps.log(`[ORDER ${p.symbol}] 매수 전송 rsp_cd=${res.rspCd} ordNo=${ordNo ?? '(미확인)'} qty=${p.qty} price=${p.price}`);

  // ④ 체결확인 — 전량 체결이면 즉시 해소, 아니면 pending 유지(취소는 reconcilePending 이 타임아웃 후 수행)
  const mine = ordNo ? exec.rows.find(r => r.ordNo === ordNo) ?? null : null;
  if (mine && mine.execQty >= p.qty) {
    if (ordNo) { p.orders.resolvePending(ordNo); p.orders.flush(); }
    return { status: 'placed-filled', ordNo, reason: '전량 체결' };
  }
  return { status: 'placed-pending', ordNo, reason: '미체결 → pending 유지(타임아웃 후 취소)' };
}

export type ReconcileStatus = 'filled' | 'cancelled' | 'cancel-failed' | 'waiting' | 'none';
export interface ReconcileOutcome { ordNo: string; status: ReconcileStatus; reason: string; }

// 미체결 주문을 재조회한다. 체결완료→해소. 타임아웃 경과 & 미체결→COSAT00311 취소(성공 시 해소).
// req14(타임아웃 취소)·req15(취소 성공 확인 전 다음 주문 금지 — pending 유지로 자동 보장)·req18(원문 저장).
export async function reconcilePending(
  deps: TraderDeps, p: { orders: OrderStore; exchcd: string; ordDate: string; timeoutMs: number },
): Promise<ReconcileOutcome[]> {
  const out: ReconcileOutcome[] = [];
  for (const po of p.orders.pending) {
    const exec = await deps.query({ exchcd: p.exchcd, symbol: po.symbol, ordDate: p.ordDate });
    p.orders.recordResponse({ atMs: deps.now(), tr: 'COSAQ00102', rspCd: exec.rspCd, rspMsg: exec.rspMsg, ordNo: po.ordNo, note: '미체결 재조회' });
    const row = exec.rows.find(r => r.ordNo === po.ordNo) ?? null;
    if (row && row.execQty >= po.qty) {
      p.orders.resolvePending(po.ordNo); p.orders.flush();
      out.push({ ordNo: po.ordNo, status: 'filled', reason: '전량 체결' });
      continue;
    }
    const ageMs = deps.now() - po.placedAtMs;
    if (ageMs < p.timeoutMs) { out.push({ ordNo: po.ordNo, status: 'waiting', reason: `미체결 ${Math.round(ageMs / 1000)}s (타임아웃 ${Math.round(p.timeoutMs / 1000)}s)` }); continue; }
    // 타임아웃 → 취소
    const unfilled = row ? row.unfilledQty : po.qty;
    try {
      const c = await deps.cancel({ exchcd: p.exchcd, symbol: po.symbol, ordNo: po.ordNo, qty: unfilled });
      p.orders.recordResponse({ atMs: deps.now(), tr: 'COSAT00311', rspCd: c.rspCd, rspMsg: c.rspMsg, ordNo: po.ordNo, note: '미체결 취소' });
      if (c.rspCd === '00000') {
        p.orders.resolvePending(po.ordNo); p.orders.flush();
        out.push({ ordNo: po.ordNo, status: 'cancelled', reason: '미체결 취소 완료' });
      } else {
        p.orders.flush();
        out.push({ ordNo: po.ordNo, status: 'cancel-failed', reason: `취소 거부 rsp_cd=${c.rspCd} → pending 유지(수동확인)` });
      }
    } catch (e) {
      out.push({ ordNo: po.ordNo, status: 'cancel-failed', reason: `취소 실패(${e instanceof Error ? e.message : String(e)}) → pending 유지` });
    }
  }
  return out;
}
