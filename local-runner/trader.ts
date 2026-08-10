// 실주문 오케스트레이션 (주입식 의존성 — 단위테스트 가능).
//  ① executeBuyOrder: 전송→주문번호 확보→즉시저장→체결확인. 미체결이면 pending 유지.
//  ② reconcilePending: 이후 틱마다 미체결을 재조회, 타임아웃 경과 시 COSAT00311 취소.
// ⚠️ 러너는 canExecuteLive().execute===true 일 때만 호출한다(현재 항상 false). 함수도 방어적 재검증.
//    실패 시 자동 재주문 금지(req 19). 모든 LS 원문 rsp_cd/rsp_msg 저장(req 18).
import type { OrderStore } from './order-store';
import { isUSOrderSuccess, type LSOrderResult, type LSOrderExecResult } from '../src/lib/ls-api';
import type { TrackedOrder } from './order-events';

export interface TraderDeps {
  place: (p: { exchcd: string; symbol: string; qty: number; price: number }) => Promise<LSOrderResult>;
  query: (p: { exchcd: string; symbol?: string; ordDate: string; execYn?: '0' | '1' | '2' }) => Promise<LSOrderExecResult>;
  cancel: (p: { exchcd: string; symbol: string; ordNo: string; qty: number }) => Promise<{ rspCd: string; rspMsg: string }>;
  // 현금(USD) 주문가능금액 — 신용/미수/증거금 제외. 부족하면 주문 전송 금지(cash-only gate).
  cashOrderable: () => Promise<{ ok: boolean; cash: number }>;
  now: () => number;
  log: (m: string) => void;
}
export interface BuyParams { orders: OrderStore; exchcd: string; symbol: string; candleDatetime: string; qty: number; price: number; etDate: string; dailyMaxBuys: number; }
export type BuyStatus = 'placed-filled' | 'placed-pending' | 'aborted';
// abortCode: 거래 0건 사유 분류용(P0-27 req8). RECONCILIATION_FAILED 는 실제 조회 실패만(0건 정상은 여기 아님).
export type AbortCode = 'RECONCILIATION_FAILED' | 'UNRECORDED_ORDER' | 'DAILY_LIMIT' | 'PENDING' | 'DUPLICATE_CANDLE' | 'CASH_GATE' | 'ORDER_REJECTED' | 'CORRUPT' | 'SEND_EXCEPTION';
export interface BuyOutcome { status: BuyStatus; ordNo: string | null; reason: string; abortCode?: AbortCode; }

// AS0~AS4 상태추적(tracked, ordNo 키) 을 OrderStore pending 과 연결 — 종결(FILLED/CANCELLED/PFC/REJECTED)
// 이면 해당 주문번호 pending 을 해소한다(req10: AS 이벤트↔주문번호 연결 확인). 반환: 해소된 주문번호들.
export function linkTrackedToOrders(tracked: Map<string, TrackedOrder>, orders: OrderStore): string[] {
  const resolved: string[] = [];
  const TERMINAL = new Set(['FILLED', 'CANCELLED', 'PARTIALLY_FILLED_CANCELLED', 'REJECTED']);
  for (const po of orders.pending) {
    const t = tracked.get(po.ordNo);
    if (t && TERMINAL.has(t.status)) { orders.resolvePending(po.ordNo); resolved.push(po.ordNo); }
  }
  if (resolved.length) orders.flush();
  return resolved;
}

