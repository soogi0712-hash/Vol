// 국내(KOSPI+KOSDAQ) 전 종목 라운드로빈 스캔 자동매매 러너 — 실행: npm run ls:kr-scan  (P0-22)
// LS 공식 종목마스터(t8436)로 전 종목 로드 → eligibility 필터 → 라운드로빈 배치 스캔(초당 전송한도 준수)
//   → 15분봉(t8412) BB(20,2)+RSI(14) 재평가 → BUY 후보 순위 → 상위부터 실거래 게이트 적용.
// ⚠️ 기존 전략(BB/RSI)·안전장치(현금만/pending차단/동일봉중복금지/현금재확인/하루한도)는 그대로 유지.
//    거래대금 상위 N 컷으로 유니버스를 자르지 않는다(요구 7). 같은 15분 확정봉은 재조회/재평가 안 함(요구 6).
import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvLocal } from './env';
import { createLogger, type Logger } from './logger';
import { loadConfig, getTokenCached, type LocalLSConfig } from './ls-client';
import { makeScrubber } from './mask';
import {
  getLSKR15Min, getLSKRStockMaster, classifyChart, getLSKRBalance,
  placeLSKRBuyOrder, queryLSKROrderExec, cancelLSKRBuyOrder, krIsuNo, LS_KR_BNS_BUY,
  resolveKRMbrNo, LSApiError,
} from '../src/lib/ls-api';
import { OrderStore } from './order-store';
import { isKRRegularSession, krDateStr } from './trade-gate';
import { executeKRBuyOrder, reconcileKRPending, type KRTraderDeps } from './kr-trader';
import { calcBB, calcRSI, getBBSignal, validateCandleData } from '../src/lib/bollinger';
import { loadKRUniverse } from './kr-universe';
import { RateLimiter, computeScanCapacity } from './kr-rate-limiter';
import { RoundRobinScanner, ConfirmedCandleCache, passesPrefilter, rankBuyCandidates, bbBreakStrength, rsiReboundStrength, krConfirmedBucket, newKRNoTradeCounts, formatKRNoTradeCounts, type BuyCandidate } from './kr-scanner';

const MIN_CONFIRMED = 40;   // 기존 전략 조건 유지
const CANDLE_PERIOD_SEC = 900;
const KR_STORE_DIR = resolve(process.cwd(), 'local-runner', 'data');
type Scrub = (s: string) => string;

const intEnv = (name: string, def: number, min: number, max: number): number => {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};

// 기존에 상태파일이 있는 KR 종목만 시작 시 복원(대량 유니버스에서 전 종목 store 즉시 생성 회피).
function existingKRStoreSymbols(): string[] {
  if (!existsSync(KR_STORE_DIR)) return [];
  const out: string[] = [];
  for (const f of readdirSync(KR_STORE_DIR)) {
    const m = /^us-orders-KR_([A-Za-z0-9]+)\.json$/.exec(f);
    if (m) out.push(m[1]);
  }
  return out;
}

