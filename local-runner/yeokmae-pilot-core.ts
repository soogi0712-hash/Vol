// 역매공파 PILOT 프리플라이트 코어 (P0-35P3) — 실계정 주문 전 게이트를 '전부 실제 조회'하되 POST 는 하지 않는다.
//   pilot-live(실주문)와 pilot-preflight/--dry-run(주문 0)이 동일 게이트를 공유 → 프리뷰=실행 게이트 일치.
//   reconciliation/pending 도 실제 조회(read-only)로 채운다. 조회 실패는 fail-closed(해당 게이트 false).
import { loadUSSymbols } from './universe';
import { resolveUSQuote, type LocalLSConfig } from './ls-client';
import { OrderStore } from './order-store';
import { YeokmaePositionStore } from './yeokmae-position-store';
import { YEOKMAE_DAILY_ROOT } from './yeokmae-daily-cache';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getLSKRPrice, getLSUSPrice, getLSKRBalance, getLSUSDeposit, isCashOnly, usCashOnlyUsdCap, computeUSOrderQty,
  usOrderableQty, evaluateCrossWon, usEtSession, resolveUSExchcd,
  queryLSUSOrderExec, queryLSKROrderExecClassified, usExchcdFromMarket, LS_US_ORDEREXEC_EMPTY_CODES,
  type OrderExecClassification, type USMarketSession,
} from '../src/lib/ls-api';
import { usCrossWonVerified } from './live-config';
import {
  buildYeokmaeLiveCandidate, evaluateYeokmaePilotGate, pilotRealOrderEnabled, formatYeokmaePilotChecklist,
  DEFAULT_YEOKMAE_EXIT_CONFIG,
  YEOKMAE_PILOT_MAX_POSITIONS, type YeokmaeLiveCandidate, type YeokmaeSignalType, type YeokmaePilotGateInput,
} from '../src/lib/yeokmae';

export const SIGNAL_KEYS: YeokmaeSignalType[] = ['112_ORIGINAL', '224_ORIGINAL', '112_UPGRADE', '224_UPGRADE', 'LONG_TERM'];
export const marketDate = (tzOffsetH: number): string => { const d = new Date(Date.now() + tzOffsetH * 3600_000); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; };

// US 대사 성공 판정(순수, 테스트용) — SUCCESS/EMPTY 만 POST 허용.
export function pilotReconOkUS(cls: OrderExecClassification): boolean { return cls === 'SUCCESS' || cls === 'EMPTY'; }

// 대사 진단 상세(0건 정상 vs API 실패 구분용) — [KR/US-PILOT-RECON-DIAG] 로 출력.
export interface ReconDiag {
  tr: string; rspCd: string; rspMsg: string; httpStatus: number | null; hasEnvelope: boolean;
  todayBuy: number; pendingRows: number; classification: OrderExecClassification; reconciliationOk: boolean; failureReason: string;
}
// US 심볼/거래소 resolve 진단(P0-35US2) — 검증된 signal metadata 재사용 vs static universe 교차검증.
export interface UsSymbolDiag {
  candidateSymbol: string; storedExchange: string; storedExchcd: string;
  universeFound: boolean; universeExchange: string; resolved: string; failureReason: string;
}
// US orderableQty 근본원인 진단(P0-35US3) — 어떤 TR/필드로 산정했는지·budget/orderable/final 분리·세션.
//   ⚠️ 예산부족(budgetQty=0)과 broker 주문가능0(orderableQty=0)을 같은 이유로 표시하지 않는다(failureReason 로 구분).
//   orderableQty 산정은 ls-usws(검증된 AAPL 매수경로)와 동일: Math.max(crossWon.programQty, qtyCountry).
export interface UsOrderableDiag {
  tr: string; rspCd: string; rspMsg: string;          // COSOQ02701(예수금) 실 응답코드
  exchange: string; symbol: string;
  etTime: string; session: USMarketSession;           // ET 시각/세션(장전이라 0 오해 배제용 — orderableQty 는 세션 무관)
  usdCash: number; usdOrderable: number; usdPrexchOrderable: number;   // FcurrDps / FcurrOrdAbleAmt / PrexchOrdAbleAmt(원자료)
  krwCash: number; krwCashMin: number; baseXchRate: number;            // WonDpsBalAmt / min(WonDpsBalAmt,MnyoutAbleAmt) / BaseXchrat
  cashOnly: boolean; overseasMargin: number; loanAmt: number;
  cashOnlyUsdCap: number;                              // 순수 USD현금 명목상한(참고)
  qtyCountry: number; qtyCrossWon: number;            // 거래국가 USD현금 주수 / 선환전(참고)
  crossWonProgramQty: number; crossWonAdoptedField: string; crossWonVerified: boolean;   // 통합증거금(WonCashMin) 주수
  budgetQty: number; orderableQty: number; finalQty: number;   // ⚠️ 3개 분리(예산 게이트 vs 주문가능 게이트 vs 최종)
  failureReason: string;
}

