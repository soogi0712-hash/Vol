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
  getLSUS15MinPaged, getLSUS15MinOlderThan, getLSUSTicksPaged, getLSUSDeposit, getLSUSStockMasterPage,
  placeLSUSBuyOrder, queryLSUSOrderExec, cancelLSUSOrder, LSApiError, LS_US_ORDEREXEC_EMPTY_CODES,
  decideUSCashPayment, usCashOnlyUsdCap, usOrderableQty, formatCashOrderableLine,
  computeUSOrderQty, formatUSOrderQty,
  evaluateCrossWon, formatCrossWonCheck, formatCrossWonLiveCand, formatUSLiveGate, LS_US_CROSS_WON_TR_CONFIRMED, type LSUSDeposit,
} from '../src/lib/ls-api';
import { loadUSUniverse, selectUSLiveCandidate, probeUSMasterExgubun, exgubunWithNyseAmex } from './us-universe';
import { computeScanCapacity, RateLimiter } from './kr-rate-limiter';
import { rankBuyCandidates, bbBreakStrength, rsiReboundStrength, RoundRobinScanner } from './kr-scanner';
import { pickBackfillTarget, computeBackfillCapacity, computeBackfillDelta, BackfillStats, BACKFILL_MIN_CONFIRMED, BACKFILL_TARGET, type BackfillCand } from './us-backfill';
import {
  LSUSRealtimeClient, RealtimeCandleBuilder, buildWsTrKey, evaluateReadiness, MIN_RT_CANDLES,
  aggregateTicksTo15Min, type RTCandle,
} from './ls-us-websocket';
import { CandleStore, type StoredCandle } from './candle-store';
import { OrderStore } from './order-store';
import { parseAccountEvent, applyOrderEvent } from './order-events';
import { evaluateTradeGate, canExecuteLive, etDateStr, isUSRegularSession, type GateState } from './trade-gate';
import { executeBuyOrder, reconcilePending, linkTrackedToOrders, type TraderDeps } from './trader';
import { loadLiveConfig, type LiveConfig } from './live-config';
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

  log.info('[BOOT-STEP] 1 load-config');
  let cfg: LocalLSConfig;
  try { cfg = loadConfig(); } catch (e) { log.error(String(e)); process.exit(1); return; }

  const scrub0 = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); }
  catch (e) { log.error(`토큰 실패: ${scrub0(String(e))}`); process.exit(1); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret, token, cfg.accountNo]);

  const us = loadUSSymbols();
  for (const u of us.unsupported) log.warn(`[US:${u.token}] UNSUPPORTED_EXCHANGE(${u.exchange}) 스킵(추측 금지)`);

  // ── P0-23: 미국 전체 유니버스 로드(g3190) + eligibility 필터 → WS 구독 배치 구성 ──
  //   전체 유니버스는 라운드로빈 배치로 WS 등록(요구 6). ⚠️ LS 공식 카탈로그에 해외 WS 동시등록 한도가 미기재
  //   (GSC/GSH requestLimit='') → 보수적 배치크기(LS_US_WS_MAX_SUBS, 기본 30)를 설정값으로 사용(추측 금지·정직 보고).
  //   LS_US_SYMBOLS(예: AAPL) 는 유지 병합(기존 워밍 경로 보존). LS_US_UNIVERSE=off 면 유니버스 로드 생략.
  const wsMaxSubs = Math.max(1, Math.min(500, parseInt(process.env.LS_US_WS_MAX_SUBS || '30', 10) || 30));
  const universeOn = process.env.LS_US_UNIVERSE !== 'off';
  // P0-25 실측 확정: exgubun 2=NASDAQ(82), 1·3=NYSE/AMEX(81). 4=중복(제외, DIAG 전용). 기본 전체시장='2,1,3'.
  let exgubunList = (process.env.LS_US_MASTER_EXGUBUN || '2,1,3').split(',').map(s => s.trim()).filter(Boolean);
  const includeEtf = process.env.LS_US_INCLUDE_ETF === 'true';
  const subs = us.ok.map(s => ({ symbol: s.symbol, exchange: s.exchange, exchcd: s.exchcd }));
  let fullPool: { symbol: string; exchange: string; exchcd: string }[] = [...subs];   // 기본 = LS_US_SYMBOLS. 유니버스 로드 성공 시 전체로 교체.
  if (universeOn) {
    // ── P0-25: exgubun 실측 탐색(주문 없음). exchcd=81(NYSE/AMEX) 반환 값을 찾아 로드 대상에 자동 추가 ──
    if (process.env.LS_US_MASTER_EXGUBUN_DIAG === 'true') {
      const cands = (process.env.LS_US_MASTER_EXGUBUN_DIAG_VALUES || '0,1,2,3,4,5,6,7,8,9').split(',').map(s => s.trim()).filter(Boolean);
      log.info(`[US-EXGUBUN-DIAG] 후보 exgubun 탐색(주문없음, 각 첫 페이지 1회): [${cands.join(',')}]`);
      try {
        const probes = await probeUSMasterExgubun(cfg, token, cands, getLSUSStockMasterPage, { readcnt: 100 });
        for (const p of probes) log.info(`[US-EXGUBUN-DIAG] exgubun=${p.exgubun} rows=${p.rows} exchcd81=${p.exchcd81} exchcd82=${p.exchcd82} other=${p.otherExch} sample=[${p.sampleSymbols.join(' ')}]${p.error ? ` ERROR=${scrub(p.error)}` : ''}`);
        const nyse = exgubunWithNyseAmex(probes);
        log.info(`[US-EXGUBUN-DIAG] exchcd81(NYSE/AMEX) 반환 exgubun=[${nyse.join(',') || '없음'}]${nyse.length ? ' → 이번 로드에 자동 추가' : ' — 후보에서 NYSE/AMEX 미발견(LS_US_MASTER_EXGUBUN_DIAG_VALUES 확대 필요)'}`);
        exgubunList = [...new Set([...exgubunList, ...nyse])];   // 실측으로 확인된 값만 추가(요구 3·4)
      } catch (e) { log.error(`[US-EXGUBUN-DIAG] 탐색 실패: ${scrub(String(e))}`); }
    }
    log.info(`[BOOT-STEP] 2 load-us-universe-start exgubun=[${exgubunList.join(',')}]`);
    try {
      const uni = await loadUSUniverse(cfg, token, exgubunList, getLSUSStockMasterPage, {
        includeEtf, maxPages: 60, readcnt: 500, timeoutMs: 10000,
        // 요구 1: 각 g3190 요청/응답(시장별 page/cts/rows/신규행/종료사유)을 계측
        onPage: (i) => {
          log.info(`[BOOT-STEP] 4 g3190 exgubun=${i.exgubun} page=${i.page} rows=${i.rows} newRows=${i.newRows} resTrCont='${i.resTrCont}' resTrContKey='${i.resTrContKey}' rsp_cd=${i.rspCd}${i.stop ? ` stop=${i.stop}` : ''}`);
        },
      });
      const exSum = Object.entries(uni.excludedByReason).map(([k, v]) => `${k}=${v}`).join(' ');
      const allMarkets = uni.eligiblePerExchange.NASDAQ > 0 && uni.eligiblePerExchange.NYSE_AMEX > 0;
      const complete = uni.ok && uni.complete !== false && allMarkets;
      log.info(`[BOOT-STEP] 5 load-us-universe-done total=${uni.total} eligible=${uni.eligible.length} ok=${uni.ok} complete=${complete}`);
      // 요구 2·3: continuation 오류/미완료면 성공/준비완료로 보고 금지, 명확히 오류 표기.
      if (uni.complete === false) log.error(`[US-UNIVERSE] ⚠️ continuation 오류/미완료 — 전체 유니버스 아님(중복페이지 또는 상한). ${uni.note}`);
      if (!allMarkets) log.error(`[US-UNIVERSE] ⚠️ 전체시장 아님 — NASDAQ=${uni.eligiblePerExchange.NASDAQ} NYSE_AMEX(81)=${uni.eligiblePerExchange.NYSE_AMEX}. exgubun=[${exgubunList.join(',')}] 로 NYSE/AMEX 미포함 가능 → LS_US_MASTER_EXGUBUN 로 시장별 값 추가 필요(공식 값 미기재).`);
      log.info(`[US-UNIVERSE] total=${uni.total} eligible=${uni.eligible.length} NASDAQ=${uni.eligiblePerExchange.NASDAQ} NYSE_AMEX(81=NYSE+AMEX)=${uni.eligiblePerExchange.NYSE_AMEX} excluded=${uni.excluded} (${exSum || '없음'}) complete=${complete} · ${uni.note}`);
      if (complete) log.info('[US-UNIVERSE] 전체 유니버스 준비 완료(모든 시장·연속조회 정상 종료)');
      else log.warn('[US-UNIVERSE] 전체 유니버스 미완료 — "준비 완료" 아님(위 오류 참조). 로드된 부분으로만 관찰 진행.');
      // 라운드로빈 등록: 오늘은 첫 배치(wsMaxSubs)만 구독. 전체는 배치 순환으로 커버(요구 4·6).
      const capReq = Math.max(1, parseInt(process.env.LS_US_REST_REQ_PER_SEC || '1', 10) || 1);   // g3203 개인 1/s·법인 10/s
      const cap = computeScanCapacity(uni.eligible.length, capReq, wsMaxSubs, 900);
      log.info(`[US-CAPACITY] eligible=${cap.eligible}(${complete ? '전체시장' : '부분/미완료'}) WS배치=${wsMaxSubs} REST시드/s=${capReq} 전체REST시드1순환=${cap.fullCycleSec}s(${(cap.fullCycleSec / 60).toFixed(1)}분) 15분내전종목평가가능=${cap.coversWithinCandle}${complete ? '' : ' ⚠️(부분집합 기준 — 성공 아님)'}`);
      // P0-24: 전체 eligible 을 로테이션 풀에 병합(LS_US_SYMBOLS 우선). 첫 배치만 즉시 구독, 나머지는 로테이션.
      const uniSubs = uni.eligible.map(r => ({ symbol: r.symbol, exchange: r.market === 'NASDAQ' ? 'NASDAQ' : 'NYSE', exchcd: r.exchcd }));
      const merged = new Map(subs.map(s => [s.symbol, s]));
      for (const s of uniSubs) if (!merged.has(s.symbol)) merged.set(s.symbol, s);
      fullPool = [...merged.values()];
      log.info(`[US-SUBS] 로테이션 풀 ${fullPool.length}종목 · WS 배치크기=${wsMaxSubs} · 총 배치=${Math.max(1, Math.ceil(fullPool.length / wsMaxSubs))}`);
    } catch (e) { log.error(`[BOOT-STEP] 5 load-us-universe-FAILED: ${scrub(String(e))} — LS_US_SYMBOLS 로 폴백(없으면 종료)`); }
  }
  // 요구 5: 유니버스 실패 + 폴백 종목도 없으면 무한대기 말고 즉시 종료.
  if (!fullPool.length) { log.error('[BOOT-STEP] 종료 — 관찰 US 종목 없음(유니버스 로드 실패 + LS_US_SYMBOLS 비어있음)'); process.exit(1); return; }
  // ── P0-24/25: 로테이션 — LS_US_SYMBOLS(AAPL/TSLA/BA 등 워밍된 LIVE 종목)는 항상 구독, 나머지만 순환(요구 7) ──
  const poolBySymbol = new Map(fullPool.map(s => [s.symbol, s]));
  const alwaysOn = subs.filter(s => poolBySymbol.has(s.symbol));            // 상시 구독(워밍 유지)
  const alwaysOnSet = new Set(alwaysOn.map(s => s.symbol));
  const rotationSyms = fullPool.map(s => s.symbol).filter(sym => !alwaysOnSet.has(sym));   // 로테이션 대상(상시구독 제외)
  const rotateBatchSize = Math.max(1, wsMaxSubs - alwaysOn.length);
  const rotateScanner = new RoundRobinScanner(rotationSyms);
  const batchCount = Math.max(1, Math.ceil(rotationSyms.length / rotateBatchSize));
  const makeBatch = () => [...alwaysOn.map(s => s.symbol), ...rotateScanner.nextBatch(rotateBatchSize)]
    .map(sym => poolBySymbol.get(sym)).filter((x): x is NonNullable<typeof x> => !!x);
  let rotateBatchNo = 1;
  let usOk = makeBatch();
  log.info(`[US-WS-ROTATE] batch=1/${batchCount} 상시구독=${alwaysOn.length}(${alwaysOn.map(s => s.symbol).join(',')}) + 로테이션${rotateBatchSize} · 총 ${usOk.length}종목`);

  const ctxs = new Map<string, SymCtx>();
  const quote = resolveUSQuote();
  const sdate = kstYmd(10);

  // P0-24 로테이션용: 저장된 확정봉만으로 ctx 생성(REST 미사용 → 빠름). WS 로 전방 워밍.
  const seedStoredCtx = (s: { symbol: string; exchange: string; exchcd: string }): SymCtx => {
    const store = new CandleStore(s.symbol); store.load();
    const orders = new OrderStore(s.symbol); orders.load();
    const builder = new RealtimeCandleBuilder();
    if (!store.corrupt) builder.seed(store.confirmedSorted().map(c => ({ ...c })));
    return { symbol: s.symbol, exchange: s.exchange, exchcd: s.exchcd, builder, store, orders, lastGSCat: null, lastGSHat: null, lastPrice: 0, bestBid: 0, bestAsk: 0, crossWonLiveDone: false };
  };

  // ── 시작 시: 저장된 확정봉 복원 → REST g3203 시드 병합(실패해도 진행) ──
  log.info(`[BOOT-STEP] 6 seed-candles (${usOk.length}종목)`);
  for (const s of usOk) {
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

  // ── WebSocket 계좌이벤트(AS0~AS4) 등록 토글 — 원인 격리용(req 3) ──
  //   LS_US_WS_ACCOUNT_EVENTS=false → GSC/GSH 만 등록(AS 미등록)으로 close 원인 분리.
  //   LS_US_WS_DEFER_ACCOUNT=false → AS 를 open 즉시 등록(기본은 첫 데이터 수신 후 지연 등록).
  const usAccountEvents = process.env.LS_US_WS_ACCOUNT_EVENTS !== 'false';
  const usDeferAccountEvents = process.env.LS_US_WS_DEFER_ACCOUNT !== 'false';
  log.info(`[WS-CFG] accountEvents=${usAccountEvents} deferAccountEvents=${usDeferAccountEvents} (격리 테스트: LS_US_WS_ACCOUNT_EVENTS=false 로 AS 미등록)`);

  // ── 거래 0건 사유별 카운터(req 9) — 매 틱 왜 주문이 안 나갔는지 분류 ──
  const noTradeCounts = { NO_BUY_SIGNAL: 0, WS_NOT_READY: 0, MARKET_CLOSED: 0, CASH_GATE: 0, RECONCILIATION_FAILED: 0, PENDING: 0, DAILY_LIMIT: 0, DUPLICATE_CANDLE: 0, WARMUP: 0 };
  const bumpNoTrade = (k: keyof typeof noTradeCounts) => { noTradeCounts[k]++; };

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
    // P0-29A: 최소 1주 결제가능 여부(확정경로) 게이트. 실제 주문수량은 computeUSOrderQty(예산기반)가 별도 산정.
    const dec = decideUSCashPayment(depFull, priceUsd, 1, { crossWonVerified: liveCfg.crossWonVerified });
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
    log.info(formatUSLiveGate(ctx.symbol, { liveTrading: liveCfg.liveTrading, usLiveReady: computeUSP0Checklist(liveCfg).US_LIVE_READY, crossWonVerified: liveCfg.crossWonVerified, e }));   // [US-LIVE-GATE] 실제 bestAsk 기준
  }

  // ── P0-13/P0-15: 프로그램 시작 직후 BUY 여부와 무관하게 예수금 1회 조회 + 진단 로그. 실패면 LIVE 금지 ──
  log.info('[BOOT-STEP] 7 startup-cash');
  await refreshDeposit(true);
  const startupPrice = ctxs.get(liveCfg.liveSymbol)?.lastPrice ?? 0;   // 시작 시 알 수 있는 참조가(시드/실시간). 없으면 0
  if (depOk) log.info(`[STARTUP-CASH ${liveCfg.liveSymbol}] cashOrderable(cash-only)=${depCash.toFixed(2)} USD rsp_cd=${depRspCd}`);
  else log.error(`[STARTUP-CASH ${liveCfg.liveSymbol}] cashOrderable 조회실패 rsp_cd=${depRspCd} rsp_msg=${scrub(depRspMsg)} → LIVE 금지`);
  logUSCashDiag('STARTUP-US-CASH', startupPrice);
  // ── P0-18: COSOQ02701 전체 실계정 원본(민감정보 마스킹) 출력 — 후보 필드 대조용 ──
  if (depFull?.rawMasked) log.info(`[COSOQ02701-RAW ${liveCfg.liveSymbol}] ${scrub(JSON.stringify(depFull.rawMasked))}`);
  logCrossWon('STARTUP-CROSS-WON', startupPrice);   // 후보필드별 수량 + [CROSS-WON-CHECK]
  const startupCashOk = depOk;

  // P0-10: 최종 체크리스트 출력(먼저 계산 — 실주문 가능여부 판정에 US_LIVE_READY 반영, P0-20 #12)
  const p0 = computeUSP0Checklist(liveCfg);
  log.info(`[P0-CHECKLIST]\n${formatUSP0Checklist(p0)}`);

  // ── P0-20 #12: "실주문 가능" 은 최종 게이트 결과와 일치해야 한다 ──
  // 실주문 능력(config-level) = LIVE_TRADING && US_LIVE_READY && CROSS_WON_VERIFIED && 시작현금조회 && 취소모드(수동 허용).
  const canExec = canExecuteLive(true, liveCfg.liveTrading, { manualCancel: liveCfg.manualCancel, cancelEnvConfirmed: liveCfg.cancelConfirmed }).execute;
  const liveCapable = canExec && p0.US_LIVE_READY && liveCfg.crossWonVerified && startupCashOk;
  if (!liveCfg.crossWonVerified) log.warn(`[P0-20] CROSS_WON_VERIFIED=false(kill-switch 또는 코드상수 미확정) → 통합증거금 경로 비활성 → US BUY 차단.`);

  log.info(`[P0] US_LIVE_READY=${p0.US_LIVE_READY} · CROSS_WON_VERIFIED=${liveCfg.crossWonVerified} · 시작현금조회=${startupCashOk} · LS_LIVE_TRADING=${liveCfg.liveTrading} → 오늘 미국장 ${liveCapable ? '실주문 가능(paymentMode=CROSS_WON)' : `실주문 차단${liveCfg.liveTrading ? '' : '(LS_LIVE_TRADING=false)'}`}`);
  log.info(`[LIVE-CFG] 대상=${liveCfg.liveExchange}:${liveCfg.liveSymbol}(exchcd=${liveCfg.liveExchcd}) 1회거래예산=${liveCfg.perTradeBudgetUsd == null ? '미설정(fail-closed)' : `${liveCfg.perTradeBudgetUsd}USD`} maxQty상한=${liveCfg.maxQty ?? '없음(예산결정)'} 하루매수=${liveCfg.dailyMaxBuys} 하루매도=${liveCfg.dailyMaxSells} 미체결타임아웃=${liveCfg.pendingTimeoutSec}s`);
  log.info(`ARMED=${armedMode} · LS_LIVE_TRADING=${liveCfg.liveTrading} · US_LIVE_READY=${p0.US_LIVE_READY} · CROSS_WON_VERIFIED=${liveCfg.crossWonVerified} · 취소TR확인(env)=${liveCfg.cancelConfirmed}/(코드)=false → 실주문 ${liveCapable ? '가능' : '차단'}`);
  // 시작 시점 US-LIVE-GATE(가격 미확보면 PROGRAM_QTY=0 — GSH 수신 후 재출력)
  if (depFull) log.info(formatUSLiveGate(liveCfg.liveSymbol, { liveTrading: liveCfg.liveTrading, usLiveReady: p0.US_LIVE_READY, crossWonVerified: liveCfg.crossWonVerified, e: evaluateCrossWon(depFull, startupPrice, liveCfg.htsOrderableQty) }));

  // ── 계좌 주문이벤트(AS0~AS4) 추적 저장 — 계좌 단위(전 종목). 재시작 시 원주문번호 기준 복원 ──
  const evStore = new OrderStore('__account_events__');
  evStore.load();
  const tracker = evStore.trackedMap();
  if (evStore.corrupt) log.error('[ACCT] 주문이벤트 저장 파일 손상 → 상태추적 복원 실패, 새로 시작');
  else if (tracker.size) log.info(`[ACCT] 주문상태 ${tracker.size}건 복원(원주문번호 기준)`);

  // ── WebSocket 연결 (시세 GSC/GSH + 계좌 AS0~AS4) ──
  let crossWonLiveGlobalDone = false;   // 최초 bestAsk 수신 시 계정 단위 CROSS-WON 1회 재계산(P0-23)
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
      // P0-19/23 #2: 최초 유효 bestAsk>0 수신 직후(구독 종목 무관, 계정 단위 CROSS-WON) 1회 자동 재계산
      if (!crossWonLiveGlobalDone && q.bestAsk > 0) {
        crossWonLiveGlobalDone = true; ctx.crossWonLiveDone = true;
        void runCrossWonLive(ctx);
      }
    },
    onStatus: (m) => log.info(`[WS] ${scrub(m)}`),
    // req 1: close code/reason/wasClean/lastRegister/connectedDurationMs 반드시 로그
    onClose: (i) => log.error(`[WS-CLOSE] code=${i.code ?? '-'} reason=${scrub(i.reason) || '-'} wasClean=${i.wasClean ?? '-'} lastRegister=${i.lastRegister || '-'} connectedDurationMs=${i.connectedDurationMs} dataReceived=${i.dataReceived}`),
    onError: (i) => log.error(`[WS-ERROR] ${scrub(i.message)}`),
    // req 2: 소켓 open 만으로 LIVE 아님 — 첫 GSC/GSH 데이터 수신 시 LIVE_WS_READY=true
    onDataReady: () => log.info(`[WS-READY] LIVE_WS_READY=true (첫 GSC/GSH 데이터 수신, 등록응답 정상)`),
  }, {
    accountEvents: usAccountEvents,          // AS0~AS4 계좌 이벤트 등록(env 로 격리 테스트 가능)
    deferAccountEvents: usDeferAccountEvents, // 첫 데이터 수신 후 AS 등록(원인 격리, req 3)
  });
  log.info(`[BOOT-STEP] 8 ws-connect (${usOk.length}종목)`);
  client.connect(usOk.map(s => ({ exchcd: s.exchcd, symbol: s.symbol })));

  // P0-27a: COSAQ00102 "자료없음(정상 빈 조회)" rsp_cd 는 실계정 실측 확인분만 등록(추측 금지, fail-closed).
  //   기본 없음 → unknown 업무코드는 BUSINESS_ERROR 로 차단. 실측([US-RECON-DIAG]) 후 이 env 에 콤마구분 추가.
  // P0-27b: COSAQ00102 "자료없음" 기본 EMPTY 코드=02679(실계정 실측 확정) 는 라이브러리 기본 적용(env 없어도).
  //   추가 코드는 LS_US_ORDEREXEC_EMPTY_CODES 로 병합. 여전히 rows=0+정상 envelope 일 때만 EMPTY 통과.
  const ordExecEmptyCodes = (process.env.LS_US_ORDEREXEC_EMPTY_CODES || '').split(',').map((s: string) => s.trim()).filter(Boolean);
  log.info(`[US-RECON-CFG] COSAQ00102 EMPTY 코드=기본[${LS_US_ORDEREXEC_EMPTY_CODES.join(',')}]${ordExecEmptyCodes.length ? ` + env[${ordExecEmptyCodes.join(',')}]` : ''} (SUCCESS/EMPTY 만 POST 허용, EMPTY 는 rows=0+정상 envelope 조건). unknown non-00000 = BUSINESS_ERROR 차단.`);
  const traderDeps: TraderDeps = {
    place: (pp) => placeLSUSBuyOrder(cfg, token, pp),
    query: (pp) => queryLSUSOrderExec(cfg, token, pp, { emptyCodes: ordExecEmptyCodes }),
    cancel: (pp) => cancelLSUSOrder(cfg, token, pp),
    // 현금 주문가능금액 — 확정 경로(USD현금)만. 타통화+원화 선환전은 실측확인 전까지 제외(cash-only, 레버리지 절대 미사용).
    cashOrderable: async () => {
      try { const d = await getLSUSDeposit(cfg, token); return { ok: d.ok, cash: usCashOnlyUsdCap(d, { crossWonVerified: liveCfg.crossWonVerified }) }; }
      catch (e) { log.warn(`[US] 현금 주문가능금액 조회 실패: ${scrub(String(e))}`); return { ok: false, cash: 0 }; }
    },
    now: () => Date.now(),
    log: (m) => log.info(scrub(m)),
  };

  // ── P0-27a req1: 시작 시 COSAQ00102 실계정 조회를 "주문 전송 없이" 1회 실행 → 오늘 주문 0건 상태의 실제 응답 계측 ──
  //   실제 rsp_cd/rsp_msg/OutBlock 존재/rows 수/classification 을 [US-RECON-DIAG] 로 남긴다(추측 금지·실측 확보용).
  //   LS_US_RECON_DIAG=false 로 끌 수 있음(기본 실행). ⚠️ 읽기전용 — 주문 함수 호출 안 함.
  if (process.env.LS_US_RECON_DIAG !== 'false') {
    const diagExchcd = liveCfg.liveExchcd || '82';
    const diagOrdDate = etDateStr(Date.now());
    try {
      const q = await queryLSUSOrderExec(cfg, token, { exchcd: diagExchcd, symbol: liveCfg.liveSymbol, ordDate: diagOrdDate }, { emptyCodes: ordExecEmptyCodes });
      log.info(`[US-RECON-DIAG ${liveCfg.liveSymbol}] rsp_cd=${q.rspCd} rsp_msg=${scrub(q.rspMsg)} queryOk=${q.queryOk} classification=${q.classification} hasEnvelope=${q.hasEnvelope} outBlock3=${q.hasEnvelope ? '존재' : '없음'} rawRows=${q.rows.length} httpStatus=${q.httpStatus ?? '-'}${q.kind ? ` kind=${q.kind}` : ''} ordDate=${diagOrdDate} exchcd=${diagExchcd} (주문 없음)`);
      if (q.classification === 'BUSINESS_ERROR') log.warn(`[US-RECON-DIAG] ⚠️ 위 rsp_cd=${q.rspCd} 가 "정상 자료없음" 임이 LS 응답구조로 확인되면 LS_US_ORDEREXEC_EMPTY_CODES 에 추가해야 POST 허용됨(현재 fail-closed 차단). 확인 전 실거래 시 이 종목 BUY 는 RECONCILIATION_FAILED 로 차단.`);
    } catch (e) { log.error(`[US-RECON-DIAG] 조회 예외(무시): ${scrub(String(e))}`); }
  }

  // ── P0-26: 과거 확정봉 백필 — READY 풀 가속 ──────────────────────────────
  //   중앙 단일 REST 큐(동시 REST 금지) + rate limiter 로 g3203 개인 1req/s 절대 미초과.
  //   우선순위(요구 3): 현재 WS 배치 중 confirmed<20 → 20에 가장 가까운 종목 → 로테이션 풀 나머지.
  //   이미 20+ 확정봉(AAPL/TSLA/BA 등)은 백필하지 않음(요구 1·3). WS/주문과 별도(요구 9 — WS 는 REST 예산 무관).
  const bfReqPerSec = Math.max(1, parseInt(process.env.LS_US_HISTORY_REQ_PER_SEC || '1', 10) || 1);   // g3203 개인=1/법인=10
  const bfRl = new RateLimiter(bfReqPerSec);
  const bfStats = new BackfillStats();
  const bfFailed = new Map<string, number>();      // symbol → 실패/빈응답 백오프 만료 ms(요구 7)
  const BF_FAIL_BACKOFF_MS = 5 * 60_000;           // 실패 5분 후 재시도(큐 뒤로)
  const bfConfirmedCache = new Map<string, number>();   // 로테이션 풀 종목 저장 확정봉수 캐시(디스크 재로딩 최소화)
  let pauseBackfill = false;                        // BUY 게이트 중 REST 예산 양보(요구 9)
  let bfCursor = 0;                                 // 로테이션 풀 순회 커서(현 WS 배치 외 종목)

  // 로테이션 풀 종목의 저장 확정봉수(캐시). 손상 파일은 백필 제외 위해 >=20 으로 취급.
  function poolConfirmed(symbol: string): number {
    const cached = bfConfirmedCache.get(symbol);
    if (cached != null) return cached;
    const st = new CandleStore(symbol); st.load();
    const n = st.corrupt ? BACKFILL_MIN_CONFIRMED : st.confirmedCount;
    bfConfirmedCache.set(symbol, n);
    return n;
  }
  // 우선순위 2: 현 WS 배치 외 로테이션 풀에서 confirmed<20 첫 종목(커서 순회, 백오프 제외).
  function pickPoolBackfillTarget(now: number): { symbol: string; exchcd: string } | null {
    const n = fullPool.length;
    for (let i = 0; i < n; i++) {
      const idx = (bfCursor + i) % n;
      const s = fullPool[idx];
      if (ctxs.has(s.symbol)) continue;                     // 현 배치는 우선순위1(ctx)에서 처리
      if ((bfFailed.get(s.symbol) ?? 0) > now) continue;    // 백오프 중
      if (poolConfirmed(s.symbol) >= BACKFILL_MIN_CONFIRMED) continue;   // 이미 READY
      bfCursor = (idx + 1) % n;
      return { symbol: s.symbol, exchcd: s.exchcd };
    }
    return null;
  }

  // REST g3203 1회 백필. 반환 true=실제 REST 호출 수행(1req/s 페이싱됨), false=대상 없음/양보(루프는 짧게 대기).
  async function backfillOne(): Promise<boolean> {
    if (!quote.delaygb) return false;   // delaygb 미설정 → REST 불가(WS 로만 진행)
    const now = Date.now();
    // 우선순위 1: 현재 WS 배치(ctxs) 중 confirmed<20 (요구 3).
    const ctxMap = new Map<string, SymCtx>();
    const ctxCands: BackfillCand[] = [];
    for (const c of ctxs.values()) {
      if (c.store.corrupt) continue;
      if (c.builder.confirmedCount >= BACKFILL_MIN_CONFIRMED) continue;
      ctxMap.set(c.symbol, c);
      ctxCands.push({ symbol: c.symbol, confirmed: c.builder.confirmedCount, failedUntilMs: bfFailed.get(c.symbol) ?? 0 });
    }
    const ctxTargetSym = pickBackfillTarget(ctxCands, now);
    let target: { symbol: string; exchcd: string } | null = null;
    if (ctxTargetSym) { const cx = ctxMap.get(ctxTargetSym)!; target = { symbol: cx.symbol, exchcd: cx.exchcd }; }
    else target = pickPoolBackfillTarget(now);   // 우선순위 2: 로테이션 풀 나머지
    if (!target) return false;                    // 백필 대상 없음(전부 READY/백오프)

    await bfRl.acquire();                          // g3203 개인 1req/s 준수(양보 대기 후 실제 페이싱)
    if (pauseBackfill || shuttingDown) return false;   // 대기 중 BUY 게이트 진입/종료 → 이번 요청 양보

    const cx = ctxs.get(target.symbol);
    const store = cx ? cx.store : (() => { const st = new CandleStore(target.symbol); st.load(); return st; })();
    if (store.corrupt) { bfStats.error++; bfFailed.set(target.symbol, Date.now() + BF_FAIL_BACKOFF_MS); return true; }
    // 기존 보유 timestamp(store 가 진실원, 오름차순). 신규 unique 판정 기준.
    const existingTs = store.confirmedSorted().map(c => c.datetime);
    const before = existingTs.length;
    const storeOldest = existingTs[0] ?? '';   // 가장 오래된 보유 봉(과거방향 조회 기준, P0-28 req3·4)
    const gap = Math.max(0, BACKFILL_MIN_CONFIRMED - before);
    bfStats.requests++;
    try {
      let fetched: Array<{ datetime: string; open: number; high: number; low: number; close: number; volume: number }>;
      let rawRows: number; let contPages: number;
      let responseNewest = ''; let responseOldest = ''; let olderThanStoreOldest = 0;
      let mode: 'OLDER' | 'BOOTSTRAP';

      if (storeOldest) {
        // ── P0-28: storeOldest 보다 오래된 확정봉을 edate 과거이동으로 조회(공식 sdate/edate 만 사용) ──
        mode = 'OLDER';
        const want = Math.max(BACKFILL_TARGET - before, gap + 2, 6);
        const r = await getLSUS15MinOlderThan(cfg, token, target.symbol, target.exchcd, quote.delaygb, {
          beforeYmdHms: storeOldest, target: want, maxCalls: 8, ncnt: 15, lookbackDays: 10,
        });
        fetched = r.candles.map(c => ({ datetime: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
        rawRows = r.pages.reduce((a, p) => a + p.rawCount, 0);
        contPages = r.calls;
        responseNewest = r.responseNewest; responseOldest = r.responseOldest; olderThanStoreOldest = r.olderCount;
        // req4: 요청 기준시각 로그. req5: 응답 newest/oldest/olderThanStoreOldest 로그.
        const pageDiag = r.pages.map((p, i) => `c${i + 1}(edate=${p.edate},rows=${p.rawCount},older+${p.olderAdded})`).join(' ');
        log.info(`[US-BACKFILL-REQ ${target.symbol}] storeOldest=${storeOldest} requestEdateFirst=${r.requestEdateFirst} requestSdate=${r.requestSdate} calls=${r.calls} ${pageDiag}`);
        log.info(`[US-BACKFILL-RESP ${target.symbol}] responseNewest=${responseNewest || '-'} responseOldest=${responseOldest || '-'} olderThanStoreOldest=${olderThanStoreOldest} (storeOldest=${storeOldest})`);
      } else {
        // ── 최초 부트스트랩(보유 0): 최근 창을 시드 ──
        mode = 'BOOTSTRAP';
        const r = await getLSUS15MinPaged(cfg, token, target.symbol, target.exchcd, quote.delaygb, { target: BACKFILL_TARGET, maxCalls: 6, ncnt: 15, sdate });
        fetched = r.candles.map(c => ({ datetime: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
        rawRows = r.pages.reduce((a, p) => a + p.rawCount, 0);
        contPages = r.pages.length;
        const dts = fetched.map(c => c.datetime).sort();
        responseNewest = dts[dts.length - 1] ?? ''; responseOldest = dts[0] ?? '';
        log.info(`[US-BACKFILL-REQ ${target.symbol}] storeOldest=(없음·부트스트랩) mode=BOOTSTRAP calls=${contPages}`);
      }

      const delta = computeBackfillDelta(existingTs, fetched.map(c => c.datetime));   // ← rawRows 아닌 newUnique(store 에 없던 것)

      if (fetched.length === 0) {
        bfStats.empty++;
        bfFailed.set(target.symbol, Date.now() + BF_FAIL_BACKOFF_MS);
        log.warn(`[US-BACKFILL] symbol=${target.symbol} before=${before} rawRows=0 newUnique=0 after=${before} remaining=${gap} calls=${contPages} responseNewest=- responseOldest=- olderThanStoreOldest=${olderThanStoreOldest} stopReason=EMPTY_RESPONSE`);
        return true;
      }
      // req6: OLDER 모드에서 storeOldest 보다 오래된 봉이 0 이면(=과거로 못 감) 성공 아님. newUnique=0 도 진전 없음.
      const noProgress = delta.newUnique === 0 || (mode === 'OLDER' && olderThanStoreOldest === 0);
      if (noProgress) {
        bfStats.noNewUnique++;
        bfFailed.set(target.symbol, Date.now() + BF_FAIL_BACKOFF_MS);   // 진전 없음 → 백오프 후 다음 종목(무한루프 금지)
        const stopReason = mode === 'OLDER' && olderThanStoreOldest === 0 ? 'NO_OLDER_THAN_STORE_OLDEST' : 'NO_NEW_UNIQUE';
        log.warn(`[US-BACKFILL] symbol=${target.symbol} before=${before} rawRows=${rawRows} newUnique=${delta.newUnique} after=${before} remaining=${gap} calls=${contPages} responseNewest=${responseNewest || '-'} responseOldest=${responseOldest || '-'} olderThanStoreOldest=${olderThanStoreOldest} stopReason=${stopReason} → 백오프`);
        return true;
      }
      // 신규 unique 확정봉만 저장/반영(중복 재수집 금지). 즉시 영구 저장(req4).
      let dirty = false;
      for (const c of fetched) if (store.upsertConfirmed(c)) dirty = true;
      if (dirty) store.flush();
      if (cx) cx.builder.seed(fetched);   // 현 배치 → 실시간 ctx 즉시 병합(before>=19 시 20 도달 → 즉시 READY, req7)
      const after = cx ? cx.builder.confirmedCount : store.confirmedCount;
      bfConfirmedCache.set(target.symbol, after);
      bfStats.success++;
      const remaining = Math.max(0, BACKFILL_MIN_CONFIRMED - after);
      const ready = after >= BACKFILL_MIN_CONFIRMED;
      if (ready) bfFailed.delete(target.symbol);
      else bfFailed.set(target.symbol, Date.now() + Math.min(BF_FAIL_BACKOFF_MS, 60_000));   // 아직 부족 → 짧은 간격 후 재시도
      const stopReason = ready ? 'READY(20+)' : 'PARTIAL(추가 필요)';
      // req8 형식 유지 + P0-28 필드(responseNewest/oldest/olderThanStoreOldest) 추가.
      log.info(`[US-BACKFILL] symbol=${target.symbol} before=${before} rawRows=${rawRows} newUnique=${delta.newUnique} after=${after} remaining=${remaining} calls=${contPages} responseNewest=${responseNewest || '-'} responseOldest=${responseOldest || '-'} olderThanStoreOldest=${olderThanStoreOldest} mode=${mode} stopReason=${stopReason}`);
    } catch (e) {
      bfStats.error++;
      bfFailed.set(target.symbol, Date.now() + BF_FAIL_BACKOFF_MS);
      log.warn(`[US-BACKFILL] symbol=${target.symbol} before=${before} stopReason=ERROR 실패(무시, 백오프): ${scrub(String(e))}`);
    }
    return true;
  }

  // 반환: 이 틱의 결과 사유(거래 0건 분류용, req 9).
  async function evaluateArmed(ctx: SymCtx, sig: { action: string; candleDatetime: string }, now: number): Promise<keyof typeof noTradeCounts | 'ORDERED' | 'LIVE_OFF'> {
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
    let orderQty = 0;                       // P0-29A: 예산기반 최종 주문수량(0 = 미확정/차단)
    const isBuySignal = sig.action === 'BUY' && ctx.builder.confirmedCount >= MIN_RT_CANDLES;
    if (isBuySignal) {
      await refreshDeposit(true);          // BUY 직전 강제 재조회(P0-17 #4,#6 / P0-18 #9 재검증)
      // 통합증거금(타통화+원화, 채택=WonCashMin) 경로: BUY 직전 재조회로 cash-only·가능수량 재확인(P0-20).
      const crossWon = depFull ? evaluateCrossWon(depFull, buyPrice, liveCfg.htsOrderableQty) : null;
      // 확정경로(USD현금) 또는 통합증거금 경로(qty>=1 && cashOnly) 중 하나라도 최소1주 결제 허용이면 통과.
      const cashPathOk = usOrderAllowed(buyPrice).allowed || !!(crossWon && crossWon.orderAllowed);
      // P0-29A: 실제 주문수량 산정 — 1회 거래예산 기반. 예산 미설정이면 fail-closed(allowed=false).
      //   orderableQty = floor(cashOnlyUsdCap / bestAsk), finalQty = min(orderableQty, floor(예산/bestAsk)).
      const qtyDec = computeUSOrderQty({ perTradeBudgetUsd: liveCfg.perTradeBudgetUsd, cashOnlyUsdCap: depCash, bestAsk: buyPrice, maxQty: liveCfg.maxQty });
      log.info(formatUSOrderQty(ctx.symbol, qtyDec, { perTradeBudgetUsd: liveCfg.perTradeBudgetUsd, cashOnlyUsdCap: depCash, bestAsk: buyPrice }));
      orderQty = qtyDec.finalQty;
      // 최종 게이트: 현금경로 허용 AND 예산기반 수량 산정 성공(전량매수 금지·예산 미설정 fail-closed).
      orderableQtyOk = cashPathOk && qtyDec.allowed;
      logUSCashDiag('BUY-US-CASH', buyPrice);              // BUY 직전 상세 진단(P0-16)
      logCrossWon('BUY-CROSS-WON', buyPrice);              // BUY 직전 통합증거금 실측대조(P0-18)
      if (crossWon) log.info(formatUSLiveGate(ctx.symbol, { liveTrading: liveCfg.liveTrading, usLiveReady: computeUSP0Checklist(liveCfg).US_LIVE_READY, crossWonVerified: liveCfg.crossWonVerified, e: crossWon }));   // [US-LIVE-GATE] BUY 직전 최종(P0-20 #13)
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
    if (!g.armed) {
      // 거래 0건 사유 분류(req 9): 우선순위 pending > dailyLimit > duplicate > cash > no-signal
      if (pending) return 'PENDING';
      if (!ctx.orders.canBuyToday(etDate, liveCfg.dailyMaxBuys)) return 'DAILY_LIMIT';
      if (ctx.orders.hasOrderedCandle(sig.candleDatetime, 'buy')) return 'DUPLICATE_CANDLE';
      if (sig.action !== 'BUY') return 'NO_BUY_SIGNAL';
      if (!orderableQtyOk) return 'CASH_GATE';
      return 'NO_BUY_SIGNAL';
    }

    const live = canExecuteLive(g.armed, liveCfg.liveTrading, { manualCancel: liveCfg.manualCancel, cancelEnvConfirmed: liveCfg.cancelConfirmed });
    if (!live.execute) { log.info(`[ARMED-READY ${ctx.symbol}] 전 10개 조건 충족 · 매수지정가=${buyPrice}(ask) · 주문 없음 — ${live.reason}`); return 'LIVE_OFF'; }
    // P0-29A 방어: 예산기반 최종수량이 1주 미만이면 주문 금지(전량매수/예산 미설정 fail-closed 이중 확인).
    if (!(orderQty >= 1)) { log.warn(`[US-ORDER-QTY-BLOCK ${ctx.symbol}] finalQty=${orderQty} (예산 미설정/현금 부족) → 주문 차단`); return 'CASH_GATE'; }
    // 도달 시 trader 가 한도/중복/미체결/현금 재검증.
    const outcome = await executeBuyOrder(traderDeps, {
      orders: ctx.orders, exchcd: ctx.exchcd, symbol: ctx.symbol, candleDatetime: sig.candleDatetime,
      qty: orderQty, price: buyPrice, etDate, dailyMaxBuys: liveCfg.dailyMaxBuys,
    });
    log.info(`[ORDER-RESULT ${ctx.symbol}] status=${outcome.status} ordNo=${outcome.ordNo ?? '-'}${outcome.abortCode ? ` abortCode=${outcome.abortCode}` : ''} ${outcome.reason}`);
    if (outcome.status === 'placed-filled' || outcome.status === 'placed-pending') return 'ORDERED';
    // 실제 사유별 분류(P0-27 req8): reconciliation 실패를 CASH_GATE 로 오분류하지 않는다.
    switch (outcome.abortCode) {
      case 'RECONCILIATION_FAILED': case 'UNRECORDED_ORDER': return 'RECONCILIATION_FAILED';
      case 'PENDING': return 'PENDING';
      case 'DAILY_LIMIT': return 'DAILY_LIMIT';
      case 'DUPLICATE_CANDLE': return 'DUPLICATE_CANDLE';
      default: return 'CASH_GATE';
    }
  }

  // ── 10초마다 전 구독종목 스캔 → BUY 후보 랭킹 → 랭킹 1위부터 LIVE 게이트 (P0-23, AAPL 하드코딩 제거) ──
  let ticking = false;
  let scanCycle = 0;
  let accountBoughtDate: string | null = null;   // 하루 BUY 1회는 '계정 전체' 기준(요구 11)
  const iv = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const etDate = etDateStr(now);
      if (accountBoughtDate && accountBoughtDate !== etDate) accountBoughtDate = null;   // 날짜 변경 → 리셋
      const wsReady = client.connected && client.dataReady;
      const inSession = isUSRegularSession(now);
      scanCycle++;
      let readyCount = 0; let warmupCount = 0; let processed = 0;
      // 후보(요구 9): symbol/exchcd/candleDatetime + 순위재료(거래대금/유동성/BB강도/RSI강도)
      const buyCands: Array<{ symbol: string; exchcd: string; candleDatetime: string; tradingValue: number; volume: number; bbBreakStrength: number; rsiReboundStrength: number }> = [];

      const ctxList = [...ctxs.values()];   // 스냅샷 — 로테이션(ctxs 교체)과 tick 이 겹쳐도 안전
      for (const ctx of ctxList) {
        processed++;
        const r = evaluateReadiness({
          websocketConnected: wsReady, lastGSCatMs: ctx.lastGSCat, lastGSHatMs: ctx.lastGSHat,
          lastPrice: ctx.lastPrice, bestBid: ctx.bestBid, bestAsk: ctx.bestAsk,
          confirmedCount: ctx.builder.confirmedCount, storeCorrupted: ctx.store.corrupt,
        }, now);
        if (r.ready) readyCount++;
        if (r.warmup) warmupCount++;
        log.info(`[READY ${ctx.symbol}] READY=${r.ready} warmup=${r.warmup}${r.warmup ? ` remaining=${r.warmupRemaining}` : ''} confirmed=${ctx.builder.confirmedCount}/${MIN_RT_CANDLES} socketOpen=${client.connected} dataReady=${client.dataReady} LIVE_WS_READY=${wsReady} wsAttempt=${client.attemptCount} bid=${ctx.bestBid || '-'} ask=${ctx.bestAsk || '-'}${r.reasons.length ? ` | ${r.reasons.join(', ')}` : ''}`);
        const sig = observeSignal(log, ctx, r.warmup, r.warmupRemaining);
        // 미체결 조정(모든 구독종목) — pending 있으면 신규 금지, 취소TR 미확인이면 유지(req15)
        if (ctx.orders.hasPending() && liveCapable) {
          const rec = await reconcilePending(traderDeps, { orders: ctx.orders, exchcd: ctx.exchcd, ordDate: etDate, timeoutMs: liveCfg.pendingTimeoutSec * 1000, autoCancel: liveCfg.autoCancel });
          for (const o of rec) log.info(`[RECONCILE ${ctx.symbol}] ordNo=${o.ordNo} ${o.status} — ${o.reason}`);
        }
        // BUY 후보 수집(전략 불변 · warmup 종료 · GSC/GSH 신선 · 세션 · dataReady 일 때만)
        if (sig?.action === 'BUY' && !r.warmup && r.allowSignal && inSession && wsReady && !r.stale) {
          const confirmed = ctx.builder.confirmedCandles();
          const closes = confirmed.map(c => c.close); const dts = confirmed.map(c => c.datetime);
          const bands = calcBB(closes, dts, 20, 2); const rsi = calcRSI(closes, 14);
          const lastC = confirmed[confirmed.length - 1]; const lower = bands[bands.length - 1]?.lower ?? 0;
          const vol = lastC?.volume ?? 0; const px = ctx.lastPrice || lastC?.close || 0;
          buyCands.push({ symbol: ctx.symbol, exchcd: ctx.exchcd, candleDatetime: sig.candleDatetime, tradingValue: px * vol, volume: vol, bbBreakStrength: bbBreakStrength(lastC.low, lastC.close, lower), rsiReboundStrength: rsiReboundStrength(rsi) });
        }
      }

      log.info(`[US-SCAN] cycle=${scanCycle} processed=${processed} remaining=0 ready=${readyCount} warmup=${warmupCount} session=${inSession} wsReady=${wsReady}`);

      // ── P0-26 백필 진행/READY 풀 상태(요구 8·12) — 현 배치 ready/warming + 로테이션 대기 ──
      const poolQueued = Math.max(0, fullPool.length - ctxs.size);
      log.info(`[US-READY-POOL] ready=${readyCount} warming=${warmupCount} queued=${poolQueued}(로테이션 대기) · 풀=${fullPool.length}${quote.delaygb ? '' : ' (백필 비활성: delaygb 미설정)'}`);
      log.info(`[US-BACKFILL-RATE] ${bfStats.line(bfReqPerSec)}`);
      const bfCap = computeBackfillCapacity({ eligible: fullPool.length, alreadyReady: readyCount, reqPerSec: bfReqPerSec });
      // req9: 이론적 최대치(theoretical)와 실측 유효율(actual effective rate)을 분리 표기 — success/requests 로 계산.
      const bfSuccessRate = bfStats.requests > 0 ? bfStats.success / bfStats.requests : 0;
      const effSymbolsPerHour = Math.round(bfCap.symbolsPerHour * bfSuccessRate);
      log.info(`[US-BACKFILL-CAPACITY] THEORETICAL: toBackfill=${bfCap.toBackfill} 종목/시간=${bfCap.symbolsPerHour} (호출/종목=${bfCap.callsPerSymbol}, ${bfCap.candlesPerRequest}봉/요청, target=${BACKFILL_TARGET})`);
      log.info(`[US-BACKFILL-EFFECTIVE] ACTUAL: successRate=${(bfSuccessRate * 100).toFixed(1)}%(${bfStats.success}/${bfStats.requests}) 유효처리=${effSymbolsPerHour}종목/시간 · noNewUnique=${bfStats.noNewUnique} empty=${bfStats.empty} error=${bfStats.error} ⚠️실측 유효율 기준(이론치 아님)`);

      // ── 후보 랭킹 → 랭킹 1위부터 LIVE 게이트(요구 9·10·11) ──
      let tickReason = 'NO_BUY_SIGNAL';
      if (!inSession) tickReason = 'MARKET_CLOSED';
      else if (!wsReady) tickReason = 'WS_NOT_READY';
      else if (buyCands.length) {
        const ranked = rankBuyCandidates(buyCands.map(c => ({ shcode: c.symbol, tradingValue: c.tradingValue, volume: c.volume, bbBreakStrength: c.bbBreakStrength, rsiReboundStrength: c.rsiReboundStrength })));
        log.info(`[US-SIGNAL] BUY candidates=${ranked.length}`);
        log.info(`[US-RANK] ` + ranked.slice(0, 5).map(c => `${c.rank} symbol=${c.shcode} exchange=${ctxs.get(c.shcode)?.exchange ?? '-'} score=${Math.round(c.score)}`).join(' '));
        const rankedUS = ranked.map(c => ({ symbol: c.shcode, exchcd: ctxs.get(c.shcode)?.exchcd ?? '', rank: c.rank, score: c.score }));
        const sel = selectUSLiveCandidate(rankedUS, (sym) => {
          const cx = ctxs.get(sym);
          return { warmedUp: !!cx && cx.builder.confirmedCount >= MIN_RT_CANDLES, hasPending: !!cx && cx.orders.hasPending(), dailyExhausted: accountBoughtDate === etDate };
        });
        if (accountBoughtDate === etDate) tickReason = 'DAILY_LIMIT';
        else if (!sel) tickReason = 'NO_ELIGIBLE_CANDIDATE';
        else if (armedMode) {
          const selCtx = ctxs.get(sel.symbol)!; const selCand = buyCands.find(c => c.symbol === sel.symbol)!;
          log.info(`[US-LIVE-SELECT] 랭킹1위 실거래 대상 symbol=${sel.symbol}(exchcd=${sel.exchcd}) — AAPL 하드코딩 아님`);
          // 요구 9: BUY 게이트 REST(예수금 재조회/주문/미체결) 동안 백필 REST 예산 양보(주문 판단 비차단).
          pauseBackfill = true;
          try { tickReason = await evaluateArmed(selCtx, { action: 'BUY', candleDatetime: selCand.candleDatetime }, Date.now()); }
          finally { pauseBackfill = false; }
          if (tickReason === 'ORDERED') accountBoughtDate = etDate;
        } else tickReason = 'NOT_ARMED';
      }
      if (Object.prototype.hasOwnProperty.call(noTradeCounts, tickReason)) bumpNoTrade(tickReason as keyof typeof noTradeCounts);
      const counts = Object.entries(noTradeCounts).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' ');
      log.info(`[NO-TRADE-COUNTS] 이번틱=${tickReason} · 누적: ${counts || '없음'}`);
    } finally { ticking = false; }
  }, 10_000);

  // ── P0-24: WS 배치 로테이션 — 첫 30개에 고정되지 않고 전체 풀을 순환 구독 ──
  const rotateSec = Math.max(60, Math.min(7200, parseInt(process.env.LS_US_WS_ROTATE_SEC || '600', 10) || 600));
  let rotating = false;
  const rotateIv = rotationSyms.length <= rotateBatchSize ? null : setInterval(() => {
    if (rotating) return;   // 중복 로테이션 방지. tick 은 ctxs 스냅샷으로 순회하므로 겹쳐도 안전.
    rotating = true;
    try {
      // 안전: 현재 배치에 미체결이 있으면 감시 유지를 위해 이번 로테이션 보류.
      for (const c of ctxs.values()) if (!c.store.corrupt && c.orders.hasPending()) { log.warn('[US-WS-ROTATE] 미체결 존재 → 이번 로테이션 보류(감시 유지)'); return; }
      // 형성봉 저장(현재 배치) 후 다음 배치로 교체.
      for (const c of ctxs.values()) { if (c.store.corrupt) continue; try { const f = c.builder.formingCandle(); c.store.setForming(f ? toStored(f) : null); c.store.flush(); } catch { /* noop */ } }
      const next = makeBatch();   // 상시구독(AAPL/TSLA/BA) + 다음 로테이션 슬라이스
      rotateBatchNo = rotateBatchNo % batchCount + 1;
      log.info(`[US-WS-ROTATE] batch=${rotateBatchNo}/${batchCount} (${next.length}종목, 상시=${alwaysOn.length}) symbols=${next.slice(0, 10).map(s => s.symbol).join(',')}${next.length > 10 ? ' …' : ''}`);
      ctxs.clear();
      for (const s of next) ctxs.set(s.symbol, seedStoredCtx(s));
      usOk = next;
      client.connect(usOk.map(s => ({ exchcd: s.exchcd, symbol: s.symbol })));   // 새 배치 재구독(P0-21 client 가 이전 소켓 정리)
    } finally { rotating = false; }
  }, rotateSec * 1000);
  if (rotateIv) log.info(`[US-WS-ROTATE] 로테이션 활성 — ${rotateSec}s 마다 다음 ${rotateBatchSize}종목 로테이션(총 ${batchCount}배치, 상시구독 ${alwaysOn.length} 제외)`);
  else log.info(`[US-WS-ROTATE] 로테이션 대상(${rotationSyms.length}) ≤ 로테이션 배치(${rotateBatchSize}) → 로테이션 불필요(전 종목 상시 구독)`);

  // ── 정상 종료(SIGINT/SIGTERM): 형성봉 저장 후 종료 ──
  let shuttingDown = false;
  const shutdown = (sigName: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(iv);
    if (rotateIv) clearInterval(rotateIv);
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

  // ── P0-26: 백필 백그라운드 루프 — 중앙 단일 큐(동시 REST 없음). WS/주문과 독립(별도 전송, 요구 9) ──
  if (quote.delaygb) {
    void (async () => {
      while (!shuttingDown) {
        if (pauseBackfill) { await new Promise(r => setTimeout(r, 500)); continue; }   // BUY 게이트 중 → 양보
        let did = false;
        try { did = await backfillOne(); }
        catch (e) { log.warn(`[US-BACKFILL] 루프 예외(무시): ${scrub(String(e))}`); await new Promise(r => setTimeout(r, 1000)); continue; }
        if (!did) await new Promise(r => setTimeout(r, 5000));   // 대상 없음/양보 → 5s 후 재확인(핫스핀 방지)
      }
    })();
    log.info(`[US-BACKFILL] 백필 루프 시작 — reqPerSec=${bfReqPerSec}(개인 1/법인 10) · target=${BACKFILL_TARGET}봉/종목 · 중앙 단일 큐 · WS/주문 비차단`);
  } else {
    log.warn(`[US-BACKFILL] 백필 비활성 — delaygb 미설정(${quote.error ?? 'LS_US_DELAYGB'}) → WS 실시간으로만 워밍(가짜봉 없음)`);
  }

  log.info(`지속 실행 중 — 종료하려면 Ctrl+C. READY/OBSERVE/ARMED 는 10초마다 기록됩니다.${armedMode ? ' (ARMED=조건 감시만, 주문 없음)' : ''}`);
  await new Promise(() => { /* SIGINT 까지 유지 */ });
}
main();
