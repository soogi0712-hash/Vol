// LS 해외 실시간(WebSocket GSC/GSH) 관찰 러너 — 실행: npm run ls:usws
// 종목별 GSC(체결)로 실시간 15분봉 생성, GSH(호가)로 지정가 재료 수집. 주문 없음(관찰 전용).
// 초기 15분봉은 REST g3203 로 시드(가능 시), 이후 GSC 실시간 집계로 확장.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached, resolveUSQuote } from './ls-client';
import { loadUSSymbols } from './universe';
import { makeScrubber } from './mask';
import { getLSUS15Min } from '../src/lib/ls-api';
import {
  LSUSRealtimeClient, RealtimeCandleBuilder, buildWsTrKey, evaluateReadiness,
} from './ls-us-websocket';

function kstYmd(offsetDays = 0): string {
  const k = new Date(Date.now() + 9 * 3600 * 1000 - offsetDays * 86400_000);
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, '0')}${String(k.getUTCDate()).padStart(2, '0')}`;
}

async function main() {
  loadEnvLocal();
  const log = createLogger('ls-usws');
  log.info('===== LS 해외 실시간(WebSocket GSC/GSH) 관찰 — 주문 없음 =====');

  let cfg;
  try { cfg = loadConfig(); } catch (e) { log.error(String(e)); process.exit(1); return; }

  let token: string;
  const scrub0 = makeScrubber([cfg.appKey, cfg.appSecret]);
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); }
  catch (e) { log.error(`토큰 실패: ${scrub0(String(e))}`); process.exit(1); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret, token, cfg.accountNo]);

  const us = loadUSSymbols();
  for (const u of us.unsupported) log.warn(`[US:${u.token}] UNSUPPORTED_EXCHANGE(${u.exchange}) 스킵(추측 금지)`);
  if (!us.ok.length) { log.error('관찰 US 종목 없음 (LS_US_SYMBOLS 확인)'); process.exit(1); return; }

  const builders = new Map<string, RealtimeCandleBuilder>();
  const lastGSCat = new Map<string, number>();
  const lastPrice = new Map<string, number>();

  // ── REST g3203 로 초기 시드 (가능 시). WS 는 별도 tr_key(18자리 패딩) 사용 ──
  const quote = resolveUSQuote();
  const sdate = kstYmd(10);
  for (const s of us.ok) {
    const b = new RealtimeCandleBuilder();
    builders.set(s.symbol, b);
    const trKey = buildWsTrKey(s.exchcd, s.symbol);
    log.info(`[US:${s.symbol}] exchcd=${s.exchcd} trKeyLength=${trKey.length} trKey='${trKey}'`);
    if (quote.delaygb) {
      try {
        const r = await getLSUS15Min(cfg, token, s.symbol, s.exchcd, quote.delaygb, sdate, 120);
        b.seed(r.candles.map(c => ({ datetime: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })));
        log.info(`[US:${s.symbol}] REST g3203 시드 ${r.candles.length}개 (rsp_cd='${r.rspCd}')`);
      } catch (e) { log.warn(`[US:${s.symbol}] REST 시드 실패: ${scrub(String(e))}`); }
    } else {
      log.warn(`[US:${s.symbol}] REST 시드 생략(${quote.error ?? 'delaygb 미설정'}) — WS 실시간으로만 집계`);
    }
  }

  // ── WebSocket 연결 ──
  const client = new LSUSRealtimeClient(token, {
    onGSC: (t) => {
      builders.get(t.symbol)?.addTrade(t.lastPrice, t.tradeQty, t.localTs);
      lastGSCat.set(t.symbol, Date.now());
      lastPrice.set(t.symbol, t.lastPrice);
      log.info(`[GSC ${t.symbol}] price=${t.lastPrice} trdq=${t.tradeQty} totq=${t.cumulativeVolume} localTs=${t.localTs}`);
    },
    onGSH: (q) => log.info(`[GSH ${q.symbol}] bid=${q.bestBid}(${q.bidRem}) ask=${q.bestAsk}(${q.askRem})`),
    onStatus: (m) => log.info(`[WS] ${scrub(m)}`),
  });
  client.connect(us.ok.map(s => ({ exchcd: s.exchcd, symbol: s.symbol })));

  // ── 주기적 readiness 로그 ──
  const iv = setInterval(() => {
    for (const s of us.ok) {
      const b = builders.get(s.symbol)!;
      const r = evaluateReadiness(
        { lastGSCatMs: lastGSCat.get(s.symbol) ?? null, lastPrice: lastPrice.get(s.symbol) ?? 0, candleCount: b.candles(true).length },
        Date.now(),
      );
      log.info(`[READY ${s.symbol}] ready=${r.ready} stale=${r.stale} 신규매수허용=${r.allowNewBuy} 보유매도허용=${r.allowSellExisting} 확정봉=${b.candles(true).length} ${r.reasons.join(', ')}`);
    }
  }, 10_000);

  const seconds = parseInt(process.env.LS_WS_SECONDS || '60', 10) || 60;
  await new Promise((res) => setTimeout(res, seconds * 1000));
  clearInterval(iv);
  client.close();
  log.info(`관찰 종료(${seconds}s) · orders_submitted=0 (LS_LIVE_TRADING=${cfg.liveTrading}, 관찰 전용) · 로그: ${log.file}`);
  process.exit(0);
}
main();
