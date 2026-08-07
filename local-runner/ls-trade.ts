// 로컬 트레이드 러너 — 실행: npm run ls:trade
// LS 15분봉(국내 t8412 / 해외 g3203) → 확정봉 → BB(20,2)/RSI(14)/getBBSignal → OBSERVE 로그.
// 국내(KR)는 LIVE 가능 구조: BUY 신호 시 주문 파라미터를 로그로 남기고, LS_LIVE_TRADING=true 이며
// 국내장(09:00~15:30 KST)일 때만 실제 주문(CSPAT00601)을 낸다. 기본값 LS_LIVE_TRADING=false.
import { loadEnvLocal } from './env';
import { createLogger, type Logger } from './logger';
import { loadConfig, getTokenCached, resolveUSQuote, type LocalLSConfig } from './ls-client';
import { loadKRSymbols, loadUSSymbols } from './universe';
import { sanitizeBlocks, makeScrubber } from './mask';
import {
  getLSKR15Min, getLSUS15MinPaged, getLSKRPrice, getLSUSPrice, classifyChart,
  placeLSKRBuyOrder, queryLSKROrderExec, krIsuNo, LS_KR_BNS_BUY,
  LSApiError, type LSCandle, type LSHttpDiag,
} from '../src/lib/ls-api';
import { OrderStore } from './order-store';
import { isKRRegularSession, krDateStr } from './trade-gate';
import { executeKRBuyOrder, reconcileKRPending, type KRTraderDeps } from './kr-trader';
// 유지 대상 엔진 그대로 재사용
import { calcBB, calcRSI, getBBSignal, validateCandleData } from '../src/lib/bollinger';

const MIN_CONFIRMED = 40;   // 국내·해외 각각 최소 40개 확정봉

type Scrub = (s: string) => string;

