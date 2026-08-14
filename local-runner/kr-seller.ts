// 국내(현물) 실 SELL 오케스트레이션 (P0-33A) — BUY(kr-trader)와 완전 분리. 주입식 의존성(단위테스트 가능).
//   흐름: 방어재검증(보유/pending SELL/동일candle) → 거래소 대사(매도) → 실 매도가능수량 재조회(t0424) →
//     sellQty=min(전략수량, freshSellable) → candle lock → CSPAT00601 매도('1') 전송 → 체결확인.
//   ⚠️ freshSellable=0 → POST 금지. 조회실패 → fail-closed. timeout/500/불명확 응답 시 재POST 금지(candle 잠금 유지).
import type { OrderStore } from './order-store';
import { isKROrderSuccess, type LSKROrderResult, type LSKROrderExec } from '../src/lib/ls-api';

export interface KRSellDeps {
  place: (p: { shcode: string; qty: number; price: number; mbrNo?: string }) => Promise<LSKROrderResult>;   // placeLSKRSellOrder
  queryExec: (p: { shcode: string; ordDate: string; bnsTpCode?: string }) => Promise<LSKROrderExec>;         // queryLSKROrderExecUnified(bnsTpCode='1')
  freshSellable: (p: { shcode: string }) => Promise<{ ok: boolean; qty: number }>;                           // t0424 mdposqt(매도가능수량)
  now: () => number;
  log: (m: string) => void;
}
export interface KRSellParams { orders: OrderStore; shcode: string; candleDatetime: string; qty: number; price: number; krDate: string; mbrNo?: string; }
export type KRSellStatus = 'placed-filled' | 'placed-partial' | 'placed-pending' | 'aborted';
export type KRSellAbortCode = 'CORRUPT' | 'NO_QTY' | 'DUPLICATE_CANDLE' | 'PENDING_SELL' | 'RECONCILIATION_FAILED' | 'UNRECORDED_ORDER' | 'ORDER_REJECTED' | 'SEND_EXCEPTION';
export interface KRSellOutcome { status: KRSellStatus; ordNo: string | null; execQty: number; fillPrice: number; reason: string; abortCode?: KRSellAbortCode; }

const hasPendingSell = (orders: OrderStore): boolean => orders.pending.some(o => o.side === 'sell');

