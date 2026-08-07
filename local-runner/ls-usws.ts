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
  placeLSUSBuyOrder, queryLSUSOrderExec, cancelLSUSOrder,
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
    const ctx: SymCtx = { symbol: s.symbol, exchange: s.exchange, exchcd: s.exchcd, builder, store, orders, lastGSCat: null, lastGSHat: null, lastPrice: 0, bestBid: 0, bestAsk: 0 };
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
  // 실행 능력(3중): armed=true 가정 시 LIVE_TRADING + 취소TR(코드상수 false) + env 취소확인 모두 필요
  const liveCapable = canExecuteLive(true, liveCfg.liveTrading, liveCfg.cancelConfirmed).execute;
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
    },
    onStatus: (m) => log.info(`[WS] ${scrub(m)}`),
  }, { accountEvents: true });   // AS0~AS4 계좌 이벤트 등록(tr_type=1) — 재연결 시 자동 재등록
  client.connect(us.ok.map(s => ({ exchcd: s.exchcd, symbol: s.symbol })));

  const traderDeps: TraderDeps = {
    place: (pp) => placeLSUSBuyOrder(cfg, token, pp),
    query: (pp) => queryLSUSOrderExec(cfg, token, pp),
    cancel: (pp) => cancelLSUSOrder(cfg, token, pp),
    // 현금(USD 예수금) 주문가능금액 — 신용/미수/증거금 미사용(cash-only). 부족하면 전송 금지.
    cashOrderable: async () => {
      try { const d = await getLSUSDeposit(cfg, token); return { ok: d.rspCd === '00000' && d.found, cash: d.usdDeposit }; }
      catch (e) { log.warn(`[US] 현금 주문가능금액 조회 실패: ${scrub(String(e))}`); return { ok: false, cash: 0 }; }
    },
    now: () => Date.now(),
    log: (m) => log.info(scrub(m)),
  };

  // 예수금(주문가능) 조회 캐시 — 계좌 단위라 60초 캐시(불필요 네트워크 억제)
  let depAt = 0; let depUsd = 0; let depOk = false;
  async function orderableCheck(priceNeeded: number): Promise<boolean> {
    const now = Date.now();
    if (now - depAt >= 60_000) {
      try { const d = await getLSUSDeposit(cfg, token); depOk = d.rspCd === '00000' && d.found; depUsd = d.usdDeposit; }
      catch (e) { depOk = false; depUsd = 0; log.warn(`[ARMED] 예수금 조회 실패: ${scrub(String(e))}`); }
      depAt = now;
    }
    return depOk && depUsd >= priceNeeded;   // 1주 매수 가능 여부
  }

  async function evaluateArmed(ctx: SymCtx, sig: { action: string; candleDatetime: string }, now: number): Promise<void> {
    const etDate = etDateStr(now);
    const gscAgeSec = ctx.lastGSCat == null ? null : Math.round((now - ctx.lastGSCat) / 1000);
    const gshAgeSec = ctx.lastGSHat == null ? null : Math.round((now - ctx.lastGSHat) / 1000);
    // 동일 확정봉 중복/일일한도/손상 → 중복주문으로 간주(cond9), 미체결(cond10)
    const dup = ctx.orders.corrupt || ctx.orders.hasOrderedCandle(sig.candleDatetime, 'buy') || !ctx.orders.canBuyToday(etDate, liveCfg.dailyMaxBuys);
    const pending = ctx.orders.hasPending();
    // 매수 지정가 = GSH ask (req4). 나머지 조건이 모두 통과할 때만 예수금 조회(불필요 네트워크 억제)
    const buyPrice = ctx.bestAsk;
    const worthQuery = sig.action === 'BUY' && ctx.builder.confirmedCount >= MIN_RT_CANDLES && client.connected
      && isUSRegularSession(now) && ctx.bestBid > 0 && ctx.bestAsk > 0 && ctx.lastPrice > 0 && !dup && !pending;
    const orderableQtyOk = worthQuery ? await orderableCheck(buyPrice) : false;

    const state: GateState = {
      confirmedCount: ctx.builder.confirmedCount, signalAction: sig.action, wsConnected: client.connected,
      gscAgeSec, gshAgeSec, bid: ctx.bestBid, ask: ctx.bestAsk, lastPrice: ctx.lastPrice, nowMs: now,
      orderableQtyOk, duplicateCandleOrdered: dup, hasPendingOrder: pending,
    };
    const g = evaluateTradeGate(state);
    log.info(`[ARMED ${ctx.symbol}] armed=${g.armed} 통과=${g.passed.length}/10${g.blockedBy.length ? ` 차단=[${g.blockedBy.join(', ')}]` : ''}`);
    if (!g.armed) return;

    const live = canExecuteLive(g.armed, liveCfg.liveTrading, liveCfg.cancelConfirmed);
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
              const rec = await reconcilePending(traderDeps, { orders: ctx.orders, exchcd: ctx.exchcd, ordDate: etDateStr(Date.now()), timeoutMs: liveCfg.pendingTimeoutSec * 1000 });
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
