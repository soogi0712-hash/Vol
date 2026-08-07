// LS 해외 실시간(WebSocket GSC/GSH) 관찰 러너 — 실행: npm run ls:usws
// GSC(체결)로 실시간 15분봉 생성 + 로컬 영구 저장/복원, GSH(호가)로 지정가 재료 수집.
// 지속 실행형: Ctrl+C(SIGINT) 까지 계속 돈다. 확정봉은 즉시 디스크에 저장, 재시작 시 복원.
// ⚠️ 주문 없음(관찰 전용). LS_LIVE_TRADING 과 무관하게 주문 함수는 호출하지 않는다(Phase 3 금지).
import { loadEnvLocal } from './env';
import { createLogger, type Logger } from './logger';
import { loadConfig, getTokenCached, resolveUSQuote, type LocalLSConfig } from './ls-client';
import { loadUSSymbols } from './universe';
import { makeScrubber } from './mask';
import {
  getLSUS15MinPaged, getLSUSTicksPaged, getLSUSDeposit,
  placeLSUSBuyOrder, queryLSUSOrderExec, cancelLSUSOrder, LSApiError,
  decideUSCashPayment, usCashOnlyUsdCap, usOrderableQty, formatCashOrderableLine,
  evaluateCrossWon, formatCrossWonCheck, formatCrossWonLiveCand, LS_US_CROSS_WON_TR_CONFIRMED, type LSUSDeposit,
} from '../src/lib/ls-api';
import {
  LSUSRealtimeClient, RealtimeCandleBuilder, buildWsTrKey, evaluateReadiness, MIN_RT_CANDLES,
  aggregateTicksTo15Min, type RTCandle,
} from './ls-us-websocket';
import { CandleStore, type StoredCandle } from './candle-store';
import { OrderStore } from './order-store';
import { parseAccountEvent, applyOrderEvent } from './order-events';
import { evaluateTradeGate, canExecuteLive, etDateStr, isUSRegularSession, type GateState } from './trade-gate';
import { executeBuyOrder, reconcilePending, linkTrackedToOrders, type TraderDeps } from './trader';
import { loadLiveConfig, isLiveSymbol, type LiveConfig } from './live-config';
import { computeUSP0Checklist, formatUSP0Checklist } from './us-live-checklist';
import { calcBB, calcRSI, getBBSignal, validateCandleData } from '../src/lib/bollinger';