// 실제 값 체크리스트 + 게이트 로그(pilot-live / pilot-preflight 공통).
export function logPilotPreflight(log: (m: string) => void, pf: PilotPreflight): void {
  if (pf.symbolDiag) {
    const d = pf.symbolDiag;
    log(`[US-PILOT-SYMBOL-DIAG] candidateSymbol=${d.candidateSymbol} storedExchange=${d.storedExchange} storedExchcd=${d.storedExchcd} universeFound=${d.universeFound} universeExchange=${d.universeExchange} resolved=${d.resolved} failureReason=${d.failureReason}`);
  }
  if (!pf.ok) { log(`[YEOKMAE-PILOT-PREFLIGHT] FAIL_CLOSED(${pf.failReason}) → 주문 없음.`); return; }
  if (pf.gateInput) {
    log(formatYeokmaePilotChecklist(pf.gateInput, { strategyTag: 'YEOKMAE', orderBudgetUSD: pf.budgetUSD, calcQty: pf.qty, committedKRW: pf.committedKRW, remainingKRW: pf.remainingKRW, sellPolicyArmed: true, exitConfig: DEFAULT_YEOKMAE_EXIT_CONFIG }));
  }
  // US orderableQty 근본원인 진단(P0-35US3) — budgetQty/orderableQty/finalQty 분리 + 세션 + 실 예수금 원자료.
  if (pf.orderableDiag) {
    const d = pf.orderableDiag;
    log(`[US-PILOT-ORDERABLE-DIAG] tr=${d.tr} rsp_cd=${d.rspCd} rsp_msg=${d.rspMsg} exchange=${d.exchange} symbol=${d.symbol} session=${d.session} etTime=${d.etTime}`);
    log(`  cash: usdCash=${d.usdCash} usdOrderable(FcurrOrdAbleAmt)=${d.usdOrderable} usdPrexchOrderable(PrexchOrdAbleAmt)=${d.usdPrexchOrderable} krwCash(WonDpsBalAmt)=${d.krwCash} krwCashMin=${d.krwCashMin} baseXchRate=${d.baseXchRate}`);
    log(`  cashOnly=${d.cashOnly}(OvrsMgn=${d.overseasMargin} LoanAmt=${d.loanAmt}) cashOnlyUsdCap=${d.cashOnlyUsdCap.toFixed(2)} crossWonAdoptedField=${d.crossWonAdoptedField} crossWonVerified=${d.crossWonVerified}`);
    log(`  qtyCountry(USD현금)=${d.qtyCountry} qtyCrossWon(선환전·참고)=${d.qtyCrossWon} crossWonProgramQty(WonCashMin)=${d.crossWonProgramQty}`);
    log(`  ⇒ budgetQty=${d.budgetQty} orderableQty=${d.orderableQty} finalQty=${d.finalQty} failureReason=${d.failureReason}`);
  }
  // 대사 진단 — '0건 정상' vs 'API 실패' 구분(추측 금지). 실 rsp_cd 노출.
  if (pf.reconDiag) {
    const d = pf.reconDiag;
    log(`[${pf.market}-PILOT-RECON-DIAG] tr=${d.tr} rsp_cd=${d.rspCd} rsp_msg=${d.rspMsg} httpStatus=${d.httpStatus ?? '-'} envelope=${d.hasEnvelope}`
      + ` todayBuy=${d.todayBuy} pendingRows=${d.pendingRows} classification=${d.classification} reconciliationOk=${d.reconciliationOk} failureReason=${d.failureReason}`);
  }
  // 실제 조회값(요구: 전부 실제 값 출력)
  log(`[YEOKMAE-PILOT-PREFLIGHT-VALUES] cashOnly=${pf.cashOnly} orderableQty=${pf.orderable} capitalGuardOk=${pf.capitalGuardOk} perSymbolBudgetOk=${pf.perSymbolBudgetOk}`
    + ` pending=${!pf.noPending}(exchPendingBuys=${pf.exchangePendingBuys}) reconciliationOk=${pf.reconciliationOk} duplicateSymbolDate=${!pf.notDuplicateOrder}`
    + ` currentYeokmaePositions=${pf.currentYeokmaePositions}/${1} currentPrice=${pf.price} calculatedQty=${pf.qty} orderAmount=${pf.orderAmount.toFixed(2)}`);
  log(`[YEOKMAE-PILOT-CAPITAL] totalCapitalKRW=${Math.round(pf.totalCapitalKRW)} committedKRW=${Math.round(pf.committedKRW)} remainingKRW=${Math.round(pf.remainingKRW)} baseXchRate=${pf.baseXchRate} perTradeBudgetUSD=${pf.budgetUSD}`);
  log(`[YEOKMAE-PILOT-LIVE-GATE] gateAllowed=${pf.gateAllowed} gateReasons=[${pf.gateReasons.join(',')}] PILOT_REAL_ORDER_ENABLED=${pf.realOrderEnabled} blockers=[${pf.realOrderReasons.join(',')}]`);
}