export async function executeKRSellOrder(deps: KRSellDeps, p: KRSellParams): Promise<KRSellOutcome> {
  const abort = (stage: string, reason: string, abortCode: KRSellAbortCode, extra?: { rspCd?: string; rspMsg?: string; classification?: string }): KRSellOutcome => {
    deps.log(`[KR-SELL-ABORT] stage=${stage} abortCode=${abortCode} rsp_cd=${extra?.rspCd ?? '-'} rsp_msg=${extra?.rspMsg ?? '-'} classification=${extra?.classification ?? '-'} reason=${reason}`);
    return { status: 'aborted', ordNo: null, execQty: 0, fillPrice: 0, reason, abortCode };
  };
  // ① 방어적 재검증 — 손상/수량/동일candle/pending SELL(중복 매도 금지)
  if (p.orders.corrupt) return abort('precheck', '주문상태 파일 손상', 'CORRUPT');
  if (!(p.qty > 0)) return abort('precheck', '매도수량 0 — 전송 금지', 'NO_QTY');
  if (p.orders.hasOrderedCandle(p.candleDatetime, 'sell')) return abort('precheck', '동일 확정봉 이미 매도(잠금됨)', 'DUPLICATE_CANDLE');
  if (hasPendingSell(p.orders)) return abort('precheck', '미체결 SELL 존재 → 동일종목 재매도 금지', 'PENDING_SELL');

  // ② 거래소 매도 대사(CSPAQ13700, bnsTpCode='1') — 미기록 매도 감지(fail-closed)
  const chk = await deps.queryExec({ shcode: p.shcode, ordDate: p.krDate, bnsTpCode: '1' });
  p.orders.recordResponse({ atMs: deps.now(), tr: 'CSPAQ13700', rspCd: chk.rspCd, rspMsg: chk.ok ? `대사 sellOrd=${chk.sellOrdQty} sellExec=${chk.sellExecQty}` : chk.rspMsg, ordNo: null, note: 'SELL 주문전 대사' });
  if (!chk.ok) { p.orders.flush(); return abort('reconciliation', `매도 대사 실패(${chk.rspCd}) → 안전차단(전송 금지)`, 'RECONCILIATION_FAILED', { rspCd: chk.rspCd, rspMsg: chk.rspMsg, classification: chk.classification }); }
  const localSellQty = p.orders.sellCountToday(p.krDate) * p.qty;
  if (chk.sellOrdQty > localSellQty) { p.orders.flush(); return abort('reconciliation', `거래소 당일 매도주문 ${chk.sellOrdQty} > 로컬 ${localSellQty} → 미기록 매도 감지, 전송 금지`, 'UNRECORDED_ORDER', { rspCd: chk.rspCd, classification: chk.classification }); }

  // ③ 실 매도가능수량 재조회(t0424 mdposqt) — sellQty=min(전략수량, 실제매도가능). 과매도 방지. 조회실패=fail-closed.
  let freshQty: { ok: boolean; qty: number };
  try { freshQty = await deps.freshSellable({ shcode: p.shcode }); }
  catch (e) { p.orders.flush(); return abort('sellable', `매도가능수량 재조회 예외(${e instanceof Error ? e.message : String(e)}) → 전송 금지`, 'RECONCILIATION_FAILED'); }
  if (!freshQty.ok) { p.orders.flush(); return abort('sellable', '매도가능수량 재조회 실패 → 전송 금지(fail-closed)', 'RECONCILIATION_FAILED'); }
  const sellQty = Math.max(0, Math.min(Math.floor(p.qty), Math.floor(freshQty.qty)));
  deps.log(`[KR-SELL-GATE ${p.shcode}] 실매도전 재조회 sellableNow=${freshQty.qty} 전략수량=${p.qty} → sellQty=${sellQty}`);
  if (sellQty < 1) { p.orders.flush(); return abort('sellable', `실계좌 매도가능수량 ${freshQty.qty} → 전송 금지(freshSellable=0)`, 'NO_QTY'); }

  // ④ candle lock — 전송 직전 영구잠금 + flush. 이후 timeout/500/parse 오류가 나도 재전송 금지.
  p.orders.lockCandle(p.candleDatetime, 'sell');
  p.orders.flush();

  // ⑤ 매도 전송 (CSPAT00601 BnsTpCode='1'). 예외 시 candle 잠금 유지(재전송 없음).
  let res: LSKROrderResult;
  try { res = await deps.place({ shcode: p.shcode, qty: sellQty, price: p.price, mbrNo: p.mbrNo }); }
  catch (e) {
    const em = e instanceof Error ? e.message : String(e);
    p.orders.recordResponse({ atMs: deps.now(), tr: 'CSPAT00601', rspCd: 'EXCEPTION', rspMsg: em, ordNo: null, note: 'SELL 전송 예외(candle 잠금 유지)' });
    p.orders.flush();
    return abort('send', '전송 예외 → candle 잠금 유지(재전송 없음). 실제 접수 여부는 다음 대사로 확인', 'SEND_EXCEPTION', { rspCd: 'EXCEPTION', rspMsg: em });
  }
  p.orders.recordResponse({ atMs: deps.now(), tr: 'CSPAT00601', rspCd: res.rspCd, rspMsg: res.rspMsg, ordNo: res.ordNo, note: '현물매도전송' });
  if (!isKROrderSuccess(res.rspCd, res.ordNo)) { p.orders.flush(); return abort('order-response', `매도 거부 rsp_cd=${res.rspCd} ${res.rspMsg} (candle 잠금 유지)`, 'ORDER_REJECTED', { rspCd: res.rspCd, rspMsg: res.rspMsg }); }
  const ordNo = res.ordNo;

  // ⑥ pending SELL 저장 + 체결확인(CSPAQ13700 sell 집계)
  p.orders.recordPlaced('sell', p.candleDatetime, p.krDate, { ordNo: ordNo ?? '(unknown)', symbol: p.shcode, qty: sellQty, price: p.price, placedAtMs: deps.now() });
  p.orders.flush();
  deps.log(`[KR-SELL-ORDER ${p.shcode}] 매도 전송 성공 rsp_cd=${res.rspCd} ordNo=${ordNo ?? '(미확인)'} qty=${sellQty} price=${p.price}`);

  const ex = await deps.queryExec({ shcode: p.shcode, ordDate: p.krDate, bnsTpCode: '1' });
  p.orders.recordResponse({ atMs: deps.now(), tr: 'CSPAQ13700', rspCd: ex.rspCd, rspMsg: ex.ok ? `sellExec=${ex.sellExecQty}/${ex.sellOrdQty}` : ex.rspMsg, ordNo, note: 'SELL 체결확인' });
  if (ex.ok && ex.sellExecQty >= sellQty) {
    if (ordNo) p.orders.resolvePending(ordNo);
    p.orders.flush();
    return { status: 'placed-filled', ordNo, execQty: sellQty, fillPrice: p.price, reason: '전량 체결' };
  }
  p.orders.flush();
  if (ex.ok && ex.sellExecQty > 0) return { status: 'placed-partial', ordNo, execQty: ex.sellExecQty, fillPrice: p.price, reason: `부분체결 ${ex.sellExecQty}/${sellQty} → pending 유지` };
  return { status: 'placed-pending', ordNo, execQty: 0, fillPrice: 0, reason: '미체결 → pending 유지(재매도 금지)' };
}
