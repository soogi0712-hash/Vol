// 국내(KR) 자동매매 지속 실행 러너 — 실행: npm run ls:trade
// Asia/Seoul 평일 09:00~15:30 동안 지속 실행. 1분마다 상태 체크(미체결 재확인/타임아웃 취소),
// 국내 15분봉(t8412) 재조회 → BB(20,2)/RSI(14)/getBBSignal 재평가 → 조건 충족 시 CSPAT00601 지정가 매수.
// ⚠️ 해외(US) 조회는 이 러너에서 완전히 제거. 실주문은 signal=BUY + 국내장 + LS_LIVE_TRADING=true 일 때만.
//    동일 15분봉 중복주문 금지, 미체결 시 신규 금지, 취소 확인 전 다음 주문 금지, 하루 매수 1회·maxQty 1.
//    주문 파라미터는 LS 공식 TR 필드만 사용(추측 금지). 기존 전략 조건은 변경하지 않는다.
import { loadEnvLocal } from './env';
import { createLogger, type Logger } from './logger';
import { loadConfig, getTokenCached, type LocalLSConfig } from './ls-client';
import { loadKRSymbols } from './universe';
import { makeScrubber } from './mask';
import {
  getLSKR15Min, getLSKRPrice, classifyChart, getLSKRBalance,
  placeLSKRBuyOrder, queryLSKROrderExec, cancelLSKRBuyOrder, krIsuNo, LS_KR_BNS_BUY,
  resolveKRMbrNo, LSApiError, type LSCandle, type LSHttpDiag,
} from '../src/lib/ls-api';
import { OrderStore } from './order-store';
import { isKRRegularSession, krDateStr } from './trade-gate';
import { executeKRBuyOrder, reconcileKRPending, type KRTraderDeps } from './kr-trader';
// 유지 대상 엔진 그대로 재사용 (전략 조건 불변)
import { calcBB, calcRSI, getBBSignal, validateCandleData } from '../src/lib/bollinger';

const MIN_CONFIRMED = 40;   // 국내 최소 40개 확정봉(기존 전략 조건 유지)
type Scrub = (s: string) => string;

function logHttpDiag(log: Logger, scrub: Scrub, id: string, tr: string, diag?: LSHttpDiag) {
  if (!diag) { log.warn(`[KR:${id}] ${tr} HTTP diag 없음`); return; }
  log.info(`[KR:${id}] ${tr} HTTP status=${diag.status} ${diag.statusText} content-type=${diag.contentType} textLen=${diag.textLen}`);
  log.info(`[KR:${id}] ${tr} rawHead(1000, 마스킹)=${scrub(diag.textHead)}`);
}
function logErr(log: Logger, scrub: Scrub, id: string, tr: string, e: unknown) {
  if (e instanceof LSApiError) {
    const tag = { NETWORK: '네트워크오류', RATE_LIMIT: '호출제한', EMPTY: '빈응답', API: 'API오류', INSUFFICIENT: '데이터부족', INVALID_RESPONSE: '무효응답' }[e.kind];
    log.error(`[KR:${id}] ${e.kind}(${tag}) ${e.rspCd ? 'rsp_cd=' + e.rspCd + ' ' : ''}${scrub(e.message)}`);
    logHttpDiag(log, scrub, id, tr, e.diag);
  } else {
    log.error(`[KR:${id}] UNKNOWN ${scrub(e instanceof Error ? e.message : String(e))}`);
  }
}

// 확정봉으로 신호 계산 + OBSERVE 로그. 신호 action + 기준 확정봉 datetime 반환(주문/중복키). 검증 실패면 null.
// ⚠️ 기존 전략 그대로: BB(20,2)/RSI(14)/getBBSignal, MIN_CONFIRMED=40.
function observeSignal(log: Logger, id: string, candles: LSCandle[], price: number | null): { action: string; candleDatetime: string } | null {
  const closes = candles.map(c => c.close);
  const qv = validateCandleData(closes, MIN_CONFIRMED, 20, 0.001);
  if (!qv.valid) { log.warn(`[KR:${id}] 데이터부족/검증실패 — ${qv.reason} (${qv.detail}) 확정봉=${candles.length}`); return null; }
  const dts = candles.map(c => c.datetime);
  const bands = calcBB(closes, dts, 20, 2);
  const rsi = calcRSI(closes, 14);
  const signal = getBBSignal(bands, false, false, rsi);   // 관찰: 보유/상단돌파 상태 없음
  log.info(`[OBSERVE KR:${id}] signal=${signal.action} reason=${signal.reason} 확정봉=${candles.length} 현재가=${price ?? '-'} rsi=${rsi.at(-1)?.toFixed(1) ?? '-'}`);
  return { action: signal.action, candleDatetime: dts[dts.length - 1] };
}

interface KRLiveCfg { live: boolean; maxQty: number; dailyMaxBuys: number; mbrNo: string; pendingTimeoutSec: number; exitAfterClose: boolean; }