export interface PilotPreflight {
  ok: boolean; failReason?: string;
  market: 'KR' | 'US'; candidate: YeokmaeLiveCandidate | null; exchcd: string;
  price: number; orderable: number; qty: number; orderAmount: number; budgetUSD: number;
  committedKRW: number; remainingKRW: number; totalCapitalKRW: number; baseXchRate: number;
  cashOnly: boolean; capitalGuardOk: boolean; perSymbolBudgetOk: boolean;
  noPending: boolean; reconciliationOk: boolean; notDuplicateOrder: boolean;
  exchangePendingBuys: number; currentYeokmaePositions: number;
  reconDiag: ReconDiag | null;
  symbolDiag: UsSymbolDiag | null;
  orderableDiag: UsOrderableDiag | null;
  gateInput: YeokmaePilotGateInput | null; gateAllowed: boolean; gateReasons: string[];
  realOrderEnabled: boolean; realOrderReasons: string[];
  // 실행 핸들(pilot-live 가 POST 진행 시 사용)
  cfg: LocalLSConfig; token: string; orders: OrderStore | null; posStore: YeokmaePositionStore; etDate: string; delaygb: string;
}

// 모든 게이트를 실제 조회로 채운다(POST 없음). scrub 로 민감정보 마스킹.
export async function pilotPreflight(
  cfg: LocalLSConfig, token: string, market: 'KR' | 'US',
  env: { liveTrading: boolean; yeokmaeLive: boolean; pilotLive: boolean; legacyBbBlocked: boolean; budgetUSD: number; totalCapitalKRW: number },
  scrub: (s: string) => string,
): Promise<PilotPreflight> {
  const posStore = new YeokmaePositionStore(); posStore.load();
  const base: PilotPreflight = {
    ok: false, market, candidate: null, exchcd: '', price: 0, orderable: 0, qty: 0, orderAmount: 0, budgetUSD: env.budgetUSD,
    committedKRW: 0, remainingKRW: env.totalCapitalKRW, totalCapitalKRW: env.totalCapitalKRW, baseXchRate: 1,
    cashOnly: false, capitalGuardOk: false, perSymbolBudgetOk: false, noPending: false, reconciliationOk: false, notDuplicateOrder: false,
    exchangePendingBuys: 0, currentYeokmaePositions: posStore.corrupt ? -1 : posStore.all().length,
    reconDiag: null, symbolDiag: null, orderableDiag: null,
    gateInput: null, gateAllowed: false, gateReasons: [], realOrderEnabled: false, realOrderReasons: [],
    cfg, token, orders: null, posStore, etDate: market === 'US' ? marketDate(-5) : marketDate(9), delaygb: 'R',
  };
  const failClosed = (reason: string): PilotPreflight => ({ ...base, ok: false, failReason: reason });

  if (posStore.corrupt) return failClosed('YEOKMAE 포지션 파일 손상(strategyTag 불명)');

  // 신호 파일 → 후보
  const file = join(YEOKMAE_DAILY_ROOT, `${market}.real-signals.json`);
  if (!existsSync(file)) return failClosed(`신호 파일 없음: ${file}`);
  let signals: any[] = [];
  try { signals = JSON.parse(readFileSync(file, 'utf8')).signals ?? []; } catch { return failClosed('신호 파일 파싱 실패'); }
  const first = signals.find(s => SIGNAL_KEYS.some(k => s[k] === true));
  if (!first) return failClosed('confirmed 5신호 ON 종목 없음');
  const matchedSignals = SIGNAL_KEYS.filter(k => first[k] === true);
  const candidate = buildYeokmaeLiveCandidate({ symbol: first.symbol, exchange: first.exchange, confirmedDate: first.confirmedDate, matchedSignals, isProvisional: false, searcherFormula: !!first.searcherFormula, verifiedFailed: first.verifiedFailed ?? [], unverifiedExternal: first.unverified ?? ['A', 'B', 'C', 'T'] });
  if (!candidate) return failClosed('후보 생성 실패(confirmed 화살표 아님)');
  base.candidate = candidate;

  // 주문상태
  const orders = new OrderStore(`YEOKMAE_${market}_${candidate.symbol}`); orders.load();
  if (orders.corrupt) return failClosed('주문상태 파일 손상');
  base.orders = orders;
  const notDuplicateOrder = !orders.hasOrderedCandle(candidate.confirmedDate, 'buy');
  const localNoPending = !orders.hasPending();

  // 시세 + cash + 수량 + reconciliation(실제 조회). reconDiag 로 '0건 정상' vs 'API 실패' 구분.
  let price = 0, orderable = 0, qty = 0, budgetQty = 0, cashOnly = false, exchcd = '', delaygb = 'R';
  let reconciliationOk = false, exchangePendingBuys = 0;
  let reconDiag: ReconDiag | null = null;
  let orderableDiag: UsOrderableDiag | null = null;
  let baseXchRate = 1;   // KR=원화(1). US=LS 기준환율(예수금 조회에서).
  if (market === 'US') {
    const symUpper = candidate.symbol.toUpperCase();
    // ── US 심볼 resolve — 검증된 signal metadata(수집시 g3190) 우선 재사용, static universe 는 교차검증만(item 4·5) ──
    //   P0-35US7: 공통 resolveUSExchcd 로 통일(지속러너 복원과 동일 규칙).
    const storedExchange = String(first.exchange ?? '');   // 'NASDAQ'|'NYSE_AMEX'|'ETC'
    const storedExchcd = first.exchcd ? String(first.exchcd) : '';
    const uni = loadUSSymbols(); const universeSym = uni.ok.find(s => s.symbol === symUpper);
    const res = resolveUSExchcd({ storedExchcd, storedExchange, universeExchcd: universeSym?.exchcd ?? null });
    const resolvedExchcd = res.exchcd; const failureReason = res.failureReason;
    const symbolDiag: UsSymbolDiag = {
      candidateSymbol: candidate.symbol, storedExchange: storedExchange || '(없음)',
      storedExchcd: (storedExchcd || (usExchcdFromMarket(storedExchange) ?? '')) || '(없음)',
      universeFound: !!universeSym, universeExchange: universeSym?.exchange ?? '-', resolved: resolvedExchcd || 'FAIL', failureReason: failureReason || '-',
    };
    base.symbolDiag = symbolDiag;
    if (!resolvedExchcd) return { ...failClosed(`US 종목 exchcd 미해결: ${candidate.symbol} (${failureReason})`), symbolDiag };
    exchcd = resolvedExchcd; delaygb = resolveUSQuote().delaygb ?? 'R';
    try { price = (await getLSUSPrice(cfg, token, symUpper, exchcd, delaygb)).price; } catch (e) { return { ...failClosed(`US 시세 조회 실패: ${scrub(String(e))}`), symbolDiag }; }
    let dep; try { dep = await getLSUSDeposit(cfg, token); } catch (e) { return { ...failClosed(`US 예수금 조회 실패: ${scrub(String(e))}`), symbolDiag }; }
    if (!dep.ok) return { ...failClosed('US 예수금 조회 실패(ok=false)'), symbolDiag };
    cashOnly = isCashOnly(dep);
    baseXchRate = dep.baseXchRate > 0 ? dep.baseXchRate : 0;   // 총자본(원) 한도 환산용
    // ── P0-35US3/US5 근본수정: orderableQty 를 executor(pilot-live cashOrderable)와 '동일 식'으로 산정 ──
    //   기존 PILOT: usCashOnlyUsdCap(dep,{})/price = 순수 USD현금(FcurrOrdAbleAmt)만 → USD현금 0(원화보유) 계좌에서 항상 0.
    //   통일 후: orderable = floor( usCashOnlyUsdCap(dep,{crossWonVerified}) / price ). executor CASH_GATE 상한과
    //   완전히 같은 근거(usCashOnlyUsdCap) → 구성상 parity 보장: price*finalQty ≤ cap ⇒ CASH_GATE 절대 되막지 않음.
    //   cashOnly(미수/대출 0)·crossWonVerified 판정이 usCashOnlyUsdCap 안에 포함되어 margin/대출 계좌는 자동 0.
    //   crossWonVerified=true 면 통합증거금(WonCashMin 원화현금) USD환산 포함, false 면 순수 USD현금만.
    const crossWonVerified = usCrossWonVerified();
    const cashOnlyUsdCap = usCashOnlyUsdCap(dep, { crossWonVerified });
    const crossWon = evaluateCrossWon(dep, price, null);   // 진단표시용(programQty/reason)
    const { qtyCountry, qtyCrossWon } = usOrderableQty(dep, price);   // 진단표시용(거래국가/선환전 수량)
    orderable = price > 0 ? Math.floor(cashOnlyUsdCap / price) : 0;
    const qtyDec = computeUSOrderQty({ perTradeBudgetUsd: env.budgetUSD, orderableQty: orderable, bestAsk: price, maxQty: null });
    budgetQty = qtyDec.budgetQty;   // 예산 게이트(perSymbolBudgetOk) 근거 — orderable 과 독립
    qty = qtyDec.finalQty;          // = min(orderable, budgetQty)
    // ── [US-PILOT-ORDERABLE-DIAG] 근본원인 진단 — 예산부족 vs broker주문가능0 구분(추측 없음, 실 응답값) ──
    const krwCashMin = Math.min(dep.krwCash, dep.krwWithdrawable);
    const et = usEtSession(new Date());
    let orderableFailure: string;
    if (orderable >= 1 && budgetQty >= 1) orderableFailure = '-';   // 주문가능·예산 모두 충분 → orderableQty 는 blocker 아님
    else if (orderable >= 1 && budgetQty < 1) orderableFailure = `BUDGET_TOO_SMALL(예산 $${env.budgetUSD} < 1주 $${price.toFixed(2)} — 자본부족 아님, 예산 상향 필요)`;
    else if (!cashOnly) orderableFailure = `NOT_CASH_ONLY(OvrsMgn=${dep.overseasMargin} LoanAmt=${dep.loanAmt} — 미수/대출 계좌는 주문 금지)`;
    else if (dep.usdCash <= 0 && krwCashMin <= 0) orderableFailure = 'CAPITAL_INSUFFICIENT(usdCash=0 · krwCash=0 — 실입금 필요, broker 잔액 자체가 0)';
    else if (qtyCountry < 1 && crossWon.programQty < 1) orderableFailure = `ORDERABLE_QTY_0(현금 있으나 1주 미만: usdOrderable=${dep.usdOrderable} krwCashMin=${krwCashMin} price=${price.toFixed(2)} crossWonReason=${crossWon.reason})`;
    else orderableFailure = `ORDERABLE_QTY_0(qtyCountry=${qtyCountry} crossWonProgramQty=${crossWon.programQty})`;
    if (et.session !== 'REGULAR' && et.session !== 'AFTER_HOURS' && et.session !== 'PRE_MARKET') {
      orderableFailure = `${orderableFailure} · [SESSION_NOT_ORDERABLE_YET] ${et.session}@${et.etTime}(단, orderableQty 는 예수금 기반이라 세션 무관)`;
    }
    orderableDiag = {
      tr: 'COSOQ02701', rspCd: dep.rspCd, rspMsg: scrub(dep.rspMsg),
      exchange: storedExchange || '-', symbol: symUpper,
      etTime: et.etTime, session: et.session,
      usdCash: dep.usdCash, usdOrderable: dep.usdOrderable, usdPrexchOrderable: dep.usdPrexchOrderable,
      krwCash: dep.krwCash, krwCashMin, baseXchRate: dep.baseXchRate,
      cashOnly, overseasMargin: dep.overseasMargin, loanAmt: dep.loanAmt,
      cashOnlyUsdCap,   // executor CASH_GATE 상한과 동일값(parity 근거)
      qtyCountry, qtyCrossWon, crossWonProgramQty: crossWon.programQty,
      crossWonAdoptedField: crossWon.adoptedField ?? '(미채택)', crossWonVerified,
      budgetQty, orderableQty: orderable, finalQty: qty, failureReason: orderableFailure,
    };
    base.orderableDiag = orderableDiag;
    try {
      const rec = await queryLSUSOrderExec(cfg, token, { exchcd, symbol: symUpper, ordDate: base.etDate }, { emptyCodes: LS_US_ORDEREXEC_EMPTY_CODES });
      reconciliationOk = pilotReconOkUS(rec.classification);
      const todayBuy = rec.rows.filter(r => r.symbol === symUpper && r.ordPtnCode === '02').length;
      exchangePendingBuys = rec.rows.filter(r => r.symbol === symUpper && r.ordPtnCode === '02' && r.unfilledQty > 0).length;
      reconDiag = { tr: 'COSAQ00102', rspCd: rec.rspCd, rspMsg: rec.rspMsg, httpStatus: rec.httpStatus ?? null, hasEnvelope: rec.hasEnvelope, todayBuy, pendingRows: exchangePendingBuys, classification: rec.classification, reconciliationOk, failureReason: reconciliationOk ? '-' : `classification=${rec.classification}` };
    } catch (e) { return failClosed(`US 대사 조회 실패: ${scrub(String(e))}`); }
  } else {
    exchcd = 'KR';
    try { price = (await getLSKRPrice(cfg, token, candidate.symbol)).price; } catch (e) { return failClosed(`KR 시세 조회 실패: ${scrub(String(e))}`); }
    let bal; try { bal = await getLSKRBalance(cfg, token); } catch (e) { return failClosed(`KR 잔고 조회 실패: ${scrub(String(e))}`); }
    cashOnly = bal.orderableCash > 0;
    orderable = price > 0 ? Math.floor(bal.orderableCash / price) : 0;
    qty = Math.max(0, Math.min(1, orderable));   // 기존 KR 규칙(maxQty=1) + 결제가능 확인
    budgetQty = orderable;   // KR 은 예산 개념 없음 → orderable 로 게이트 동치 유지(budgetQty>=1 ⇔ 기존 qty>=1)
    // P0-35P4: 분류형 대사(soft) — raw rsp_cd 를 잡아 SUCCESS/EMPTY/BUSINESS_ERROR/TRANSPORT_ERROR 구분(추측 금지).
    const rec = await queryLSKROrderExecClassified(cfg, token, { shcode: candidate.symbol, ordDate: base.etDate, bnsTpCode: '2' });
    reconciliationOk = rec.queryOk;   // SUCCESS/EMPTY 만 통과. 미확정 업무코드/transport = fail-closed.
    exchangePendingBuys = (rec.buyOrdQty - rec.buyExecQty) > 0 ? 1 : 0;
    reconDiag = {
      tr: 'CSPAQ13700', rspCd: rec.rspCd, rspMsg: rec.rspMsg, httpStatus: rec.httpStatus, hasEnvelope: rec.hasEnvelope,
      todayBuy: rec.buyOrdQty, pendingRows: exchangePendingBuys, classification: rec.classification, reconciliationOk,
      failureReason: reconciliationOk ? '-' : (rec.classification === 'BUSINESS_ERROR'
        ? `미확정 업무코드 rsp_cd=${rec.rspCd}(정상0건인지 실측 확인 후 등록 필요 — 추측 금지)`
        : `${rec.classification} rsp_cd=${rec.rspCd}${rec.kind ? ` kind=${rec.kind}` : ''}`),
    };
  }
  if (!(price > 0)) return failClosed('실시간가 미확보(quote stale) → 손절/익절 오발동 방지 위해 주문 금지');

  const noPending = localNoPending && exchangePendingBuys === 0;
  // 총자본 100만원(원) 한도 — PILOT 은 포지션 0개에서만 진행하므로 committed=이번 주문. US 는 환율로 원화 환산.
  const totalCapitalKRW = env.totalCapitalKRW;
  const committedKRW = market === 'US' ? qty * price * baseXchRate : qty * price;
  const remainingKRW = totalCapitalKRW - committedKRW;
  const xchOk = market === 'US' ? baseXchRate > 0 : true;   // US 는 환율 확보돼야 원화한도 판정 가능
  // P0-35US3: 예산 게이트와 주문가능/자본 게이트 분리 — budgetQty/orderable/finalQty 를 서로 다른 이유로 판정.
  //   perSymbolBudgetOk = 1회 예산으로 ≥1주(budgetQty>=1) — '자본부족'이 아닌 '예산 상한' 관점.
  //   capitalGuardOk   = 최종수량 ≥1주(finalQty>=1, broker 주문가능+예산 결합) AND cash-only AND 총자본 한도 내.
  const perSymbolBudgetOk = budgetQty >= 1;
  const capitalGuardOk = qty >= 1 && cashOnly && xchOk && committedKRW > 0 && committedKRW <= totalCapitalKRW;
  const currentYeokmaePositions = posStore.all().length;

  const gateInput: YeokmaePilotGateInput = {
    candidate, liveTrading: env.liveTrading, yeokmaeLive: env.yeokmaeLive, pilotLive: env.pilotLive, legacyBbBlocked: env.legacyBbBlocked,
    cashOnly, capitalGuardOk, perSymbolBudgetOk, noPending, reconciliationOk, notDuplicateOrder,
    currentYeokmaePositions, maxPilotPositions: YEOKMAE_PILOT_MAX_POSITIONS,
  };
  const gate = evaluateYeokmaePilotGate(gateInput);
  const rl = pilotRealOrderEnabled({ liveTrading: env.liveTrading, yeokmaeLive: env.yeokmaeLive, pilotLive: env.pilotLive, gateAllowed: gate.allowed, currentYeokmaePositions });

  return {
    ...base, ok: true, exchcd, price, orderable, qty, orderAmount: qty * price, delaygb,
    committedKRW, remainingKRW, totalCapitalKRW, baseXchRate,
    cashOnly, capitalGuardOk, perSymbolBudgetOk, noPending, reconciliationOk, notDuplicateOrder, exchangePendingBuys, currentYeokmaePositions,
    reconDiag, symbolDiag: base.symbolDiag, orderableDiag,
    gateInput, gateAllowed: gate.allowed, gateReasons: gate.reasons, realOrderEnabled: rl.enabled, realOrderReasons: rl.reasons,
    orders,
  };
}
