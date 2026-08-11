// 미국 SELL 실행 오케스트레이션 (P0-30B) — BUY(trader.ts)와 완전히 분리. 주입식 의존성(단위테스트 가능).
//  흐름: 방어재검증(보유/pending SELL/동일candle) → 거래소 대사 → candle lock → SELL POST → 체결확인.
//  안전장치(BUY와 동일): POST 직전 idempotency lock, 응답 timeout/오류에도 재전송 금지(candle 잠금 유지),
//    실제 체결은 대사/AS 이벤트로 확인, pending SELL 존재 시 동일종목 재매도 금지.
//  ⚠️ 매도 OrdPtnCode 공식 미확인(LS_US_SELL_TR_CONFIRMED=false) 동안 place 는 예외를 던져 실전송을 하드 차단한다.
import type { OrderStore } from './order-store';
import { isUSOrderSuccess, LS_US_SELL_ORDPTN_CANDIDATE, type LSOrderResult, type LSOrderExecResult } from '../src/lib/ls-api';

export interface SellDeps {
  place: (p: { exchcd: string; symbol: string; qty: number; price: number }) => Promise<LSOrderResult>;
  query: (p: { exchcd: string; symbol?: string; ordDate: string }) => Promise<LSOrderExecResult>;
  now: () => number;
  log: (m: string) => void;
}
export interface SellParams { orders: OrderStore; exchcd: string; symbol: string; candleDatetime: string; qty: number; price: number; etDate: string; }
export type SellStatus = 'placed-filled' | 'placed-partial' | 'placed-pending' | 'aborted';
export type SellAbortCode = 'CORRUPT' | 'NO_QTY' | 'DUPLICATE_CANDLE' | 'PENDING_SELL' | 'RECONCILIATION_FAILED' | 'UNRECORDED_ORDER' | 'ORDER_REJECTED' | 'SEND_EXCEPTION' | 'POST_UNCONFIRMED';
export interface SellOutcome { status: SellStatus; ordNo: string | null; execQty: number; fillPrice: number; reason: string; abortCode?: SellAbortCode; }

const hasPendingSell = (orders: OrderStore): boolean => orders.pending.some(o => o.side === 'sell');