export async function executeBuyOrder(deps: TraderDeps, p: BuyParams): Promise<BuyOutcome> {
  const abort = (reason: string, abortCode?: AbortCode): BuyOutcome => ({ status: 'aborted', ordNo: null, reason, abortCode });
  // 방어적 재검증 (손상/한도/중복잠금/미체결 차단)
  if (p.orders.corrupt) return abort('주문상태 파일 손상', 'CORRUPT');
  if (!p.orders.canBuyToday(p.etDate, p.dailyMaxBuys)) return abort('하루 매수 한도 초과(로컬)', 'DAILY_LIMIT');
  if (p.orders.hasOrderedCandle(p.candleDatetime, 'buy')) return abort('동일 확정봉 이미 주문(잠금됨)', 'DUPLICATE_CANDLE');
  if (p.orders.hasPending()) return abort('미체결 주문 존재', 'PENDING');

  // ① 거래소 실제 주문내역 대사(reconciliation, req9) — 재시작/미기록 주문 감지.
  //    ⚠️ P0-27 핵심: "조회 성공 + 주문 0건" = 정상(신규 POST 가능), "조회 API 실패"(네트워크/timeout/HTTP오류) = 안전차단.
  //    둘을 절대 같은 실패로 취급하지 않는다. queryLSUSOrderExec 가 queryOk 로 구분(soft 조회).
  let chk: LSOrderExecResult;
  try { chk = await deps.query({ exchcd: p.exchcd, symbol: p.symbol, ordDate: p.etDate }); }
  catch (e) {
    // 예외 도달 = 조회 자체 실패(네트워크/timeout 등). 0건 정상 아님 → 안전차단.
    const msg = e instanceof Error ? e.message : String(e);
    deps.log(`[US-RECON ${p.symbol}] queryOk=false rsp_cd=EXCEPTION rsp_msg=${msg} ordDate=${p.etDate} exchcd=${p.exchcd} decision=RECONCILIATION_FAILED(예외)`);
    p.orders.recordResponse({ atMs: deps.now(), tr: 'COSAQ00102', rspCd: 'EXCEPTION', rspMsg: msg, ordNo: null, note: '주문전 대사 예외(조회실패)' }); p.orders.flush();
    return abort('주문내역 대사 조회 실패(예외/timeout) → 안전차단(전송 금지)', 'RECONCILIATION_FAILED');
  }
  p.orders.recordResponse({ atMs: deps.now(), tr: 'COSAQ00102', rspCd: chk.rspCd, rspMsg: chk.rspMsg, ordNo: null, note: `주문전 대사 class=${chk.classification}` });
  const actualBuys = chk.rows.filter(r => r.symbol === p.symbol && r.ordPtnCode === '02').length;
  const pendingBuys = chk.rows.filter(r => r.symbol === p.symbol && r.ordPtnCode === '02' && r.unfilledQty > 0).length;
  const localBuys = p.orders.buyCountToday(p.etDate);
  // ⚠️ P0-27a: POST 허용은 classification=SUCCESS|EMPTY 에서만. UNKNOWN/BUSINESS_ERROR/TRANSPORT_ERROR = fail-closed 차단.
  const postAllowedByQuery = chk.classification === 'SUCCESS' || chk.classification === 'EMPTY';
  const decision = !postAllowedByQuery ? `RECONCILIATION_FAILED(${chk.classification})`
    : actualBuys > localBuys ? 'UNRECORDED_ORDER(전송금지)'
    : (actualBuys >= p.dailyMaxBuys && p.dailyMaxBuys > 0) ? 'DAILY_LIMIT(전송금지)'
    : 'POST_ALLOWED';
  // req4 [US-RECON] 진단(주문 전 조회만): rsp_cd/rsp_msg/queryOk/classification/rawRows/pending/todayBuyCount/decision (+요청파라미터/조회기간/종목/HTTP/continuation)
  deps.log(`[US-RECON ${p.symbol}] rsp_cd=${chk.rspCd} rsp_msg=${chk.rspMsg} queryOk=${chk.queryOk} classification=${chk.classification} rawRows=${chk.rows.length} pending=${pendingBuys} todayBuyCount=${localBuys} actualBuys=${actualBuys} hasEnvelope=${chk.hasEnvelope} httpStatus=${chk.httpStatus ?? '-'}${chk.kind ? ` kind=${chk.kind}` : ''} ordDate=${p.etDate} exchcd=${p.exchcd} symbol=${p.symbol} trCont=${chk.diag?.trCont ?? '-'} decision=${decision}`);
  // SUCCESS/EMPTY 아니면(=unknown 업무코드/transport 실패) 전송 금지. 0건 정상만 통과.
  if (!postAllowedByQuery) { p.orders.flush(); return abort(`주문내역 대사 ${chk.classification}(rsp_cd=${chk.rspCd}${chk.kind ? ` kind=${chk.kind}` : ''}) → 안전차단(전송 금지)`, 'RECONCILIATION_FAILED'); }
  if (actualBuys > localBuys) { p.orders.flush(); return abort(`거래소 당일 매수주문 ${actualBuys} > 로컬 ${localBuys} → 미기록 주문 감지, 전송 금지(대사)`, 'UNRECORDED_ORDER'); }
  if (actualBuys >= p.dailyMaxBuys && p.dailyMaxBuys > 0) { p.orders.flush(); return abort(`거래소 당일 매수주문 ${actualBuys}(≥한도) → 전송 금지`, 'DAILY_LIMIT'); }

  // ② 현금(USD) 주문가능금액 확인 — 부족하면 절대 COSAT00301 미호출(cash-only, 신용/미수/증거금 금지 req5·6·7)
  const cash = await deps.cashOrderable();
  p.orders.recordResponse({ atMs: deps.now(), tr: 'COSOQ02701', rspCd: cash.ok ? '00000' : 'ERR', rspMsg: `현금주문가능=${cash.cash}`, ordNo: null, note: '주문가능현금' });
  if (!cash.ok) { p.orders.flush(); return abort('현금 주문가능금액 조회 실패 → 전송 금지', 'CASH_GATE'); }
  const need = p.price * p.qty;
  if (need > cash.cash) { p.orders.flush(); return abort(`주문가능현금 부족(필요 ${need} > 가능 ${cash.cash}) → 전송 금지`, 'CASH_GATE'); }

  // ③ candle lock — 전송 "직전"(응답 해석 전) 영구 잠금 + 즉시 flush. 이후 HTTP/timeout/parse/rsp_cd 오류가 나도 재주문 금지(req1·2·11·12)
  p.orders.lockCandle(p.candleDatetime, 'buy');
  p.orders.flush();

  // ④ 지정가 매수 전송. 예외(timeout/500/parse)가 나도 candle 은 이미 잠겨 재전송되지 않는다.
  let res: LSOrderResult;
  try { res = await deps.place({ exchcd: p.exchcd, symbol: p.symbol, qty: p.qty, price: p.price }); }
  catch (e) {
    p.orders.recordResponse({ atMs: deps.now(), tr: 'COSAT00301', rspCd: 'EXCEPTION', rspMsg: e instanceof Error ? e.message : String(e), ordNo: null, note: '전송 예외(candle 잠금 유지)' });
    p.orders.flush();
    return { status: 'aborted', ordNo: null, reason: '전송 예외 → candle 잠금 유지(재주문 없음). 실제 접수 여부는 다음 대사로 확인', abortCode: 'SEND_EXCEPTION' };
  }
  p.orders.recordResponse({ atMs: deps.now(), tr: 'COSAT00301', rspCd: res.rspCd, rspMsg: res.rspMsg, ordNo: res.ordNo, note: '매수전송' });

  // ⑤ 성공 판정 — OrdNo 존재 OR 성공코드(00000). (미확인 성공코드도 OrdNo 로 성공 처리, req3·4)
  if (!isUSOrderSuccess(res.rspCd, res.ordNo)) { p.orders.flush(); return { status: 'aborted', ordNo: res.ordNo ?? null, reason: `주문 거부 rsp_cd=${res.rspCd} ${res.rspMsg} (candle 잠금 유지 · 재주문 없음)`, abortCode: 'ORDER_REJECTED' }; }

  // ⑥ 주문번호 확보(응답 우선, 없으면 체결내역조회 매칭) → 즉시 저장(req4)
  const exec = await deps.query({ exchcd: p.exchcd, symbol: p.symbol, ordDate: p.etDate });
  p.orders.recordResponse({ atMs: deps.now(), tr: 'COSAQ00102', rspCd: exec.rspCd, rspMsg: exec.rspMsg, ordNo: res.ordNo, note: '체결확인' });
  let ordNo = res.ordNo;
  if (!ordNo) ordNo = exec.rows.find(r => r.symbol === p.symbol && r.ordPtnCode === '02' && r.ordQty === p.qty)?.ordNo ?? null;
  p.orders.recordPlaced('buy', p.candleDatetime, p.etDate, { ordNo: ordNo ?? '(unknown)', symbol: p.symbol, qty: p.qty, price: p.price, placedAtMs: deps.now() });
  p.orders.flush();
  deps.log(`[ORDER ${p.symbol}] 매수 전송 성공 rsp_cd=${res.rspCd} ordNo=${ordNo ?? '(미확인)'} qty=${p.qty} price=${p.price}`);

  // ⑦ 체결확인 — 전량 체결이면 즉시 해소, 아니면 pending 유지(취소는 reconcilePending 이 타임아웃 후 수행)
  const mine = ordNo ? exec.rows.find(r => r.ordNo === ordNo) ?? null : null;
  if (mine && mine.execQty >= p.qty) {
    if (ordNo) { p.orders.resolvePending(ordNo); p.orders.flush(); }
    return { status: 'placed-filled', ordNo, reason: '전량 체결' };
  }
  return { status: 'placed-pending', ordNo, reason: '미체결 → pending 유지(타임아웃 후 취소)' };
}