// BUY 처리 — 실제 주문 직전까지 모든 파라미터 로그. 조건 충족 + LS_LIVE_TRADING=true 일 때만 실주문.
// 전제: 호출 전에 미체결 없음 + 국내장 세션 확인됨. 동일봉 중복/하루한도/현재가 확보를 재검증.
async function tryBuy(log: Logger, scrub: Scrub, deps: KRTraderDeps, cfg: KRLiveCfg, store: OrderStore, shcode: string, sig: { action: string; candleDatetime: string }, price: number | null, krDate: string) {
  if (sig.action !== 'BUY') return;
  const dup = store.hasOrderedCandle(sig.candleDatetime, 'buy');
  const overLimit = !store.canBuyToday(krDate, cfg.dailyMaxBuys);
  const qty = Math.min(cfg.maxQty, 1);
  const ordPrc = price != null && price > 0 ? Math.round(price) : 0;

  // 실제 주문 직전까지 모든 파라미터 로그(req 15 포함 — 공식 TR 필드만)
  log.info(`[KR-ORDER-PARAMS ${shcode}] IsuNo=${krIsuNo(shcode)} qty=${qty} price=${ordPrc} BnsTpCode=${LS_KR_BNS_BUY}(매수) OrdprcPtnCode=00(지정가) MgntrnCode=000 OrdCndiTpCode=0 MbrNo=${cfg.mbrNo} · dup=${dup} dailyOver=${overLimit} live=${cfg.live} candle=${sig.candleDatetime}`);
  if (dup) { log.warn(`[KR:${shcode}] 동일 확정봉 중복주문 → 스킵`); return; }
  if (overLimit) { log.warn(`[KR:${shcode}] 하루 매수 한도 초과 → 스킵`); return; }
  if (!(ordPrc > 0)) { log.warn(`[KR:${shcode}] 현재가 미확보 → 지정가 산출 불가 → 스킵`); return; }
  if (!cfg.live) { log.info(`[KR-DRY-RUN ${shcode}] LS_LIVE_TRADING=false → 주문 API 미호출(파라미터만 검증)`); return; }
  try {
    const outcome = await executeKRBuyOrder(deps, { orders: store, shcode, candleDatetime: sig.candleDatetime, qty, price: ordPrc, krDate, mbrNo: cfg.mbrNo, dailyMaxBuys: cfg.dailyMaxBuys });
    log.info(`[KR-ORDER-RESULT ${shcode}] status=${outcome.status} ordNo=${outcome.ordNo ?? '-'} execQty=${outcome.execQty} ${scrub(outcome.reason)}`);
  } catch (e) { log.error(`[KR:${shcode}] 주문 실패(자동 재주문 없음): ${scrub(String(e))}`); }
}