export async function executeSellOrder(deps: SellDeps, p: SellParams): Promise<SellOutcome> {
  const abort = (reason: string, abortCode: SellAbortCode): SellOutcome => ({ status: 'aborted', ordNo: null, execQty: 0, fillPrice: 0, reason, abortCode });
  // ① 방어적 재검증 — 손상/수량/동일candle/pending SELL(중복 매도 금지)
  if (p.orders.corrupt) return abort('주문상태 파일 손상', 'CORRUPT');
  if (!(p.qty > 0)) return abort('매도수량 0 — 전송 금지', 'NO_QTY');
  if (p.orders.hasOrderedCandle(p.candleDatetime, 'sell')) return abort('동일 확정봉 이미 매도(잠금됨)', 'DUPLICATE_CANDLE');
  if (hasPendingSell(p.orders)) return abort('미체결 SELL 존재 → 동일종목 재매도 금지', 'PENDING_SELL');

  // ② 거래소 실제 주문내역 대사(reconciliation) — 미기록 매도 감지(BUY와 동일 fail-closed 원칙)
  let chk: LSOrderExecResult;
  try { chk = await deps.query({ exchcd: p.exchcd, symbol: p.symbol, ordDate: p.etDate }); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.log(`[US-SELL-RECON ${p.symbol}] queryOk=false rsp_cd=EXCEPTION rsp_msg=${msg} → RECONCILIATION_FAILED(예외)`);
    p.orders.recordResponse({ atMs: deps.now(), tr: 'COSAQ00102', rspCd: 'EXCEPTION', rspMsg: msg, ordNo: null, note: 'SELL 대사 예외(조회실패)' }); p.orders.flush();
    return abort('매도 대사 조회 실패(예외/timeout) → 안전차단(전송 금지)', 'RECONCILIATION_FAILED');
  }
  p.orders.recordResponse({ atMs: deps.now(), tr: 'COSAQ00102', rspCd: chk.rspCd, rspMsg: chk.rspMsg, ordNo: null, note: `SELL 주문전 대사 class=${chk.classification}` });
  const postAllowedByQuery = chk.classification === 'SUCCESS' || chk.classification === 'EMPTY';
  const sellRows = chk.rows.filter(r => r.symbol === p.symbol && r.ordPtnCode === LS_US_SELL_ORDPTN_CANDIDATE);
  const localSells = p.orders.sellCountToday(p.etDate);
  deps.log(`[US-SELL-RECON ${p.symbol}] rsp_cd=${chk.rspCd} queryOk=${chk.queryOk} class=${chk.classification} sellRows=${sellRows.length} localSells=${localSells} → ${postAllowedByQuery ? 'POST_ALLOWED' : `RECONCILIATION_FAILED(${chk.classification})`}`);
  if (!postAllowedByQuery) { p.orders.flush(); return abort(`매도 대사 ${chk.classification}(rsp_cd=${chk.rspCd}) → 안전차단(전송 금지)`, 'RECONCILIATION_FAILED'); }
  if (sellRows.length > localSells) { p.orders.flush(); return abort(`거래소 매도주문 ${sellRows.length} > 로컬 ${localSells} → 미기록 매도 감지, 전송 금지(대사)`, 'UNRECORDED_ORDER'); }

  // ③ candle lock — 전송 직전 영구잠금 + flush. 이후 timeout/500/parse 오류가 나도 재전송 금지.
  p.orders.lockCandle(p.candleDatetime, 'sell');
  p.orders.flush();

  // ④ SELL 전송(COSAT00301 매도). 매도코드 미확인 상태면 place 가 예외 → candle 잠금 유지(재전송 없음).
  let res: LSOrderResult;
  try { res = await deps.place({ exchcd: p.exchcd, symbol: p.symbol, qty: p.qty, price: p.price }); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const unconfirmed = /미확인|보류|OrdPtnCode/.test(msg);
    p.orders.recordResponse({ atMs: deps.now(), tr: 'COSAT00301', rspCd: unconfirmed ? 'SELL_UNCONFIRMED' : 'EXCEPTION', rspMsg: msg, ordNo: null, note: 'SELL 전송 예외(candle 잠금 유지)' });
    p.orders.flush();
    return { status: 'aborted', ordNo: null, execQty: 0, fillPrice: 0, reason: unconfirmed ? '매도 OrdPtnCode 미확인 → SELL POST 하드차단' : `전송 예외 → candle 잠금 유지(재전송 없음)`, abortCode: unconfirmed ? 'POST_UNCONFIRMED' : 'SEND_EXCEPTION' };
  }
  p.orders.recordResponse({ atMs: deps.now(), tr: 'COSAT00301', rspCd: res.rspCd, rspMsg: res.rspMsg, ordNo: res.ordNo, note: '매도전송' });
  if (!isUSOrderSuccess(res.rspCd, res.ordNo)) { p.orders.flush(); return { status: 'aborted', ordNo: res.ordNo ?? null, execQty: 0, fillPrice: 0, reason: `매도 거부 rsp_cd=${res.rspCd} ${res.rspMsg} (candle 잠금 유지)`, abortCode: 'ORDER_REJECTED' }; }

  // ⑤ 주문번호 확보 + pending SELL 저장(체결은 AS1/대사로 확인)
  const exec = await deps.query({ exchcd: p.exchcd, symbol: p.symbol, ordDate: p.etDate });
  p.orders.recordResponse({ atMs: deps.now(), tr: 'COSAQ00102', rspCd: exec.rspCd, rspMsg: exec.rspMsg, ordNo: res.ordNo, note: 'SELL 체결확인' });
  let ordNo = res.ordNo;
  const mine = ordNo ? exec.rows.find(r => r.ordNo === ordNo) ?? null
    : exec.rows.find(r => r.symbol === p.symbol && r.ordPtnCode === LS_US_SELL_ORDPTN_CANDIDATE && r.ordQty === p.qty) ?? null;
  if (!ordNo && mine) ordNo = mine.ordNo;
  p.orders.recordPlaced('sell', p.candleDatetime, p.etDate, { ordNo: ordNo ?? '(unknown)', symbol: p.symbol, qty: p.qty, price: p.price, placedAtMs: deps.now() });
  p.orders.flush();
  deps.log(`[US-SELL-ORDER ${p.symbol}] 매도 전송 성공 rsp_cd=${res.rspCd} ordNo=${ordNo ?? '(미확인)'} qty=${p.qty} price=${p.price}`);

  // ⑥ 체결 판정 — 전량/부분/미체결. fillPrice 는 대사 ordPrc(참고), 정확한 체결가는 AS1 avgExecPrc 로 러너가 갱신.
  if (mine && mine.execQty >= p.qty) {
    if (ordNo) { p.orders.resolvePending(ordNo); p.orders.flush(); }
    return { status: 'placed-filled', ordNo, execQty: mine.execQty, fillPrice: mine.ordPrc || p.price, reason: '전량 체결' };
  }
  if (mine && mine.execQty > 0) return { status: 'placed-partial', ordNo, execQty: mine.execQty, fillPrice: mine.ordPrc || p.price, reason: `부분체결 ${mine.execQty}/${p.qty} → pending 유지` };
  return { status: 'placed-pending', ordNo, execQty: 0, fillPrice: 0, reason: '미체결 → pending 유지(재매도 금지)' };
}