export type ReconcileStatus = 'filled' | 'cancelled' | 'cancel-failed' | 'manual-cancel-required' | 'waiting' | 'none';
export interface ReconcileOutcome { ordNo: string; status: ReconcileStatus; reason: string; }

// 미체결 주문을 재조회한다. 체결완료→해소.
//  - 수동취소 모드(autoCancel=false, 오늘 운영): 미체결이면 자동취소하지 않는다. pending 유지 + 수동취소 안내.
//    해소는 AS3(취소 확인) 또는 AS1(체결) 이벤트로만 이뤄진다(linkTrackedToOrders). → 다음 BUY 금지 유지(P0-2).
//  - 자동취소 모드(autoCancel=true): 타임아웃 경과 시 COSAT00311 취소(현재 코드상수로 불가).
export async function reconcilePending(
  deps: TraderDeps, p: { orders: OrderStore; exchcd: string; ordDate: string; timeoutMs: number; autoCancel: boolean },
): Promise<ReconcileOutcome[]> {
  const out: ReconcileOutcome[] = [];
  for (const po of p.orders.pending) {
    let exec: LSOrderExecResult;
    try { exec = await deps.query({ exchcd: p.exchcd, symbol: po.symbol, ordDate: p.ordDate }); }
    catch (e) { out.push({ ordNo: po.ordNo, status: 'waiting', reason: `재조회 예외(${e instanceof Error ? e.message : String(e)}) → 상태 유지(액션 없음)` }); continue; }
    p.orders.recordResponse({ atMs: deps.now(), tr: 'COSAQ00102', rspCd: exec.rspCd, rspMsg: exec.rspMsg, ordNo: po.ordNo, note: `미체결 재조회 class=${exec.classification}` });
    // SUCCESS/EMPTY 아니면 rows 를 신뢰할 수 없으므로 취소/해소하지 않고 상태 유지(fail-closed).
    if (!exec.queryOk) { out.push({ ordNo: po.ordNo, status: 'waiting', reason: `재조회 ${exec.classification}(${exec.kind ?? ''} rsp_cd=${exec.rspCd}) → 상태 유지(액션 없음)` }); continue; }
    const row = exec.rows.find(r => r.ordNo === po.ordNo) ?? null;
    if (row && row.execQty >= po.qty) {
      p.orders.resolvePending(po.ordNo); p.orders.flush();
      out.push({ ordNo: po.ordNo, status: 'filled', reason: '전량 체결' });
      continue;
    }
    // 수동취소 모드: 자동취소 금지. 미체결이면 사용자 수동취소 안내 후 pending 유지(P0-1·P0-2).
    if (!p.autoCancel) {
      deps.log(`[MANUAL-CANCEL ${po.symbol}] ordNo=${po.ordNo} 미체결 주문 발생. LS HTS/MTS에서 수동취소하십시오. (AS3 수신 전 다음 BUY 금지)`);
      out.push({ ordNo: po.ordNo, status: 'manual-cancel-required', reason: '미체결 → 수동취소 필요(자동취소 없음). AS3 수신 시 해소' });
      continue;
    }
    const ageMs = deps.now() - po.placedAtMs;
    if (ageMs < p.timeoutMs) { out.push({ ordNo: po.ordNo, status: 'waiting', reason: `미체결 ${Math.round(ageMs / 1000)}s (타임아웃 ${Math.round(p.timeoutMs / 1000)}s)` }); continue; }
    // (자동취소 모드) 타임아웃 → COSAT00311 취소
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