async function main() {
  loadEnvLocal();
  const log = createLogger('ls-kr-scan');
  log.info('===== LS 국내(KR) 전 종목 라운드로빈 스캔 러너 (P0-22) =====');

  let cfg: LocalLSConfig;
  try { cfg = loadConfig(); } catch (e) { log.error(String(e)); process.exit(1); return; }
  const acct = { appKey: cfg.appKey, appSecret: cfg.appSecret };
  const scrub0 = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); }
  catch (e) { log.error(`토큰 실패: ${scrub0(String(e))}`); process.exit(1); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret, token, cfg.accountNo]);

  const live = cfg.liveTrading;
  const legacyBbLive = process.env.LEGACY_BB_LIVE_ENABLED === 'true';   // P0-32: 기본 false → BB BUY 후보수집 차단
  const maxQty = 1;                                          // 상한 1 강제
  const dailyMaxBuys = intEnv('LS_KR_DAILY_MAX_BUYS', 1, 0, 1);
  const mbrNo = resolveKRMbrNo(process.env.LS_KR_MBR_NO).value;   // P0-35P8: 공용 resolver(PILOT 과 동일)
  const pendingTimeoutSec = intEnv('LS_KR_PENDING_TIMEOUT_SEC', 120, 10, 1800);
  const reqPerSec = intEnv('LS_KR_SCAN_REQ_PER_SEC', 1, 1, 10);   // 개인=1, 법인=3 (env 주입)
  const batchSize = intEnv('LS_KR_SCAN_BATCH', 50, 1, 500);
  const includeEtf = process.env.LS_KR_INCLUDE_ETF === 'true';
  log.info(`모드: ${live ? 'LIVE' : 'OBSERVE/DRY-RUN'} · reqPerSec=${reqPerSec} batchSize=${batchSize} includeEtf=${includeEtf} dailyMaxBuys=${dailyMaxBuys} MbrNo=${mbrNo}`);
  log.info(`[YEOKMAE-SAFETY] LEGACY_BB_LIVE=${legacyBbLive} (P0-32: 기본 false → 기존 BB/RSI BUY 후보수집 차단. 역매공파는 별도 일봉엔진, 이 15분 스캐너에 미연결)`);

  const deps: KRTraderDeps = {
    place: (p) => placeLSKRBuyOrder(acct, token, p),
    queryExec: (p) => queryLSKROrderExec(acct, token, p),
    cancel: (p) => cancelLSKRBuyOrder(acct, token, p),
    cashOrderable: async () => {
      try { const b = await getLSKRBalance(acct, token); return { ok: true, cash: b.orderableCash }; }
      catch (e) { log.warn(`[KR] 주문가능현금 조회 실패: ${scrub(String(e))}`); return { ok: false, cash: 0 }; }
    },
    now: () => Date.now(),
    log: (m) => log.info(scrub(m)),
  };

  // ── 1) 유니버스 로드(t8436 KOSPI+KOSDAQ) + eligibility 필터 ──
  const uni = await loadKRUniverse(acct, token, getLSKRStockMaster, { includeEtf });
  const exSummary = Object.entries(uni.excludedByReason).map(([k, v]) => `${k}=${v}`).join(' ');
  log.info(`[KR-UNIVERSE] total=${uni.total} eligible=${uni.eligible.length} excluded=${uni.excluded} (${exSummary || '없음'}) · KOSPI=${uni.perMarket.KOSPI} KOSDAQ=${uni.perMarket.KOSDAQ} · ${uni.rspNote}`);
  if (uni.eligible.length === 0) { log.error('[KR-UNIVERSE] eligible 0 — 종목마스터 조회 실패/필터 과다. 종료.'); process.exit(1); return; }

  // ── 스캔 용량/성능 보고(요구 5·12) ──
  const cap = computeScanCapacity(uni.eligible.length, reqPerSec, batchSize, CANDLE_PERIOD_SEC);
  log.info(`[KR-CAPACITY] reqPerSec=${cap.reqPerSec} batchSize=${cap.batchSize} 전체1순환=${cap.fullCycleSec}s(${(cap.fullCycleSec / 60).toFixed(1)}분) 15분주기내최대평가=${cap.symbolsPerCandle}종목 15분내전종목평가가능=${cap.coversWithinCandle}`);
  if (!cap.coversWithinCandle) {
    const cycleMin = cap.fullCycleSec / 60;
    const missRatio = Math.max(0, 1 - 15 / cycleMin);   // 15분봉 대비 순환주기 초과분 = 놓치는 신호 비율(근사)
    log.warn(`[KR-CAPACITY] ⚠️ 현재 rate(${cap.reqPerSec}/s)로는 eligible ${cap.eligible} 종목을 15분 주기 안에 전부 평가 불가(약 ${cycleMin.toFixed(1)}분 순환). 법인계정(3/s) 또는 LS_KR_SCAN_REQ_PER_SEC 상향 필요. 라운드로빈으로 커서를 이어가며 순차 커버.`);
    log.warn(`[KR-CAPACITY] ⚠️ 구조적 신호누락: 순환주기(${cycleMin.toFixed(1)}분) > 15분봉 주기 → 각 종목은 평균 ${(cycleMin / 15).toFixed(1)}개 확정봉마다 1회만 평가됨. BB하단복귀+RSI 는 단일봉 순간이벤트라 약 ${Math.round(missRatio * 100)}%의 BUY 셋업이 스캔에 관측되지 않음(전략 완화 아님·샘플링 한계). 대책: reqPerSec↑(법인) 또는 유니버스 사전축소(거래대금/유동성 상위, 단 요구7 준수) 또는 15분→더 긴 주기 재검토.`);
  }

  // ── 상태 저장(lazy) + 재시작 복원 ──
  const stores = new Map<string, OrderStore>();
  const storeOf = (shcode: string): OrderStore => {
    let st = stores.get(shcode);
    if (!st) { st = new OrderStore(`KR_${shcode}`); st.load(); stores.set(shcode, st); }
    return st;
  };
  for (const shcode of existingKRStoreSymbols()) {
    const st = storeOf(shcode);
    if (st.corrupt) log.error(`[KR:${shcode}] 상태파일 손상 → 해당 종목 실주문 차단`);
    else if (st.hasPending()) log.info(`[KR:${shcode}] 재시작 복원 — 미체결 ${st.pending.length}건 → 상태 재조회 예정`);
  }

  const scanner = new RoundRobinScanner(uni.eligible.map(r => r.shcode));
  const nameOf = new Map(uni.eligible.map(r => [r.shcode, r.hname]));
  const limiter = new RateLimiter(reqPerSec);
  const cache = new ConfirmedCandleCache();

  // ── KR P0 긴급진단: 거래 0건 원인 단계별 누적 카운터 ──
  const counts = newKRNoTradeCounts();
  const scannedUnique = new Set<string>();        // 오늘 실제 조회한 unique 종목(요구 1)
  const buySignalCodes: string[] = [];            // BUY 발생 종목코드(요구 5)
  const eligibleTotal = uni.eligible.length;
  const countsExtra = () => `uniqueScanned=${scannedUnique.size}/${eligibleTotal} cycles=${scanner.cycles} cursor=${scanner.position} mode=${live ? 'LIVE' : 'DRY-RUN(LS_LIVE_TRADING=false)'}` + (buySignalCodes.length ? ` buyCodes=[${buySignalCodes.slice(0, 20).join(',')}${buySignalCodes.length > 20 ? '…' : ''}]` : '');
  const logCounts = () => log.info(formatKRNoTradeCounts(counts, countsExtra()));

  let shuttingDown = false;
  const shutdown = (sig: string) => {
    if (shuttingDown) return; shuttingDown = true;
    for (const st of stores.values()) { if (!st.corrupt) { try { st.flush(); } catch { /* noop */ } } }
    logCounts();   // 종료 시 최종 거래 0건 진단 카운터(오늘 하루 누적)
    log.info(`러너 종료(${sig}) · 로그: ${log.file}`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ── 라운드로빈 연속 스캔 루프 ──
  let bucket = '';
  let candidates: BuyCandidate[] = [];
  let orderedThisBucket = false;
  let processedInBucket = 0;
  let bucketStartMs = Date.now();
  let idleLogged = false;

  const resetBucket = (nb: string, now: number) => {
    if (bucket) logCounts();   // 직전 확정봉 마감 시점의 누적 카운터 스냅샷
    bucket = nb; candidates = []; orderedThisBucket = false; processedInBucket = 0; bucketStartMs = now;
    log.info(`[KR-CYCLE] 새 확정봉 ${nb} → 스캔 사이클 시작(cursor=${scanner.position}/${scanner.size} cycles=${scanner.cycles})`);
  };

  while (!shuttingDown) {
    const now = Date.now();
    const session = isKRRegularSession(now);
    const krDate = krDateStr(now);
    const nb = krConfirmedBucket(now);
    if (nb !== bucket) resetBucket(nb, now);

    if (!session) {
      if (!idleLogged) { log.info('국내장 시간 아님(09:00~15:30 KST) → 스캔 대기(미체결만 관리)'); idleLogged = true; }
      // 미체결 정리(장 종료 후에도 마무리)
      for (const st of stores.values()) {
        if (st.corrupt || !st.hasPending()) continue;
        const rec = await reconcileKRPending(deps, { orders: st, shcode: st.symbol.replace(/^KR_/, ''), krDate, timeoutMs: pendingTimeoutSec * 1000 });
        for (const o of rec) log.info(`[KR-RECONCILE ${st.symbol}] ordNo=${o.ordNo} ${o.status} — ${scrub(o.reason)}`);
      }
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }
    idleLogged = false;

    // 다음 종목(라운드로빈)
    const shcode = scanner.nextBatch(1)[0];
    if (!shcode) { await new Promise(r => setTimeout(r, 1000)); continue; }

    // 이미 이 확정봉을 평가한 종목이면 재조회/재평가 금지(요구 6)
    if (!cache.shouldEvaluate(shcode, bucket)) {
      // 이 확정봉 전종목 평가 완료 시 과도한 spin 방지 — 커서가 한 바퀴 돌았으면 잠깐 대기
      if (processedInBucket >= scanner.size) { await new Promise(r => setTimeout(r, 2000)); }
      continue;
    }

    // 미체결 있는 종목이면 신규 금지 + 재확인(안전장치 유지)
    const store = storeOf(shcode);
    if (!store.corrupt && store.hasPending()) {
      counts.PENDING++;   // 요구 8: pending 으로 신규 평가 차단
      const rec = await reconcileKRPending(deps, { orders: store, shcode, krDate, timeoutMs: pendingTimeoutSec * 1000 });
      for (const o of rec) log.info(`[KR-RECONCILE ${shcode}] ordNo=${o.ordNo} ${o.status} — ${scrub(o.reason)}`);
      processedInBucket++;
      continue;   // pending 있으면 이번 봉 신규 평가 스킵
    }

    // ── 15분봉 조회(rate limit 준수) → 전략 재평가 ──
    await limiter.acquire();
    counts.SCANNED++; scannedUnique.add(shcode);                   // 요구 1: 조회 시도(에러 포함) 집계
    try {
      const r = await getLSKR15Min(acct, token, shcode, 60);
      processedInBucket++;
      if (classifyChart(r) !== 'OK') { continue; }                 // 요구 2: 조회 실패 → HISTORY_OK 아님
      counts.HISTORY_OK++;
      const closes = r.candles.map(c => c.close);
      const lastClose = closes[closes.length - 1] ?? 0;
      const lastVol = r.candles[r.candles.length - 1]?.volume ?? 0;
      // lightweight prefilter(요구 7) — 거래대금 상위 컷 아님, 기본 유효성만
      if (!passesPrefilter({ lastPrice: lastClose, volume: lastVol, tradingValue: lastClose * lastVol })) { counts.WARMUP++; continue; }
      // 전략(불변): BB(20,2)+RSI(14) — 확정봉<MIN_CONFIRMED 또는 데이터품질 미달이면 평가불가(warmup)
      const qv = validateCandleData(closes, MIN_CONFIRMED, 20, 0.001);
      if (!qv.valid) { counts.WARMUP++; continue; }                // 요구 3: warmup 부족
      const dts = r.candles.map(c => c.datetime);
      const bands = calcBB(closes, dts, 20, 2);
      const rsi = calcRSI(closes, 14);
      const sig = getBBSignal(bands, false, false, rsi);           // 요구 4: 여기까지 오면 전략평가 완료
      // P0-32: 기존 BB/RSI live BUY 는 LEGACY_BB_LIVE_ENABLED(기본 false)일 때만 후보 수집. 기본은 BB BUY 완전 차단.
      if (legacyBbLive && sig.action === 'BUY') {
        counts.BUY_SIGNAL++;                                       // 요구 5
        if (buySignalCodes.length < 200) buySignalCodes.push(shcode);
        const last = r.candles[r.candles.length - 1];
        const lower = bands[bands.length - 1]?.lower ?? 0;
        candidates.push({
          shcode,
          tradingValue: lastClose * lastVol,
          volume: lastVol,
          bbBreakStrength: bbBreakStrength(last.low, last.close, lower),
          rsiReboundStrength: rsiReboundStrength(rsi),
        });
        log.info(`[KR-SIGNAL] BUY 후보 추가 ${shcode}(${nameOf.get(shcode) ?? ''}) 거래대금=${Math.round(lastClose * lastVol)} rsi=${rsi.at(-1)?.toFixed(1)} · 누적후보=${candidates.length}`);
      } else {
        counts.NO_BUY_SIGNAL++;
      }
    } catch (e) {
      if (e instanceof LSApiError) log.warn(`[KR:${shcode}] t8412 ${e.kind} rsp_cd=${e.rspCd ?? '-'}`);
      else log.warn(`[KR:${shcode}] 조회오류: ${scrub(String(e))}`);
    }

    // 진행 로그(요구 11) — batchSize 마다 + 거래 0건 진단 카운터
    if (processedInBucket % batchSize === 0) {
      const cycleElapsedSec = Math.round((Date.now() - bucketStartMs) / 1000);
      log.info(`[KR-SCAN] batch=${Math.ceil(processedInBucket / batchSize)}/${Math.ceil(scanner.size / batchSize)} processed=${processedInBucket} remaining=${Math.max(0, scanner.size - processedInBucket)} cycleElapsedSec=${cycleElapsedSec}`);
      logCounts();
    }

    // ── BUY 후보 순위 + 상위부터 실거래 게이트(요구 9) ──
    if (candidates.length && !orderedThisBucket && dailyMaxBuys > 0) {
      const ranked = rankBuyCandidates(candidates);
      log.info(`[KR-RANK] BUY candidates=${ranked.length} · ` + ranked.slice(0, 5).map(c => `${c.rank} code=${c.shcode}(거래대금=${Math.round(c.tradingValue)})`).join(' '));
      for (const c of ranked) {
        const st = storeOf(c.shcode);
        // 후보별 사전 게이트(요구 6·7·8) — 사유별 카운트(추측 아니라 실제 차단지점 태깅)
        if (st.corrupt) continue;
        if (st.hasPending()) { counts.PENDING++; continue; }
        if (!st.canBuyToday(krDate, dailyMaxBuys)) { counts.DAILY_LIMIT++; continue; }
        if (st.hasOrderedCandle(bucket, 'buy')) { counts.DUPLICATE_CANDLE++; continue; }
        // 주문 직전 현금 재확인은 executeKRBuyOrder(cashOrderable) 내부에서 수행. 지정가 = 최근 종가.
        const px = candidates.find(x => x.shcode === c.shcode);
        const ordPrc = Math.round((px ? px.tradingValue / Math.max(1, px.volume) : 0));
        log.info(`[KR-ORDER-PARAMS ${c.shcode}] IsuNo=${krIsuNo(c.shcode)} qty=${maxQty} price=${ordPrc} BnsTpCode=${LS_KR_BNS_BUY}(매수) OrdprcPtnCode=00(지정가) MgntrnCode=000 MbrNo=${mbrNo} · live=${live} candle=${bucket}`);
        if (!live) { log.info(`[KR-DRY-RUN ${c.shcode}] LS_LIVE_TRADING=false → 주문 API 미호출(POST_ATTEMPT=0, 실거래 아님)`); orderedThisBucket = true; break; }
        if (!(ordPrc > 0)) { counts.CASH_GATE++; continue; }   // 지정가 0 → 주문 불가(가격 미확보)
        try {
          counts.POST_ATTEMPT++;   // 요구 9: 실주문 함수 호출(러너 게이트 통과)
          const outcome = await executeKRBuyOrder(deps, { orders: st, shcode: c.shcode, candleDatetime: bucket, qty: maxQty, price: ordPrc, krDate, mbrNo, dailyMaxBuys });
          log.info(`[KR-ORDER-RESULT ${c.shcode}] status=${outcome.status}${outcome.abortCode ? ` abortCode=${outcome.abortCode}` : ''} ordNo=${outcome.ordNo ?? '-'} ${scrub(outcome.reason)}`);
          if (outcome.status === 'placed-filled' || outcome.status === 'placed-partial' || outcome.status === 'placed-pending') {
            counts.POST_SUCCESS++;                                   // 요구 10: 접수 성공
            if (outcome.status === 'placed-filled') counts.FILLED++; // 전량 체결
            orderedThisBucket = true; break;
          }
          // aborted — 실제 차단 사유별 분류(reconciliation/reject/exception 은 POST_ATTEMPT-POST_SUCCESS 로 가시화)
          switch (outcome.abortCode) {
            case 'CASH_GATE': counts.CASH_GATE++; break;
            case 'DAILY_LIMIT': counts.DAILY_LIMIT++; break;
            case 'PENDING': counts.PENDING++; break;
            case 'DUPLICATE_CANDLE': counts.DUPLICATE_CANDLE++; break;
            default: break;   // RECONCILIATION_FAILED/ORDER_REJECTED/SEND_EXCEPTION/CORRUPT
          }
        } catch (e) { log.error(`[KR:${c.shcode}] 주문 실패(자동 재주문 없음): ${scrub(String(e))}`); }
      }
      logCounts();   // BUY 후보 처리 직후 최신 카운터 스냅샷
    }
  }
}
main();