function kstYmd(offsetDays = 0): string {
  const k = new Date(Date.now() + 9 * 3600 * 1000 - offsetDays * 86400_000);
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, '0')}${String(k.getUTCDate()).padStart(2, '0')}`;
}

// HTTP 원문 진단 로그 (req 1·2·6) — textHead·헤더를 마스킹해 출력
function logHttpDiag(log: Logger, scrub: Scrub, market: string, id: string, tr: string, diag?: LSHttpDiag) {
  if (!diag) { log.warn(`[${market}:${id}] ${tr} HTTP diag 없음`); return; }
  const h = diag.reqHeaders;
  log.info(`[${market}:${id}] ${tr} 요청헤더 tr_cd=${h.tr_cd} tr_cont=${h.tr_cont} tr_cont_key=${h.tr_cont_key} content-type=${h.content_type}`);
  log.info(`[${market}:${id}] ${tr} HTTP status=${diag.status} ${diag.statusText} content-type=${diag.contentType} tr_cont=${diag.trCont} tr_cont_key=${diag.trContKey} textLen=${diag.textLen}`);
  log.info(`[${market}:${id}] ${tr} rawHead(1000, 마스킹)=${scrub(diag.textHead)}`);
}

// 오류를 종류별로 구분해 기록 (req 11) + 원문 진단
function logErr(log: Logger, scrub: Scrub, market: string, id: string, tr: string, e: unknown) {
  if (e instanceof LSApiError) {
    const tag = { NETWORK: '네트워크오류', RATE_LIMIT: '호출제한', EMPTY: '빈응답', API: 'API오류', INSUFFICIENT: '데이터부족', INVALID_RESPONSE: '무효응답' }[e.kind];
    log.error(`[${market}:${id}] ${e.kind}(${tag}) ${e.rspCd ? 'rsp_cd=' + e.rspCd + ' ' : ''}${scrub(e.message)}`);
    logHttpDiag(log, scrub, market, id, tr, e.diag);
  } else {
    log.error(`[${market}:${id}] UNKNOWN ${scrub(e instanceof Error ? e.message : String(e))}`);
  }
}

// 확정봉으로 신호 계산 + OBSERVE 로그. 신호 action + 기준 확정봉 datetime 반환(주문/중복키). 검증 실패면 null.
function observeSignal(log: Logger, market: string, id: string, candles: LSCandle[], price: number | null): { action: string; candleDatetime: string } | null {
  const closes = candles.map(c => c.close);
  const qv = validateCandleData(closes, MIN_CONFIRMED, 20, 0.001);
  if (!qv.valid) {
    log.warn(`[${market}:${id}] 데이터부족/검증실패 — ${qv.reason} (${qv.detail}) 확정봉=${candles.length}`);
    return null;
  }
  const dts = candles.map(c => c.datetime);
  const bands = calcBB(closes, dts, 20, 2);
  const rsi = calcRSI(closes, 14);
  const signal = getBBSignal(bands, false, false, rsi);   // 관찰: 보유/상단돌파 상태 없음
  log.info(`[OBSERVE ${market}:${id}] signal=${signal.action} reason=${signal.reason} 확정봉=${candles.length} 현재가=${price ?? '-'} rsi=${rsi.at(-1)?.toFixed(1) ?? '-'}`);
  return { action: signal.action, candleDatetime: dts[dts.length - 1] };
}

// 국내(KR) LIVE 처리 — BUY 신호 시 주문 파라미터를 모두 로그로 남기고, 조건 충족 + LS_LIVE_TRADING=true
// 일 때만 실제 주문. 미체결이면 신규 차단, 재시작 시 pending 복원(디스크). 실패해도 자동 재주문 없음.
interface KRLiveCfg { live: boolean; maxQty: number; dailyMaxBuys: number; mbrNo: string; }
async function handleKRLive(
  log: Logger, scrub: Scrub, deps: KRTraderDeps, cfg: KRLiveCfg,
  shcode: string, sig: { action: string; candleDatetime: string }, price: number | null,
) {
  const orders = new OrderStore(`KR_${shcode}`);
  orders.load();
  if (orders.corrupt) { log.error(`[KR:${shcode}] 주문상태 파일 손상 → 실주문 차단`); return; }
  const now = Date.now();
  const krDate = krDateStr(now);

  // ① 재시작 복원 + 미체결 재확인(체결조회). 전량체결이면 해소.
  if (orders.hasPending()) {
    const rec = await reconcileKRPending(deps, { orders, shcode, krDate });
    for (const o of rec) log.info(`[KR-RECONCILE ${shcode}] ordNo=${o.ordNo} ${o.status} — ${o.reason}`);
  }
  // ② 미체결 존재 → 신규 주문 차단(req 8)
  if (orders.hasPending()) { log.warn(`[KR:${shcode}] 미체결 주문 존재 → 신규 주문 차단`); return; }

  if (sig.action !== 'BUY') return;
  const session = isKRRegularSession(now);
  const dup = orders.hasOrderedCandle(sig.candleDatetime, 'buy');
  const overLimit = !orders.canBuyToday(krDate, cfg.dailyMaxBuys);
  const qty = Math.min(cfg.maxQty, 1);   // 최대 1주(상한 강제)
  const ordPrc = price != null && price > 0 ? Math.round(price) : 0;   // 지정가(원 정수). 틱 준수는 실주문 전 확인

  // ③ 실제 주문 직전까지 모든 파라미터 로그(req 3)
  log.info(`[KR-ORDER-PARAMS ${shcode}] IsuNo=${krIsuNo(shcode)} qty=${qty} price=${ordPrc} BnsTpCode=${LS_KR_BNS_BUY}(매수) OrdprcPtnCode=00(지정가) MgntrnCode=000 OrdCndiTpCode=0 MbrNo=${cfg.mbrNo} · session(09:00~15:30)=${session} dup=${dup} dailyOver=${overLimit} live=${cfg.live} candle=${sig.candleDatetime}`);

  if (!session) { log.warn(`[KR:${shcode}] 국내장 시간 아님(09:00~15:30 KST) → 주문 스킵`); return; }
  if (dup) { log.warn(`[KR:${shcode}] 동일 확정봉 중복주문 → 스킵`); return; }
  if (overLimit) { log.warn(`[KR:${shcode}] 하루 매수 한도 초과 → 스킵`); return; }
  if (!(ordPrc > 0)) { log.warn(`[KR:${shcode}] 현재가 미확보 → 지정가 산출 불가 → 스킵`); return; }

  // ④ 주문 API 호출은 LS_LIVE_TRADING=true 일 때만(req 4)
  if (!cfg.live) { log.info(`[KR-DRY-RUN ${shcode}] LS_LIVE_TRADING=false → 주문 API 미호출(파라미터만 검증)`); return; }
  try {
    const outcome = await executeKRBuyOrder(deps, { orders, shcode, candleDatetime: sig.candleDatetime, qty, price: ordPrc, krDate, mbrNo: cfg.mbrNo, dailyMaxBuys: cfg.dailyMaxBuys });
    log.info(`[KR-ORDER-RESULT ${shcode}] status=${outcome.status} ordNo=${outcome.ordNo ?? '-'} execQty=${outcome.execQty} ${scrub(outcome.reason)}`);
  } catch (e) { log.error(`[KR:${shcode}] 주문 실패(자동 재주문 없음): ${scrub(String(e))}`); }
}

async function main() {
  loadEnvLocal();
  const log = createLogger('ls-trade');
  log.info('===== LS 트레이드 러너 (Phase 2 관찰 전용) =====');

  let cfg: LocalLSConfig;
  try { cfg = loadConfig(); }
  catch (e) { log.error(String(e)); process.exit(1); return; }

  const observeOnly = !cfg.liveTrading;
  log.info(`모드: ${observeOnly ? 'OBSERVE (KR 주문 미실행)' : 'LIVE (KR 실주문 가능 — 국내장 조건 충족 시)'} · LS_LIVE_TRADING=${cfg.liveTrading}`);

  const acct = { appKey: cfg.appKey, appSecret: cfg.appSecret };
  // 국내 LIVE 설정(기본값: 1주, 하루 1회, MbrNo=NXT[공식 예제값 — 실주문 전 확인])
  const krLive: KRLiveCfg = {
    live: cfg.liveTrading,
    maxQty: Math.max(1, Math.min(1, parseInt(process.env.LS_KR_MAX_QTY || '1', 10) || 1)),
    dailyMaxBuys: Math.max(0, Math.min(1, parseInt(process.env.LS_KR_DAILY_MAX_BUYS || '1', 10))),
    mbrNo: (process.env.LS_KR_MBR_NO || 'NXT').trim().toUpperCase(),
  };
  // 원문 로그 마스킹 스크러버 (앱키/시크릿/토큰/계좌) — req 2
  const scrub: Scrub = (s) => s;   // 토큰 발급 전 임시
  let scrubReady: Scrub = scrub;

  let token: string;
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); }
  catch (e) { logErr(log, scrubReady, 'TOKEN', '-', 'oauth', e); process.exit(1); return; }
  scrubReady = makeScrubber([cfg.appKey, cfg.appSecret, token, cfg.accountNo]);

  // 국내 주문/체결 주입 의존성 (LS_LIVE_TRADING=true 일 때만 place 가 실제 호출됨)
  const krDeps: KRTraderDeps = {
    place: (p) => placeLSKRBuyOrder(acct, token, p),
    queryExec: (p) => queryLSKROrderExec(acct, token, p),
    now: () => Date.now(),
    log: (m) => log.info(scrubReady(m)),
  };

  // ── 국내 (순차 처리, Promise.all 금지) ──
  const kr = loadKRSymbols();
  log.info(`국내 종목: ${kr.map(s => s.shcode).join(', ')} · KR-LIVE maxQty=${krLive.maxQty} 하루매수=${krLive.dailyMaxBuys} MbrNo=${krLive.mbrNo}`);
  for (const s of kr) {
    try {
      const r = await getLSKR15Min(acct, token, s.shcode, 60);
      const status = classifyChart(r);
      if (status !== 'OK') {
        log.warn(`[KR:${s.shcode}] t8412 ${status} — rsp_cd=${r.rspCd} msg=${r.rspMsg} OutBlock1개수=${r.rawCount}`);
        logHttpDiag(log, scrubReady, 'KR', s.shcode, 't8412', r.diag);
        continue;
      }
      let price: number | null = null;
      try { price = (await getLSKRPrice(acct, token, s.shcode)).price; } catch (e) { logErr(log, scrubReady, 'KR', s.shcode, 't1102', e); }
      const sig = observeSignal(log, 'KR', s.shcode, r.candles, price);
      if (sig) await handleKRLive(log, scrubReady, krDeps, krLive, s.shcode, sig, price);
    } catch (e) { logErr(log, scrubReady, 'KR', s.shcode, 't8412', e); }
  }

  // ── 해외 (순차 처리) ──
  const us = loadUSSymbols();
  for (const u of us.unsupported) log.warn(`[US:${u.token}] UNSUPPORTED_EXCHANGE (${u.exchange}) — LS exchcd 미확인, 스킵(추측 금지)`);
  // 해외 시세 구분(delaygb): 미국 실시간은 Non-Display 불가 → 기본 DELAYED. 공식 지연코드는 env.
  const quote = resolveUSQuote();
  if (!quote.delaygb) {
    log.error(`해외 시세 스킵 — ${quote.error}`);
  } else {
    log.info(`해외 시세 구분: mode=${quote.mode} delaygb=${quote.delaygb} · 관찰 종목: ${us.ok.map(s => `${s.exchange}:${s.symbol}`).join(', ')}`);
  }
  const sdate = kstYmd(10);   // 최근 ~10일 범위로 40개 확보
  for (const s of (quote.delaygb ? us.ok : [])) {
    try {
      // 비압축(comp_yn=N, qrycnt=5) 연속조회로 최신 60 확정봉 확보(공식 제한 준수).
      const paged = await getLSUS15MinPaged(acct, token, s.symbol, s.exchcd, quote.delaygb!, { target: 60, maxCalls: 12, ncnt: 15, sdate });
      const r = paged.last;
      if (paged.candles.length === 0) {
        // ── 빈/무효 응답 진단 (req 1·5·6): 원문 HTTP + 요청body + OutBlock(cts) + 연속조회 헤더 ──
        log.warn(`[US:${s.symbol}] g3203 ${classifyChart(r)} — ${paged.calls}회 연속조회 후 확정봉 0`);
        log.warn(`[US:${s.symbol}] g3203 진단 — qrycnt=${(r.reqBody as any).g3203InBlock?.qrycnt} comp_yn=${(r.reqBody as any).g3203InBlock?.comp_yn} ncnt=${(r.reqBody as any).g3203InBlock?.ncnt} 요청tr_cont=${r.diag.reqHeaders.tr_cont} 요청tr_cont_key='${r.diag.reqHeaders.tr_cont_key}' 응답tr_cont=${r.resTrCont} 응답tr_cont_key='${r.resTrContKey}' rec_count=${r.recCount}`);
        logHttpDiag(log, scrubReady, 'US', s.symbol, 'g3203', r.diag);
        log.warn(`[US:${s.symbol}] 요청body=${JSON.stringify(sanitizeBlocks(r.reqBody))}`);
        log.warn(`[US:${s.symbol}] OutBlock(cts 포함)=${JSON.stringify(sanitizeBlocks(r.outBlock))}`);
        // ── req 7: 현재가 g3101 별도 호출로 "차트만 vs 종목 자체 실패" 구분 (price<=0 이면 이제 throw) ──
        try {
          const p = await getLSUSPrice(acct, token, s.symbol, s.exchcd, quote.delaygb!);
          logHttpDiag(log, scrubReady, 'US', s.symbol, 'g3101', p.diag);
          log.warn(`[US:${s.symbol}] 현재가 g3101 OK (price=${p.price}) → 차트(g3203)만 문제`);
        } catch (e) {
          logErr(log, scrubReady, 'US', s.symbol, 'g3101', e);
          log.warn(`[US:${s.symbol}] 현재가 g3101 도 실패 → 종목/거래소/해외시세 이용신청·권한 의심`);
        }
        continue;
      }
      log.info(`[US:${s.symbol}] g3203 연속조회 ${paged.calls}회 → 확정봉 ${paged.candles.length}개`);
      let price: number | null = null;
      try { price = (await getLSUSPrice(acct, token, s.symbol, s.exchcd, quote.delaygb!)).price; } catch (e) { logErr(log, scrubReady, 'US', s.symbol, 'g3101', e); }
      observeSignal(log, 'US', `${s.exchange}:${s.symbol}`, paged.candles, price);
    } catch (e) { logErr(log, scrubReady, 'US', s.symbol, 'g3203', e); }
  }

  // ── 주문 경계 ── 해외(US)는 이 러너에서 주문하지 않는다(관찰만). 국내(KR)만 LIVE 가능.
  log.info(`완료 · KR-LIVE=${cfg.liveTrading ? 'ON(국내장 조건 충족 시 실주문)' : 'OFF(파라미터 로그만)'} · US=관찰전용 · 로그: ${log.file}`);
  process.exit(0);
}
main();
