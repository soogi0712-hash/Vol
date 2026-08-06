// LS 해외 실시간(WebSocket GSC/GSH) 관찰 러너 — 실행: npm run ls:usws
// GSC(체결)로 실시간 15분봉 생성 + 로컬 영구 저장/복원, GSH(호가)로 지정가 재료 수집.
// 지속 실행형: Ctrl+C(SIGINT) 까지 계속 돈다. 확정봉은 즉시 디스크에 저장, 재시작 시 복원.
// ⚠️ 주문 없음(관찰 전용). LS_LIVE_TRADING 과 무관하게 주문 함수는 호출하지 않는다(Phase 3 금지).
import { loadEnvLocal } from './env';
import { createLogger, type Logger } from './logger';
import { loadConfig, getTokenCached, resolveUSQuote } from './ls-client';
import { loadUSSymbols } from './universe';
import { makeScrubber } from './mask';
import { getLSUS15Min } from '../src/lib/ls-api';
import {
  LSUSRealtimeClient, RealtimeCandleBuilder, buildWsTrKey, evaluateReadiness, MIN_RT_CANDLES,
  type RTCandle,
} from './ls-us-websocket';
import { CandleStore, type StoredCandle } from './candle-store';
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
  lastGSCat: number | null;
  lastPrice: number;
}

// 확정봉 ≥20 이면 BB(20,2)/RSI(14)/getBBSignal 로 신호 계산 → OBSERVE 로그만(주문 금지, req 9).
function observeSignal(log: Logger, ctx: SymCtx): void {
  const confirmed = ctx.builder.candles(true);   // 형성봉 제외
  if (confirmed.length < MIN_RT_CANDLES) return;
  const closes = confirmed.map(c => c.close);
  const qv = validateCandleData(closes, MIN_RT_CANDLES, 20, 0.001);
  if (!qv.valid) { log.warn(`[US:${ctx.symbol}] 신호검증 스킵 — ${qv.reason} (${qv.detail})`); return; }
  const bands = calcBB(closes, confirmed.map(c => c.datetime), 20, 2);
  const rsi = calcRSI(closes, 14);
  const sig = getBBSignal(bands, false, false, rsi);   // 관찰: 보유/상단돌파 상태 없음
  // ⚠️ 신호가 BUY/SELL 이어도 주문 함수는 호출하지 않는다 — 로그만.
  log.info(`[OBSERVE US:${ctx.exchange}:${ctx.symbol}] signal=${sig.action} reason=${sig.reason} 확정봉=${confirmed.length} 현재가=${ctx.lastPrice || '-'} rsi=${rsi.at(-1)?.toFixed(1) ?? '-'} (주문 없음)`);
}

async function main() {
  loadEnvLocal();
  const log = createLogger('ls-usws');
  log.info('===== LS 해외 실시간(WebSocket GSC/GSH) 관찰 — 지속 실행형, 주문 없음 =====');

  let cfg;
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
    const builder = new RealtimeCandleBuilder();
    const ctx: SymCtx = { symbol: s.symbol, exchange: s.exchange, exchcd: s.exchcd, builder, store, lastGSCat: null, lastPrice: 0 };
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

    // REST 초기 시드(가능 시). 실패는 WS 를 막지 않는다(req 5).
    if (quote.delaygb) {
      try {
        const r = await getLSUS15Min(cfg, token, s.symbol, s.exchcd, quote.delaygb, sdate, 120);
        builder.seed(r.candles.map(c => ({ datetime: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })));
        log.info(`[US:${s.symbol}] REST g3203 시드 ${r.candles.length}개 (rsp_cd='${r.rspCd}') → 병합 후 확정봉=${builder.candles(true).length}`);
        // REST 로 새로 확보된 확정봉도 저장(손상 아니면). 형성봉 제외.
        if (!store.corrupt) {
          let dirty = false;
          for (const c of builder.candles(true)) if (store.upsertConfirmed(toStored(c))) dirty = true;
          if (dirty) store.flush();
        }
      } catch (e) { log.warn(`[US:${s.symbol}] REST 시드 실패(무시, WS 로 진행): ${scrub(String(e))}`); }
    } else {
      log.warn(`[US:${s.symbol}] REST 시드 생략(${quote.error ?? 'delaygb 미설정'}) — WS 실시간으로만 집계`);
    }
  }

  // ── WebSocket 연결 ──
  const client = new LSUSRealtimeClient(token, {
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
    onGSH: (q) => log.info(`[GSH ${q.symbol}] bid=${q.bestBid}(${q.bidRem}) ask=${q.bestAsk}(${q.askRem})`),
    onStatus: (m) => log.info(`[WS] ${scrub(m)}`),
  });
  client.connect(us.ok.map(s => ({ exchcd: s.exchcd, symbol: s.symbol })));

  // ── 10초마다 readiness + OBSERVE ──
  const iv = setInterval(() => {
    for (const ctx of ctxs.values()) {
      const confirmedCount = ctx.builder.candles(true).length;
      const r = evaluateReadiness({ lastGSCatMs: ctx.lastGSCat, lastPrice: ctx.lastPrice, candleCount: confirmedCount }, Date.now());
      // 저장 파일 손상 시 신규매수 금지(req 4) — readiness 와 별개로 강제 차단.
      const allowNewBuy = r.allowNewBuy && !ctx.store.corrupt;
      const extra = ctx.store.corrupt ? ' [저장손상→신규매수 차단]' : '';
      log.info(`[READY ${ctx.symbol}] ready=${r.ready} stale=${r.stale} 신규매수허용=${allowNewBuy} 보유매도허용=${r.allowSellExisting} 확정봉=${confirmedCount}${extra} ${r.reasons.join(', ')}`);
      observeSignal(log, ctx);
    }
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

  log.info('지속 실행 중 — 종료하려면 Ctrl+C. READY/OBSERVE 는 10초마다 기록됩니다.');
  await new Promise(() => { /* SIGINT 까지 유지 */ });
}
main();
