// 로컬 트레이드 러너 (Phase 2, 관찰 전용) — 실행: npm run ls:trade
// LS 15분봉(국내 t8412 / 해외 g3203) → 확정봉(형성봉 제외, ≥40) → BB(20,2)/RSI(14)/getBBSignal
// → OBSERVE 로그. 주문은 절대 실행하지 않는다(LS_LIVE_TRADING 게이트 + 주문 미구현 2중 차단).
import { loadEnvLocal } from './env';
import { createLogger, type Logger } from './logger';
import { loadConfig, getTokenCached } from './ls-client';
import { loadKRSymbols, loadUSSymbols } from './universe';
import {
  getLSKR15Min, getLSUS15Min, getLSKRPrice, getLSUSPrice, LSApiError, type LSCandle,
} from '../src/lib/ls-api';
// 유지 대상 엔진 그대로 재사용
import { calcBB, calcRSI, getBBSignal, validateCandleData } from '../src/lib/bollinger';

const MIN_CONFIRMED = 40;   // req 8: 국내·해외 각각 최소 40개 확정봉

function kstYmd(offsetDays = 0): string {
  const k = new Date(Date.now() + 9 * 3600 * 1000 - offsetDays * 86400_000);
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, '0')}${String(k.getUTCDate()).padStart(2, '0')}`;
}

// 오류를 종류별로 구분해 기록 (req 11)
function logErr(log: Logger, market: string, id: string, e: unknown) {
  if (e instanceof LSApiError) {
    const tag = { NETWORK: '네트워크오류', RATE_LIMIT: '호출제한', EMPTY: '빈응답', API: 'API오류', INSUFFICIENT: '데이터부족' }[e.kind];
    log.error(`[${market}:${id}] ${e.kind}(${tag}) ${e.rspCd ? 'rsp_cd=' + e.rspCd + ' ' : ''}${e.message}`);
  } else {
    log.error(`[${market}:${id}] UNKNOWN ${e instanceof Error ? e.message : String(e)}`);
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

  let token: string;
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); }
  catch (e) { logErr(log, 'TOKEN', '-', e); process.exit(1); return; }

  // ── 국내 ──
  const kr = loadKRSymbols();
  log.info(`국내 관찰 종목: ${kr.map(s => s.shcode).join(', ')}`);
  for (const s of kr) {
    try {
      const candles = await getLSKR15Min({ appKey: cfg.appKey, appSecret: cfg.appSecret }, token, s.shcode, 60);
      if (candles.length === 0) { logErr(log, 'KR', s.shcode, new LSApiError('EMPTY', '15분봉 빈 응답')); continue; }
      let price: number | null = null;
      try { price = (await getLSKRPrice({ appKey: cfg.appKey, appSecret: cfg.appSecret }, token, s.shcode)).price; }
      catch (e) { logErr(log, 'KR', s.shcode, e); }
      observeSignal(log, 'KR', s.shcode, candles, price);
    } catch (e) { logErr(log, 'KR', s.shcode, e); }
  }

  // ── 해외 ──
  const us = loadUSSymbols();
  for (const u of us.unsupported) log.warn(`[US:${u.token}] UNSUPPORTED_EXCHANGE (${u.exchange}) — LS exchcd 미확인, 스킵(추측 금지)`);
  log.info(`해외 관찰 종목: ${us.ok.map(s => `${s.exchange}:${s.symbol}`).join(', ')}`);
  const sdate = kstYmd(10);   // 최근 ~10일 범위로 40개 확보
  for (const s of us.ok) {
    try {
      const candles = await getLSUS15Min({ appKey: cfg.appKey, appSecret: cfg.appSecret }, token, s.symbol, s.exchcd, sdate, 120);
      if (candles.length === 0) { logErr(log, 'US', s.symbol, new LSApiError('EMPTY', '15분봉 빈 응답')); continue; }
      let price: number | null = null;
      try { price = (await getLSUSPrice({ appKey: cfg.appKey, appSecret: cfg.appSecret }, token, s.symbol, s.exchcd)).price; }
      catch (e) { logErr(log, 'US', s.symbol, e); }
      observeSignal(log, 'US', `${s.exchange}:${s.symbol}`, candles, price);
    } catch (e) { logErr(log, 'US', s.symbol, e); }
  }

  // ── 주문 경계: 2중 안전장치 ──
  if (cfg.liveTrading) log.error('LS_LIVE_TRADING=true 이지만 주문 기능 미구현 → 주문 실행 안 함(안전 차단).');
  log.info(`orders_submitted=0 (observe_only=${observeOnly}) · 로그: ${log.file}`);
  process.exit(0);
}
main();