async function main() {
  loadEnvLocal();
  const log = createLogger('ls-trade');
  log.info('===== LS 국내(KR) 자동매매 러너 — 지속 실행형(09:00~15:30 KST) =====');

  let cfg: LocalLSConfig;
  try { cfg = loadConfig(); } catch (e) { log.error(String(e)); process.exit(1); return; }

  const acct = { appKey: cfg.appKey, appSecret: cfg.appSecret };
  const scrub0 = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); }
  catch (e) { log.error(`토큰 실패: ${scrub0(String(e))}`); process.exit(1); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret, token, cfg.accountNo]);

  const krLive: KRLiveCfg = {
    live: cfg.liveTrading,
    maxQty: Math.max(1, Math.min(1, parseInt(process.env.LS_KR_MAX_QTY || '1', 10) || 1)),   // 상한 1 강제
    dailyMaxBuys: Math.max(0, Math.min(1, parseInt(process.env.LS_KR_DAILY_MAX_BUYS || '1', 10))),
    mbrNo: resolveKRMbrNo(process.env.LS_KR_MBR_NO).value,   // P0-35P8: 공용 resolver(PILOT 과 동일)
    pendingTimeoutSec: Math.max(10, Math.min(1800, parseInt(process.env.LS_KR_PENDING_TIMEOUT_SEC || '120', 10) || 120)),
    exitAfterClose: process.env.LS_KR_EXIT_AFTER_CLOSE === 'true',
  };
  log.info(`모드: ${krLive.live ? 'LIVE (국내장 + BUY 신호 시 실주문)' : 'OBSERVE/DRY-RUN (주문 API 미호출)'} · LS_LIVE_TRADING=${cfg.liveTrading}`);

  const deps: KRTraderDeps = {
    place: (p) => placeLSKRBuyOrder(acct, token, p),
    queryExec: (p) => queryLSKROrderExec(acct, token, p),
    cancel: (p) => cancelLSKRBuyOrder(acct, token, p),
    // 현금 주문가능금액 = CSPAQ12200 MnyOrdAbleAmt(orderableCash). 신용/증거금은 사용하지 않는다(req6).
    cashOrderable: async () => {
      try { const b = await getLSKRBalance(acct, token); return { ok: true, cash: b.orderableCash }; }
      catch (e) { log.warn(`[KR] 주문가능현금(MnyOrdAbleAmt) 조회 실패: ${scrub(String(e))}`); return { ok: false, cash: 0 }; }
    },
    now: () => Date.now(),
    log: (m) => log.info(scrub(m)),
  };

  // ── 종목별 OrderStore 1회 생성 + 로드(재시작 시 pending·주문번호 복원, req 12) ──
  const kr = loadKRSymbols();
  const stores = new Map<string, OrderStore>();
  for (const s of kr) {
    const st = new OrderStore(`KR_${s.shcode}`);
    st.load();
    stores.set(s.shcode, st);
    if (st.corrupt) log.error(`[KR:${s.shcode}] 주문상태 파일 손상 → 해당 종목 실주문 차단`);
    else if (st.hasPending()) log.info(`[KR:${s.shcode}] 재시작 복원 — 미체결 ${st.pending.length}건(주문번호 ${st.pending.map(p => p.ordNo).join(',')}) → 상태 재조회 예정`);
  }
  log.info(`국내 종목: ${kr.map(s => s.shcode).join(', ')} · maxQty=${krLive.maxQty} 하루매수=${krLive.dailyMaxBuys} MbrNo=${krLive.mbrNo} 미체결타임아웃=${krLive.pendingTimeoutSec}s`);

  // ── 정상 종료(SIGINT/SIGTERM): 저장 flush 후 종료 (req 16) ──
  let shuttingDown = false;
  let iv: ReturnType<typeof setInterval> | null = null;
  const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (iv) clearInterval(iv);
    for (const st of stores.values()) { if (!st.corrupt) { try { st.flush(); } catch { /* noop */ } } }
    log.info(`러너 종료(${sig}) · 로그: ${log.file}`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ── 1분 틱: 미체결 재확인/타임아웃 취소 → (장중이면) 재조회·신호·주문 ──
  let ticking = false;
  let idleLogged = false;
  const tick = async () => {
    if (ticking || shuttingDown) return;
    ticking = true;
    try {
      const now = Date.now();
      const session = isKRRegularSession(now);
      const krDate = krDateStr(now);
      let anyPending = false;
      for (const s of kr) {
        const store = stores.get(s.shcode)!;
        if (store.corrupt) continue;
        // ① 미체결 재확인(체결/부분/미체결) + 타임아웃 취소 — 장중/장후 무관하게 마무리(req 8·10·11·12)
        if (store.hasPending()) {
          const rec = await reconcileKRPending(deps, { orders: store, shcode: s.shcode, krDate, timeoutMs: krLive.pendingTimeoutSec * 1000 });
          for (const o of rec) log.info(`[KR-RECONCILE ${s.shcode}] ordNo=${o.ordNo} ${o.status} — ${scrub(o.reason)}`);
        }
        // ② 미체결 존재 → 신규 주문 금지(req 9·11)
        if (store.hasPending()) { anyPending = true; log.warn(`[KR:${s.shcode}] 미체결 주문 존재 → 신규 주문 차단`); continue; }
        // ③ 장 종료 15:30 이후 신규 주문 금지(req 17)
        if (!session) continue;
        // ④ 15분봉 재조회 + 신호 재평가 → BUY 시 주문(동일봉 중복은 tryBuy 가 차단, req 4·5·6·7·13·14)
        try {
          const r = await getLSKR15Min(acct, token, s.shcode, 60);
          if (classifyChart(r) !== 'OK') { log.warn(`[KR:${s.shcode}] t8412 ${classifyChart(r)} — rsp_cd=${r.rspCd} OutBlock1=${r.rawCount}`); continue; }
          let price: number | null = null;
          try { price = (await getLSKRPrice(acct, token, s.shcode)).price; } catch (e) { logErr(log, scrub, s.shcode, 't1102', e); }
          const sig = observeSignal(log, s.shcode, r.candles, price);
          if (sig) await tryBuy(log, scrub, deps, krLive, store, s.shcode, sig, price, krDate);
        } catch (e) { logErr(log, scrub, s.shcode, 't8412', e); }
      }
      if (!session) {
        if (!idleLogged) { log.info('국내장 시간 아님(09:00~15:30 KST) → 신규 주문 없음, 미체결만 관리'); idleLogged = true; }
        // req 17: 장 종료 후 미체결이 모두 정리됐고 설정 시 러너 종료(아니면 대기하며 다음 장 재개)
        if (krLive.exitAfterClose && !anyPending) { log.info('장 종료 + 미체결 없음 → 러너 종료(LS_KR_EXIT_AFTER_CLOSE=true)'); shutdown('after-close'); return; }
      } else { idleLogged = false; }
    } finally { ticking = false; }
  };

  await tick();                       // 시작 즉시 1회
  iv = setInterval(tick, 60_000);     // 이후 1분마다(req 5)
  log.info('지속 실행 중 — 종료하려면 Ctrl+C. 1분마다 상태 체크, 15분봉 확정 시 신호 재평가.');
  await new Promise(() => { /* SIGINT 까지 유지 */ });
}
main();