function kstYmd(offsetDays = 0): string {
  const k = new Date(Date.now() + 9 * 3600 * 1000 - offsetDays * 86400_000);
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, '0')}${String(k.getUTCDate()).padStart(2, '0')}`;
}

const toStored = (c: RTCandle): StoredCandle => ({ datetime: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });

interface SymCtx {
  symbol: string;
  exchange: string;
  exchcd: string;
  builder: RealtimeCandleBuilder;
  store: CandleStore;
  orders: OrderStore;
  lastGSCat: number | null;
  lastGSHat: number | null;
  lastPrice: number;
  bestBid: number;
  bestAsk: number;
  crossWonLiveDone: boolean;   // 최초 유효 bestAsk>0 수신 후 CROSS-WON 실계정 후보 1회 재계산 완료 여부(P0-19)
}

// Warm-up/관찰 신호 계산 — 확정봉으로 BB(20,2)/RSI(14)/getBBSignal 을 **항상** 계산한다(형성봉 제외).
//   - Warm-up(확정봉<20): [WARMUP] 로그로 remaining 과 함께 계속 계산(가짜봉으로 채우지 않음, req 2·6·7).
//   - READY(확정봉==20 순간 자동): [OBSERVE] 로그. 확정봉 부족으로 BB 미산출이면 signal=NONE.
// 신호 action + 기준 최신 확정봉 datetime 반환(게이트 dedup 키). 확정봉 0개면 null.
function observeSignal(log: Logger, ctx: SymCtx, warmup: boolean, remaining: number): { action: string; candleDatetime: string } | null {
  const confirmed = ctx.builder.confirmedCandles();   // 확정봉만(형성봉 제외)
  if (confirmed.length === 0) return null;
  const closes = confirmed.map(c => c.close);
  const dts = confirmed.map(c => c.datetime);
  const rsi = calcRSI(closes, 14);
  const bands = calcBB(closes, dts, 20, 2);
  const sig = getBBSignal(bands, false, false, rsi);   // 관찰: 보유/상단돌파 상태 없음
  const rsiLast = rsi.at(-1);
  if (warmup) {
    log.info(`[WARMUP US:${ctx.exchange}:${ctx.symbol}] 확정봉=${confirmed.length}/${MIN_RT_CANDLES} remaining=${remaining} rsi=${Number.isFinite(rsiLast) ? rsiLast!.toFixed(1) : '-'} signal=${sig.action}(${sig.reason}) — 20개까지 계산 대기(가짜봉 없음)`);
    return { action: sig.action, candleDatetime: dts[dts.length - 1] };
  }
  const qv = validateCandleData(closes, MIN_RT_CANDLES, 20, 0.001);
  if (!qv.valid) { log.warn(`[US:${ctx.symbol}] 신호검증 스킵 — ${qv.reason} (${qv.detail})`); return null; }
  // ⚠️ 신호가 BUY/SELL 이어도 주문 함수는 호출하지 않는다 — 로그만.
  log.info(`[OBSERVE US:${ctx.exchange}:${ctx.symbol}] signal=${sig.action} reason=${sig.reason} 확정봉=${confirmed.length} 현재가=${ctx.lastPrice || '-'} rsi=${Number.isFinite(rsiLast) ? rsiLast!.toFixed(1) : '-'} (주문 없음)`);
  return { action: sig.action, candleDatetime: dts[dts.length - 1] };
}

async function main() {
  loadEnvLocal();
  const log = createLogger('ls-usws');
  log.info('===== LS 해외 실시간(WebSocket GSC/GSH) — 지속 실행형 · ARMED 감시(주문 없음) =====');

  let cfg: LocalLSConfig;
  try { cfg = loadConfig(); } catch (e) { log.error(String(e)); process.exit(1); return; }

  const scrub0 = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); }
  catch (e) { log.error(`토큰 실패: ${scrub0(String(e))}`); process.exit(1); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret, token, cfg.accountNo]);

  const us = loadUSSymbols();
  for (const u of us.unsupported) log.warn(`[US:${u.token}] UNSUPPORTED_EXCHANGE(${u.exchange}) 스킵(추측 금지)`);
  if (!us.ok.length) { log.error('관찰 US 종목 없음 (LS_US_SYMBOLS 확인)'); process.exit(1); return; }

  const ctxs = new Map<string, SymCtx>();
  const quote = resolveUSQuote();
  const sdate = kstYmd(10);

  // ── 시작 시: 저장된 확정봉 복원 → REST g3203 시드 병합(실패해도 진행) ──
  for (const s of us.ok) {
    const store = new CandleStore(s.symbol);
    store.load();
    const orders = new OrderStore(s.symbol);
    orders.load();
    if (orders.corrupt) log.error(`[US:${s.symbol}] 주문상태 파일 손상 → 실주문 차단 유지. 파일: ${orders.file}`);
    const builder = new RealtimeCandleBuilder();
    const ctx: SymCtx = { symbol: s.symbol, exchange: s.exchange, exchcd: s.exchcd, builder, store, orders, lastGSCat: null, lastGSHat: null, lastPrice: 0, bestBid: 0, bestAsk: 0, crossWonLiveDone: false };
    ctxs.set(s.symbol, ctx);

    const trKey = buildWsTrKey(s.exchcd, s.symbol);
    log.info(`[US:${s.symbol}] exchcd=${s.exchcd} trKeyLength=${trKey.length} trKey='${trKey}'`);

    if (store.corrupt) {
      log.error(`[US:${s.symbol}] 저장 파일 손상 감지 → 신규매수 금지, 실시간 재수집만(저장은 중단). 파일: ${store.file}`);
    } else {
      const stored = store.confirmedSorted();
      builder.seed(stored.map(c => ({ ...c })));   // 저장된 확정봉 복원(≥60 유지 대상)
      log.info(`[US:${s.symbol}] 저장 확정봉 복원 ${stored.length}개`);
    }

    // REST 초기 시드(가능 시). 비압축(comp_yn=N, qrycnt=5) 연속조회로 최신 60 확정봉 확보(req 2·4).
    // 실패는 WebSocket 을 막지 않는다(req 5).
    if (quote.delaygb) {
      try {
        const r = await getLSUS15MinPaged(cfg, token, s.symbol, s.exchcd, quote.delaygb, { target: 60, maxCalls: 12, ncnt: 15, sdate });
        // 저장 확정봉 + REST 확정봉을 timestamp 로 병합/중복제거. 형성봉은 제외됨(paged 가 최신 1개 제외).
        builder.seed(r.candles.map(c => ({ datetime: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })));
        const lastPage = r.last;
        log.info(`[US:${s.symbol}] REST g3203 연속조회 ${r.calls}회 → 확정봉 ${r.candles.length}개 (rsp_cd='${lastPage.rspCd}') → 병합 후 확정봉=${builder.confirmedCount}`);
        if (r.candles.length === 0) {
          // req 6: 빈 응답 진단 — qrycnt / comp_yn / ncnt / tr_cont / tr_cont_key 반드시 출력
          const ib = (lastPage.reqBody as any).g3203InBlock ?? {};
          log.warn(`[US:${s.symbol}] g3203 빈 응답 진단 — qrycnt=${ib.qrycnt} comp_yn=${ib.comp_yn} ncnt=${ib.ncnt}`
            + ` 요청tr_cont=${lastPage.diag.reqHeaders.tr_cont} 요청tr_cont_key='${lastPage.diag.reqHeaders.tr_cont_key}'`
            + ` 응답tr_cont=${lastPage.resTrCont} 응답tr_cont_key='${lastPage.resTrContKey}' rec_count=${lastPage.recCount} rawCount=${lastPage.rawCount}`);
          // ── fallback: g3202(과거 틱) → 15분 재집계 (공식 TR). 실패/빈응답이면 WS 누적으로만 진행 ──
          try {
            const tp = await getLSUSTicksPaged(cfg, token, s.symbol, s.exchcd, quote.delaygb, { target: 21, maxCalls: 40, ncnt: 5, sdate });
            const bars = aggregateTicksTo15Min(tp.ticks.map(t => ({ datetime: t.datetime, open: t.open, high: t.high, low: t.low, close: t.close, volume: t.volume })));
            if (bars.length > 0) {
              builder.seed(bars);
              if (!store.corrupt) { let d = false; for (const c of builder.confirmedCandles()) if (store.upsertConfirmed(toStored(c))) d = true; if (d) store.flush(); }
              log.info(`[US:${s.symbol}] g3202 틱 fallback ${tp.calls}회 · 틱 ${tp.ticks.length}개 → 15분 확정봉 ${bars.length}개 (병합 후 확정봉=${builder.confirmedCount})`);
            } else {
              const tl = tp.last;
              const tib = (tl.reqBody as any).g3202InBlock ?? {};
              log.warn(`[US:${s.symbol}] g3202 틱 fallback 도 빈 응답 — ${tp.calls}회 · qrycnt=${tib.qrycnt} comp_yn=${tib.comp_yn} ncnt=${tib.ncnt} rsp_cd='${tl.rspCd}' rawCount=${tl.rawCount} rec_count=${tl.recCount} 응답tr_cont=${tl.resTrCont} → WS 누적으로만 진행`);
            }
          } catch (e) { log.warn(`[US:${s.symbol}] g3202 틱 fallback 실패(무시, WS 로 진행): ${scrub(String(e))}`); }
        }
        // REST 로 확보된 확정봉을 저장(손상 아니면). 형성봉은 아직 없음(GSC 전).
        if (!store.corrupt) {
          let dirty = false;
          for (const c of builder.confirmedCandles()) if (store.upsertConfirmed(toStored(c))) dirty = true;
          if (dirty) store.flush();
        }
        // confirmed>=20 이면 즉시 READY 평가 가능(이후 WebSocket GSC/GSH 로 실시간 갱신, req 5).
        if (builder.confirmedCount >= MIN_RT_CANDLES) log.info(`[US:${s.symbol}] 확정봉 ${builder.confirmedCount}개(≥${MIN_RT_CANDLES}) → REST 시드만으로 신호계산 준비됨`);
      } catch (e) { log.warn(`[US:${s.symbol}] REST 시드 실패(무시, WS 로 진행): ${scrub(String(e))}`); }
    } else {
      log.warn(`[US:${s.symbol}] REST 시드 생략(${quote.error ?? 'delaygb 미설정'}) — WS 실시간으로만 집계`);
    }
  }

  // ── Phase 3A 실전 설정(1종목/1주/지정가/하루 1회) — 계좌이벤트 링크에서 참조하므로 클라이언트 전에 로드 ──
  let liveCfg: LiveConfig;
  try { liveCfg = loadLiveConfig(); } catch (e) { log.error(String(e)); process.exit(1); return; }
  const armedMode = liveCfg.armed;

  // ── 현금 주문가능액(해외 예수금) 조회 캐시 + refreshDeposit ── 계좌 단위 60초 캐시. rsp_cd/rsp_msg/전체필드 보존.
  // depCash = cash-only USD 주문가능 상한(USD현금 or 원화현금 선환전, 레버리지 제외, P0-15). depFull = 진단용 원본.
  let depAt = 0; let depCash = 0; let depOk = false; let depRspCd = ''; let depRspMsg = '';
  let depFull: LSUSDeposit | null = null;
  async function refreshDeposit(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - depAt < 60_000) return;
    try {
      const d = await getLSUSDeposit(cfg, token);
      depFull = d;
      // cash-only 상한: 타통화+원화 경로는 실측확인(crossWonVerified) 전까지 제외 → 사실상 USD현금만
      depOk = d.ok; depCash = usCashOnlyUsdCap(d, { crossWonVerified: liveCfg.crossWonVerified }); depRspCd = d.rspCd; depRspMsg = d.rspMsg;
    } catch (e) {
      depFull = null; depOk = false; depCash = 0;
      if (e instanceof LSApiError) { depRspCd = e.rspCd ?? `ERR(${e.kind})`; depRspMsg = e.message; }
      else { depRspCd = 'EXCEPTION'; depRspMsg = String(e); }
    }
    depAt = now;
  }
  // ── HTS 관찰값 비교(참고용, P0-16 재검토) ──
  // ⚠️ 사용자가 올린 "2" 는 조회결과가 아니라 주문창 수량 입력값(버튼 라벨 오해)이었다. HTS 일치를 LIVE 허용 근거로
  //    쓰지 않는다. env 값이 있고 프로그램 참고수량과 다르면 '차단'만 한다(안전방향).
  function htsCompare(priceUsd: number): { htsQty: number | null; progQty: number; mismatch: boolean | null } {
    const progQty = (depOk && depFull && priceUsd > 0) ? usOrderableQty(depFull, priceUsd).qtyCrossWon : 0;
    const htsQty = liveCfg.htsOrderableQty;
    return { htsQty, progQty, mismatch: htsQty == null ? null : htsQty !== progQty };
  }
  // 최종 주문허용(하드 게이트): 응답정상 + 가격>0 + 결정 orderAllowed(=USD현금 확정경로만) + HTS 불일치 아님.
  function usOrderAllowed(priceUsd: number): { allowed: boolean; reason: string; dec: ReturnType<typeof decideUSCashPayment> | null } {
    if (!depOk || !depFull || !(priceUsd > 0)) return { allowed: false, reason: !depOk ? 'DEPOSIT_QUERY_FAILED' : 'PRICE_UNAVAILABLE', dec: null };
    const dec = decideUSCashPayment(depFull, priceUsd, liveCfg.maxQty, { crossWonVerified: liveCfg.crossWonVerified });
    const cmp = htsCompare(priceUsd);
    if (cmp.mismatch === true) return { allowed: false, reason: 'HTS_QTY_MISMATCH', dec };
    return { allowed: dec.orderAllowed, reason: dec.reason, dec };
  }

  // ── P0-16 진단 로그: COSOQ02701 원본 후보필드 전부 + 가능수량 + 하드차단 사유를 출력(사용자 실측 확인용) ──
  function logUSCashDiag(tag: string, priceUsd: number): void {
    if (!depOk || !depFull) { log.error(`[${tag} ${liveCfg.liveSymbol}] 예수금조회 실패 rsp_cd=${depRspCd} rsp_msg=${scrub(depRspMsg)} → 주문 차단`); return; }
    const d = depFull;
    const g = usOrderAllowed(priceUsd);
    const q = usOrderableQty(d, priceUsd);
    const cmp = htsCompare(priceUsd);
    const est = priceUsd > 0 ? `주문가(1주)=${priceUsd.toFixed(2)}USD` : `주문가=대기(가격미확보)`;
    log.info(`[${tag} ${liveCfg.liveSymbol}] ${est} / USD현금(FcurrDps)=${d.usdCash.toFixed(2)} / 거래국가통화주문가능(FcurrOrdAbleAmt)=${d.usdOrderable.toFixed(2)}USD / 선환전주문가능(PrexchOrdAbleAmt)=${d.usdPrexchOrderable.toFixed(2)}USD / 원화현금(WonDpsBalAmt)=${Math.round(d.krwCash)}KRW / 원화선환전가능(WonPrexchAbleAmt)=${Math.round(d.krwPrexchable)}KRW / 기준환율=${d.baseXchRate.toFixed(2)} / 미수(OvrsMgn)=${Math.round(d.overseasMargin)} / rsp_cd=${depRspCd}`);
    log.info(`[${tag}-QTY ${liveCfg.liveSymbol}] 거래국가통화 가능수량(확정)=${q.qtyCountry} / 타통화+원화 가능수량(참고·미확정)=${q.qtyCrossWon} / HTS관찰(참고)=${cmp.htsQty == null ? '미입력' : cmp.htsQty} / crossWon실측확인=${liveCfg.crossWonVerified}(코드상수 ${LS_US_CROSS_WON_TR_CONFIRMED}) / orderAllowed=${g.allowed}${g.allowed ? '' : ` (${g.reason})`}`);
    if (!liveCfg.crossWonVerified) log.warn(`[${tag}-BLOCK ${liveCfg.liveSymbol}] 타통화+원화(통합증거금/선환전) 공식 필드 미확인 → US BUY 하드차단. 확인 절차: HTS 에서 실제 "타통화+원화 가능수량" 버튼을 눌러 나오는 금액/수량과 위 후보필드(PrexchOrdAbleAmt/WonPrexchAbleAmt 등)를 대조 후 코드상수 LS_US_CROSS_WON_TR_CONFIRMED 전환 필요.`);
  }

  // ── P0-18/19: 통합증거금(타통화+원화) 가능수량 실측대조 로그 — 후보필드별 프로그램 수량 vs HTS 실측 + [CROSS-WON-CHECK] ──
  function logCrossWon(tag: string, priceUsd: number): void {
    if (!depOk || !depFull) { log.error(`[${tag} ${liveCfg.liveSymbol}] 예수금조회 실패 rsp_cd=${depRspCd} rsp_msg=${scrub(depRspMsg)} → 주문 차단`); return; }
    // P0-19 #1: 가격 미확보(bestAsk=0)면 후보수량 확정 금지 — GSH bestAsk 수신 후 자동 재계산.
    if (!(priceUsd > 0)) { log.warn(`[${tag} ${liveCfg.liveSymbol}] bestAsk 미확보(가격=0) → 후보수량 계산 보류. 최초 유효 GSH bestAsk 수신 직후 자동 재계산.`); return; }
    const e = evaluateCrossWon(depFull, priceUsd, liveCfg.htsOrderableQty);
    // 후보 필드별 계산 수량(같은 bestAsk 기준) — 사용자가 HTS 실측값과 대조해 일치 필드 식별
    for (const c of e.candidates) {
      log.info(`[${tag}-CAND ${liveCfg.liveSymbol}] ${c.key}(${c.label}) [${c.basis}] amount=${c.amount} / 1주비용=${c.perShareCost.toFixed(4)} → qty=${c.qty}${c.match == null ? '' : ` / HTS일치=${c.match}`}`);
    }
    log.info(`[${tag}-CASHONLY ${liveCfg.liveSymbol}] cashOnly=${e.cashOnly}${e.cashOnly ? '' : ` 차단필드=[${e.cashOnlyBlockers.join(', ')}]`} (미수 OvrsMgn=${Math.round(depFull.overseasMargin)} / 대출 LoanAmt=${Math.round(depFull.loanAmt)} / 담보 FcurrPldgAmt=${depFull.fcurrPldgAmt.toFixed(2)})`);
    if (e.htsQty != null) log.info(`[${tag}-MATCHED ${liveCfg.liveSymbol}] HTS실측=${e.htsQty} 와 일치하는 후보필드=[${e.matchedKeys.join(', ') || '없음'}] (채택필드=${e.adoptedField ?? '미채택'})`);
    log.info(formatCrossWonCheck(liveCfg.liveSymbol, e));
  }

  // ── P0-19 #2,#3: 최초 유효 bestAsk>0 수신 직후 실계정 예수금 캐시 + 실제 bestAsk 로 CROSS-WON 후보 자동 재계산 ──
  async function runCrossWonLive(ctx: SymCtx): Promise<void> {
    await refreshDeposit();   // 계좌 예수금 캐시(만료 시에만 재조회)
    if (!depOk || !depFull) { log.error(`[CROSS-WON-LIVE ${ctx.symbol}] 예수금 조회 실패 rsp_cd=${depRspCd} → 재계산 보류(다음 GSH 재시도)`); ctx.crossWonLiveDone = false; return; }
    const e = evaluateCrossWon(depFull, ctx.bestAsk, liveCfg.htsOrderableQty);
    log.info(formatCrossWonLiveCand(ctx.symbol, e));   // [CROSS-WON-LIVE-CAND] 요구 형식(bestAsk/BaseXchrat/후보별 qty/HTS)
    logCrossWon('CROSS-WON-LIVE', ctx.bestAsk);         // 후보 상세 + cashOnly + [CROSS-WON-CHECK]
  }

  // ── P0-13/P0-15: 프로그램 시작 직후 BUY 여부와 무관하게 예수금 1회 조회 + 진단 로그. 실패면 LIVE 금지 ──
  await refreshDeposit(true);
  const startupPrice = ctxs.get(liveCfg.liveSymbol)?.lastPrice ?? 0;   // 시작 시 알 수 있는 참조가(시드/실시간). 없으면 0
  if (depOk) log.info(`[STARTUP-CASH ${liveCfg.liveSymbol}] cashOrderable(cash-only)=${depCash.toFixed(2)} USD rsp_cd=${depRspCd}`);
  else log.error(`[STARTUP-CASH ${liveCfg.liveSymbol}] cashOrderable 조회실패 rsp_cd=${depRspCd} rsp_msg=${scrub(depRspMsg)} → LIVE 금지`);
  logUSCashDiag('STARTUP-US-CASH', startupPrice);
  // ── P0-18: COSOQ02701 전체 실계정 원본(민감정보 마스킹) 출력 — 후보 필드 대조용 ──
  if (depFull?.rawMasked) log.info(`[COSOQ02701-RAW ${liveCfg.liveSymbol}] ${scrub(JSON.stringify(depFull.rawMasked))}`);
  logCrossWon('STARTUP-CROSS-WON', startupPrice);   // 후보필드별 수량 + [CROSS-WON-CHECK]
  const startupCashOk = depOk;

  // ── P0-16 하드차단: 타통화+원화(통합증거금/선환전) 공식 필드 미확인 → US BUY 원천 차단(LS_LIVE_TRADING=true 여도) ──
  // 확정 경로(USD 현금)만 신뢰. 실계정 USD현금=0 이면 사실상 오늘 US BUY 불가. 사용자 실측확인 후 코드상수 전환 시 해제.
  if (!liveCfg.crossWonVerified) {
    log.warn(`[P0-16] 타통화+원화 주문가능 공식 필드 미확인 → US BUY 하드차단(LS_US_CROSS_WON_TR_CONFIRMED=${LS_US_CROSS_WON_TR_CONFIRMED}). USD 현금 주문가능=${depFull ? depFull.usdOrderable.toFixed(2) : '0.00'}USD 로만 판정.`);
  }

  // 실행 능력: LIVE_TRADING + 취소모드(수동 허용) + 시작시 현금조회 성공(P0-13) 필요. (실제 BUY 는 확정 현금경로만 통과)
  const liveCapable = canExecuteLive(true, liveCfg.liveTrading, { manualCancel: liveCfg.manualCancel, cancelEnvConfirmed: liveCfg.cancelConfirmed }).execute && startupCashOk;
  // P0-10: 최종 체크리스트 출력
  const p0 = computeUSP0Checklist(liveCfg);
  log.info(`[P0-CHECKLIST]\n${formatUSP0Checklist(p0)}`);
  log.info(`[P0] US_LIVE_READY=${p0.US_LIVE_READY} · 시작현금조회=${startupCashOk} → 오늘 미국장 실전 ${p0.US_LIVE_READY && startupCashOk ? '가능(단, LS_LIVE_TRADING=true 필요)' : '불가/차단'}`);
  log.info(`[LIVE-CFG] 대상=${liveCfg.liveExchange}:${liveCfg.liveSymbol}(exchcd=${liveCfg.liveExchcd}) maxQty=${liveCfg.maxQty} 하루매수=${liveCfg.dailyMaxBuys} 하루매도=${liveCfg.dailyMaxSells} 미체결타임아웃=${liveCfg.pendingTimeoutSec}s`);
  log.info(`ARMED=${armedMode} · LS_LIVE_TRADING=${liveCfg.liveTrading} · 취소TR확인(env)=${liveCfg.cancelConfirmed}/(코드)=false → 실주문 ${liveCapable ? '가능' : '차단'}`);

  // ── 계좌 주문이벤트(AS0~AS4) 추적 저장 — 계좌 단위(전 종목). 재시작 시 원주문번호 기준 복원 ──
  const evStore = new OrderStore('__account_events__');
  evStore.load();
  const tracker = evStore.trackedMap();
  if (evStore.corrupt) log.error('[ACCT] 주문이벤트 저장 파일 손상 → 상태추적 복원 실패, 새로 시작');
  else if (tracker.size) log.info(`[ACCT] 주문상태 ${tracker.size}건 복원(원주문번호 기준)`);

  // ── WebSocket 연결 (시세 GSC/GSH + 계좌 AS0~AS4) ──
  const client = new LSUSRealtimeClient(token, {
    // 계좌 주문이벤트: 상태머신 반영 + 영구저장(민감정보 미저장/미출력). ⚠️ AS3 는 취소 결과 확인 이벤트일 뿐,
    // 취소 "요청"이 아니다. LIVE 취소 완료는 REST 취소 성공 + AS3 둘 다 필요(현재 REST 취소 미구현).
    onAccountEvent: (trCd, body) => {
      const ev = parseAccountEvent(trCd, body);
      if (!ev) return;
      const res = applyOrderEvent(tracker, ev, Date.now());
      evStore.saveTracked(tracker);
      evStore.recordResponse({ atMs: Date.now(), tr: trCd, rspCd: (ev as any).rejectReason || '', rspMsg: res.changed ? res.transition : `무시:${res.reason}`, ordNo: ev.ordNo || null, note: res.order?.status });
      evStore.flush();
      log.info(`[ACCT ${trCd}] ordNo=${ev.ordNo || '-'} org=${ev.orgOrdNo || '-'} ${res.changed ? res.transition : `무시(${res.reason})`} status=${res.order?.status ?? '-'}${trCd === 'AS3' ? ' (취소 결과확인 이벤트 · REST 취소요청 아님)' : ''}`);
      // req10: AS 상태추적(주문번호)을 실전 종목 OrderStore pending 과 연결 — 종결이면 pending 해소.
      const liveCtx = ctxs.get(liveCfg.liveSymbol);
      if (liveCtx) { const done = linkTrackedToOrders(tracker, liveCtx.orders); if (done.length) log.info(`[ACCT-LINK ${liveCfg.liveSymbol}] pending 해소(주문번호 ${done.join(',')})`); }
    },
    onRegisterAck: (trCd, rspCd, rspMsg) => log.info(`[ACCT-REG] ${trCd} 등록응답 rsp_cd=${rspCd} rsp_msg=${scrub(rspMsg)}`),
    onGSC: (t) => {
      const ctx = ctxs.get(t.symbol);
      if (!ctx) return;
      // localTs = ovsdate+trdtm = 미국 현지(America/New_York) 벽시계 → 그대로 ET 버킷팅(서머타임 자동, req 8)
      const confirmed = ctx.builder.addTrade(t.lastPrice, t.tradeQty, t.localTs);
      ctx.lastGSCat = Date.now();
      ctx.lastPrice = t.lastPrice;
      if (confirmed && !ctx.store.corrupt) {
        // 버킷 전환 → 직전 봉 확정. 같은 timestamp 중복 저장 금지(upsert 가 판정), 신규면 즉시 atomic 저장.
        if (ctx.store.upsertConfirmed(toStored(confirmed))) {
          ctx.store.setForming(toStored(ctx.builder.formingCandle()!));
          ctx.store.flush();
          log.info(`[CONFIRM US:${t.symbol}] ${confirmed.datetime} O=${confirmed.open} H=${confirmed.high} L=${confirmed.low} C=${confirmed.close} V=${confirmed.volume} → 저장(확정봉=${ctx.store.confirmedCount})`);
        }
      }
    },
    onGSH: (q) => {
      const ctx = ctxs.get(q.symbol);
      if (!ctx) return;
      ctx.lastGSHat = Date.now();
      ctx.bestBid = q.bestBid;
      ctx.bestAsk = q.bestAsk;
      log.info(`[GSH ${q.symbol}] bid=${q.bestBid}(${q.bidRem}) ask=${q.bestAsk}(${q.askRem})`);
      // P0-19 #2: 최초 유효 bestAsk>0 수신 직후 실계정 종목에 대해 CROSS-WON 후보 1회 자동 재계산
      if (!ctx.crossWonLiveDone && q.bestAsk > 0 && isLiveSymbol(liveCfg, q.symbol)) {
        ctx.crossWonLiveDone = true;
        void runCrossWonLive(ctx);
      }
    },
    onStatus: (m) => log.info(`[WS] ${scrub(m)}`),
  }, { accountEvents: true });   // AS0~AS4 계좌 이벤트 등록(tr_type=1) — 재연결 시 자동 재등록
  client.connect(us.ok.map(s => ({ exchcd: s.exchcd, symbol: s.symbol })));

  const traderDeps: TraderDeps = {
    place: (pp) => placeLSUSBuyOrder(cfg, token, pp),
    query: (pp) => queryLSUSOrderExec(cfg, token, pp),
    cancel: (pp) => cancelLSUSOrder(cfg, token, pp),
    // 현금 주문가능금액 — 확정 경로(USD현금)만. 타통화+원화 선환전은 실측확인 전까지 제외(cash-only, 레버리지 절대 미사용).
    cashOrderable: async () => {
      try { const d = await getLSUSDeposit(cfg, token); return { ok: d.ok, cash: usCashOnlyUsdCap(d, { crossWonVerified: liveCfg.crossWonVerified }) }; }
      catch (e) { log.warn(`[US] 현금 주문가능금액 조회 실패: ${scrub(String(e))}`); return { ok: false, cash: 0 }; }
    },
    now: () => Date.now(),
    log: (m) => log.info(scrub(m)),
  };

  async function evaluateArmed(ctx: SymCtx, sig: { action: string; candleDatetime: string }, now: number): Promise<void> {
    const etDate = etDateStr(now);
    const gscAgeSec = ctx.lastGSCat == null ? null : Math.round((now - ctx.lastGSCat) / 1000);
    const gshAgeSec = ctx.lastGSHat == null ? null : Math.round((now - ctx.lastGSHat) / 1000);
    // 동일 확정봉 중복/일일한도/손상 → 중복주문으로 간주(cond9), 미체결(cond10)
    const dup = ctx.orders.corrupt || ctx.orders.hasOrderedCandle(sig.candleDatetime, 'buy') || !ctx.orders.canBuyToday(etDate, liveCfg.dailyMaxBuys);
    const pending = ctx.orders.hasPending();
    const buyPrice = ctx.bestAsk;   // 매수 지정가 = GSH ask

    // ── cashOrderable (P0-17): 항상 STARTUP 예수금 캐시 사용. "미조회" 출력 금지. ──
    //   · 비-BUY 틱: 60초 캐시 그대로 사용(만료 시에만 자동 재조회). BUY 신호(확정봉≥20): 직전 강제 재조회.
    //   · ARMED 로그는 캐시 기준으로 cashOrderable=<금액> USD 또는 cashOrderable=조회실패 둘 중 하나만.
    let orderableQtyOk = false;
    const isBuySignal = sig.action === 'BUY' && ctx.builder.confirmedCount >= MIN_RT_CANDLES;
    if (isBuySignal) {
      await refreshDeposit(true);          // BUY 직전 강제 재조회(P0-17 #4,#6 / P0-18 #9 재검증)
      // 통합증거금(타통화+원화) 경로: 실측대조·cash-only 재확인. 채택필드+코드상수 확정 전까지 하드차단.
      const crossWon = depFull ? evaluateCrossWon(depFull, buyPrice, liveCfg.htsOrderableQty) : null;
      // 확정경로(USD현금) 또는 확정된 통합증거금 경로 중 하나라도 허용이면 통과(현재 둘 다 하드차단).
      orderableQtyOk = usOrderAllowed(buyPrice).allowed || !!(crossWon && crossWon.orderAllowed);
      logUSCashDiag('BUY-US-CASH', buyPrice);              // BUY 직전 상세 진단(P0-16)
      logCrossWon('BUY-CROSS-WON', buyPrice);              // BUY 직전 통합증거금 실측대조(P0-18)
    } else {
      await refreshDeposit();              // 60초 캐시 사용(만료 시에만 재조회) — 재조회 전엔 캐시 유지
    }
    // 캐시 기준 cashLog — 성공이면 실제 금액, 실패면 rsp_cd/rsp_msg (절대 "미조회" 아님)
    const cashLog = formatCashOrderableLine({ ok: depOk, cash: depCash, rspCd: depRspCd, rspMsg: scrub(depRspMsg) });

    const state: GateState = {
      confirmedCount: ctx.builder.confirmedCount, signalAction: sig.action, wsConnected: client.connected,
      gscAgeSec, gshAgeSec, bid: ctx.bestBid, ask: ctx.bestAsk, lastPrice: ctx.lastPrice, nowMs: now,
      orderableQtyOk, duplicateCandleOrdered: dup, hasPendingOrder: pending,
    };
    const g = evaluateTradeGate(state);
    log.info(`[ARMED ${ctx.symbol}] armed=${g.armed} 통과=${g.passed.length}/10 ${cashLog}${g.blockedBy.length ? ` 차단=[${g.blockedBy.join(', ')}]` : ''}`);
    if (!g.armed) return;

    const live = canExecuteLive(g.armed, liveCfg.liveTrading, { manualCancel: liveCfg.manualCancel, cancelEnvConfirmed: liveCfg.cancelConfirmed });
    if (!live.execute) { log.info(`[ARMED-READY ${ctx.symbol}] 전 10개 조건 충족 · 매수지정가=${buyPrice}(ask) · 주문 없음 — ${live.reason}`); return; }
    // ↓ 현재 도달 불가(LIVE off 또는 취소 TR 미확인). 도달 시에도 trader 가 한도/중복/미체결 재검증.
    const outcome = await executeBuyOrder(traderDeps, {
      orders: ctx.orders, exchcd: ctx.exchcd, symbol: ctx.symbol, candleDatetime: sig.candleDatetime,
      qty: liveCfg.maxQty, price: buyPrice, etDate, dailyMaxBuys: liveCfg.dailyMaxBuys,
    });
    log.info(`[ORDER-RESULT ${ctx.symbol}] status=${outcome.status} ordNo=${outcome.ordNo ?? '-'} ${outcome.reason}`);
  }

  // ── 10초마다 readiness + OBSERVE + ARMED (상태 항목별 출력) ──
  let ticking = false;
  const iv = setInterval(async () => {
    if (ticking) return;   // 이전 틱(예수금 조회 등) 진행 중이면 건너뜀
    ticking = true;
    try {
      for (const ctx of ctxs.values()) {
        const now = Date.now();
        const r = evaluateReadiness({
          websocketConnected: client.connected,
          lastGSCatMs: ctx.lastGSCat,
          lastGSHatMs: ctx.lastGSHat,
          lastPrice: ctx.lastPrice,
          bestBid: ctx.bestBid,
          bestAsk: ctx.bestAsk,
          confirmedCount: ctx.builder.confirmedCount,
          storeCorrupted: ctx.store.corrupt,
        }, now);
        log.info(
          `[READY ${ctx.symbol}] READY=${r.ready} warmup=${r.warmup}${r.warmup ? ` remaining=${r.warmupRemaining}` : ''}`
          + ` confirmed=${ctx.builder.confirmedCount}/${MIN_RT_CANDLES} forming=${ctx.builder.hasForming}`
          + ` gscAgeSec=${r.gscAgeSec ?? '-'} gshAgeSec=${r.gshAgeSec ?? '-'} wsConnected=${client.connected}`
          + ` bid=${ctx.bestBid || '-'} ask=${ctx.bestAsk || '-'} lastPrice=${ctx.lastPrice || '-'}`
          + ` 신규매수허용=${r.allowNewBuy} 신호계산허용=${r.allowSignal} 보유매도허용=${r.allowSellExisting}`
          + (r.reasons.length ? ` | ${r.reasons.join(', ')}` : ''),
        );
        // BB/RSI/Signal 은 Warm-up 동안에도 계속 계산(확정봉>0). 형성봉 제외(req 2·9).
        const sig = observeSignal(log, ctx, r.warmup, r.warmupRemaining);
        // ARMED/실주문은 실전 대상 1종목(예: NASDAQ:AAPL)에만, Warm-up 종료(확정봉≥20)+GSC신선일 때만 평가.
        if (isLiveSymbol(liveCfg, ctx.symbol)) {
          // 미체결 조정: 체결완료→해소 / 타임아웃→취소. 취소TR 미확인이면 취소는 실패로 남고 pending 유지(req15).
          if (ctx.orders.hasPending()) {
            if (liveCapable) {
              const rec = await reconcilePending(traderDeps, { orders: ctx.orders, exchcd: ctx.exchcd, ordDate: etDateStr(Date.now()), timeoutMs: liveCfg.pendingTimeoutSec * 1000, autoCancel: liveCfg.autoCancel });
              for (const o of rec) log.info(`[RECONCILE ${ctx.symbol}] ordNo=${o.ordNo} ${o.status} — ${o.reason}`);
            } else {
              log.warn(`[RECONCILE ${ctx.symbol}] 미체결 ${ctx.orders.pending.length}건 존재하나 실주문/취소 비활성 → 수동 확인 필요(신규주문 차단)`);
            }
          }
          if (armedMode && sig && !r.warmup && r.allowSignal) await evaluateArmed(ctx, sig, Date.now());
        }
      }
    } finally { ticking = false; }
  }, 10_000);

  // ── 정상 종료(SIGINT/SIGTERM): 형성봉 저장 후 종료 ──
  let shuttingDown = false;
  const shutdown = (sigName: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(iv);
    try { client.close(); } catch { /* noop */ }
    for (const ctx of ctxs.values()) {
      if (ctx.store.corrupt) continue;   // 손상 파일에는 추가 저장 안 함
      const forming = ctx.builder.formingCandle();
      ctx.store.setForming(forming ? toStored(forming) : null);
      try { ctx.store.flush(); } catch (e) { log.warn(`[US:${ctx.symbol}] 종료 저장 실패: ${scrub(String(e))}`); }
    }
    log.info(`관찰 종료(${sigName}) · orders_submitted=0 (LS_LIVE_TRADING=${cfg.liveTrading}, 관찰 전용) · 형성봉 저장 완료 · 로그: ${log.file}`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log.info(`지속 실행 중 — 종료하려면 Ctrl+C. READY/OBSERVE/ARMED 는 10초마다 기록됩니다.${armedMode ? ' (ARMED=조건 감시만, 주문 없음)' : ''}`);
  await new Promise(() => { /* SIGINT 까지 유지 */ });
}
main();
