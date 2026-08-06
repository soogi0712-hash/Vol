// 로컬 트레이드 러너 (Phase 2, 관찰 전용) — 실행: npm run ls:trade
// LS 15분봉(국내 t8412 / 해외 g3203) → 확정봉(형성봉 제외, ≥40) → BB(20,2)/RSI(14)/getBBSignal
// → OBSERVE 로그. 주문은 절대 실행하지 않는다(LS_LIVE_TRADING 게이트 + 주문 미구현 2중 차단).
import { loadEnvLocal } from './env';
import { createLogger, type Logger } from './logger';
import { loadConfig, getTokenCached } from './ls-client';
import { loadKRSymbols, loadUSSymbols } from './universe';
import { sanitizeBlocks, makeScrubber } from './mask';
import {
  getLSKR15Min, getLSUS15Min, getLSKRPrice, getLSUSPrice, classifyChart,
  LSApiError, type LSCandle, type LSHttpDiag,
} from '../src/lib/ls-api';
// 유지 대상 엔진 그대로 재사용
import { calcBB, calcRSI, getBBSignal, validateCandleData } from '../src/lib/bollinger';

const MIN_CONFIRMED = 40;   // req 8: 국내·해외 각각 최소 40개 확정봉

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

// 확정봉으로 신호 계산 + OBSERVE 로그 (주문 없음)
function observeSignal(log: Logger, market: string, id: string, candles: LSCandle[], price: number | null) {
  const closes = candles.map(c => c.close);
  const qv = validateCandleData(closes, MIN_CONFIRMED, 20, 0.001);
  if (!qv.valid) {
    log.warn(`[${market}:${id}] 데이터부족/검증실패 — ${qv.reason} (${qv.detail}) 확정봉=${candles.length}`);
    return;
  }
  const dts = candles.map(c => c.datetime);
  const bands = calcBB(closes, dts, 20, 2);
  const rsi = calcRSI(closes, 14);
  const signal = getBBSignal(bands, false, false, rsi);   // 관찰: 보유/상단돌파 상태 없음
  log.info(`[OBSERVE ${market}:${id}] signal=${signal.action} reason=${signal.reason} 확정봉=${candles.length} 현재가=${price ?? '-'} rsi=${rsi.at(-1)?.toFixed(1) ?? '-'}`);
}

async function main() {
  loadEnvLocal();
  const log = createLogger('ls-trade');
  log.info('===== LS 트레이드 러너 (Phase 2 관찰 전용) =====');

  let cfg;
  try { cfg = loadConfig(); }
  catch (e) { log.error(String(e)); process.exit(1); return; }

  const observeOnly = !cfg.liveTrading;
  log.info(`모드: ${observeOnly ? 'OBSERVE-ONLY (주문 없음)' : 'LIVE 요청됨'} · LS_LIVE_TRADING=${cfg.liveTrading}`);

  const acct = { appKey: cfg.appKey, appSecret: cfg.appSecret };
  // 원문 로그 마스킹 스크러버 (앱키/시크릿/토큰/계좌) — req 2
  const scrub: Scrub = (s) => s;   // 토큰 발급 전 임시
  let scrubReady: Scrub = scrub;

  let token: string;
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); }
  catch (e) { logErr(log, scrubReady, 'TOKEN', '-', 'oauth', e); process.exit(1); return; }
  scrubReady = makeScrubber([cfg.appKey, cfg.appSecret, token, cfg.accountNo]);

  // ── 국내 (순차 처리, Promise.all 금지) ──
  const kr = loadKRSymbols();
  log.info(`국내 관찰 종목: ${kr.map(s => s.shcode).join(', ')}`);
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
      observeSignal(log, 'KR', s.shcode, r.candles, price);
    } catch (e) { logErr(log, scrubReady, 'KR', s.shcode, 't8412', e); }
  }

  // ── 해외 (순차 처리) ──
  const us = loadUSSymbols();
  for (const u of us.unsupported) log.warn(`[US:${u.token}] UNSUPPORTED_EXCHANGE (${u.exchange}) — LS exchcd 미확인, 스킵(추측 금지)`);
  log.info(`해외 관찰 종목: ${us.ok.map(s => `${s.exchange}:${s.symbol}`).join(', ')}`);
  const sdate = kstYmd(10);   // 최근 ~10일 범위로 40개 확보
  for (const s of us.ok) {
    try {
      const r = await getLSUS15Min(acct, token, s.symbol, s.exchcd, sdate, 120);
      const status = classifyChart(r);
      if (status !== 'OK') {
        // ── 빈/무효 응답 진단 (req 1·5·6): 원문 HTTP + 요청body + OutBlock(cts) ──
        log.warn(`[US:${s.symbol}] g3203 ${status} — rsp_cd='${r.rspCd}' msg='${r.rspMsg}' OutBlock1개수=${r.rawCount}`);
        logHttpDiag(log, scrubReady, 'US', s.symbol, 'g3203', r.diag);
        log.warn(`[US:${s.symbol}] 요청body=${JSON.stringify(sanitizeBlocks(r.reqBody))}`);
        log.warn(`[US:${s.symbol}] OutBlock(cts 포함)=${JSON.stringify(sanitizeBlocks(r.outBlock))}`);
        // ── req 7: 현재가 g3101 별도 호출로 "차트만 vs 종목 자체 실패" 구분 (price<=0 이면 이제 throw) ──
        try {
          const p = await getLSUSPrice(acct, token, s.symbol, s.exchcd);
          logHttpDiag(log, scrubReady, 'US', s.symbol, 'g3101', p.diag);
          log.warn(`[US:${s.symbol}] 현재가 g3101 OK (price=${p.price}) → 차트(g3203)만 문제`);
        } catch (e) {
          logErr(log, scrubReady, 'US', s.symbol, 'g3101', e);
          log.warn(`[US:${s.symbol}] 현재가 g3101 도 실패 → 종목/거래소/해외시세 이용신청·권한 의심`);
        }
        continue;
      }
      let price: number | null = null;
      try { price = (await getLSUSPrice(acct, token, s.symbol, s.exchcd)).price; } catch (e) { logErr(log, scrubReady, 'US', s.symbol, 'g3101', e); }
      observeSignal(log, 'US', `${s.exchange}:${s.symbol}`, r.candles, price);
    } catch (e) { logErr(log, scrubReady, 'US', s.symbol, 'g3203', e); }
  }

  // ── 주문 경계: 2중 안전장치 ──
  if (cfg.liveTrading) log.error('LS_LIVE_TRADING=true 이지만 주문 기능 미구현 → 주문 실행 안 함(안전 차단).');
  log.info(`orders_submitted=0 (observe_only=${observeOnly}) · 로그: ${log.file}`);
  process.exit(0);
}
main();
