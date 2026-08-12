// 역매공파 실 일봉 취득→캐시 저장 (P0-32C) — 실행: npm run yeokmae:fetch-daily -- KR 005930
//   KR: t8413 DATE_WINDOW 페이징으로 600~800봉 확보 → DailyCache 증분 저장(오늘=진행봉 분리). 주문 없음.
//   US: field map 미확정(봉인) → 취득 금지. `npm run yeokmae:probe-us-daily` 로 조합 실측 먼저.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached, resolveUSQuote } from './ls-client';
import { loadUSSymbols } from './universe';
import { makeScrubber } from './mask';
import { fetchKRDaily } from './yeokmae/kr-daily';
import { fetchUSDaily } from './yeokmae/us-daily';
import { DailyCache, type DailyBar } from './yeokmae-daily-cache';
import { validateDailyIntegrity, evaluateYeokmaeHistoryReadiness, YEOKMAE_MIN_BARS } from '../src/lib/yeokmae';
import type { DailyWindowPage } from './yeokmae/daily-window';

interface CommonFetch {
  ok: boolean; error?: string; sourceTR: string; adjustment: string;
  bars: DailyBar[]; uniqueBars: number; confirmed: number; provisional: number;
  firstDate: string | null; lastDate: string | null; pages: DailyWindowPage[];
}

async function main() {
  loadEnvLocal();
  const log = createLogger('yeokmae-fetch-daily');
  const market = (process.argv[2] || '').toUpperCase();
  const symbol = process.argv[3];
  if (!symbol || (market !== 'KR' && market !== 'US')) {
    log.error('사용법: npm run yeokmae:fetch-daily -- KR 005930   |   npm run yeokmae:fetch-daily -- US AAPL');
    process.exit(1); return;
  }
  log.info('[YEOKMAE-SAFETY] 관찰 전용 · 주문 0 · REAL_ORDER_FROM_YEOKMAE=false');

  let cfg; try { cfg = loadConfig(); } catch (e) { log.error(String(e)); process.exit(1); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); } catch (e) { log.error(`토큰 실패: ${scrub(String(e))}`); process.exit(1); return; }

  const nowMs = Date.now();
  let res: CommonFetch;
  let turnoverNote = '';
  if (market === 'KR') {
    const r = await fetchKRDaily(token, symbol, { nowMs, targetBars: 800 });
    res = r;
    const tu = r.turnoverUnit;
    turnoverNote = `[YEOKMAE-TURNOVER] rawField=value samples=${tu.samples} medianMultiplierToKRW=${tu.medianMultiplier ? Math.round(tu.medianMultiplier) : 'n/a'} unitGuess=${tu.guessLabel} (⚠️ 단위 공식 미확인 — KRW 단정 금지, 검색기 T 는 close×volume(원) 사용)`;
  } else {
    const us = loadUSSymbols();
    const sym = us.ok.find(s => s.symbol === symbol.toUpperCase());
    if (!sym) { log.error(`[YEOKMAE-FETCH] US 종목 미지원/미확인: ${symbol} (universe 에 없음 — exchcd 추측 금지)`); process.exit(2); return; }
    const delaygb = resolveUSQuote().delaygb ?? 'R';
    log.info(`  US 종목 resolve: symbol=${sym.symbol} exchange=${sym.exchange} exchcd=${sym.exchcd} delaygb=${delaygb}`);
    const r = await fetchUSDaily(token, { symbol: sym.symbol, exchcd: sym.exchcd, delaygb }, { nowMs, targetBars: 800 });
    res = r;
    turnoverNote = `[YEOKMAE-TURNOVER] rawField=amount (⚠️ US amount 통화/단위 공식 미확인 — KRW 변환/turnoverKRW 단정 금지. rawTurnover 로만 보존)`;
  }
  if (!res.ok) { log.error(`[YEOKMAE-FETCH] 취득 실패: ${res.error}`); process.exit(2); return; }

  // 캐시 증분 저장
  const cache = new DailyCache(market as 'KR' | 'US', symbol); cache.load();
  if (cache.corrupt) { log.error(`[YEOKMAE-FETCH] 기존 캐시 손상: ${cache.file}`); process.exit(2); return; }
  const { added, total } = cache.upsert(res.bars, { sourceTR: res.sourceTR, adjustment: res.adjustment as any, fetchedAtISO: new Date(nowMs).toISOString() });
  cache.flush();

  for (const p of res.pages) {
    log.info(`  [PAGE ${p.page}] req=${p.requestSdate}~${p.requestEdate} rows=${p.rows} first=${p.firstDate} last=${p.lastDate} newUnique=${p.newUnique} tr_cont='${p.resTrCont}' tr_cont_key='${p.resTrContKey}' body_cts='${p.bodyCursor}' cumUnique=${p.cumulativeUnique} dup=${p.duplicates}`);
  }
  const integ = validateDailyIntegrity(res.bars);
  const ready = evaluateYeokmaeHistoryReadiness(cache.toCandles(), cache.body?.confirmedThrough);

  log.info('[YEOKMAE-FETCH]');
  log.info(`  market=${market}`);
  log.info(`  symbol=${symbol}`);
  log.info(`  sourceTR=${res.sourceTR} adjustment=${res.adjustment}`);
  log.info(`  uniqueBars=${res.uniqueBars}`);
  log.info(`  confirmed=${res.confirmed}`);
  log.info(`  provisional=${res.provisional}`);
  log.info(`  firstDate=${res.firstDate}`);
  log.info(`  lastDate=${res.lastDate}`);
  log.info(`  cacheAdded=${added} cacheTotal=${total} confirmedThrough=${cache.body?.confirmedThrough} provisionalDate=${cache.body?.provisionalDate ?? '없음'}`);
  log.info(`  integrity=${integ.valid ? 'OK' : 'FAIL'} errors=${integ.errors.length}${integ.errors.length ? ' ['+integ.errors.slice(0,5).join(',')+']' : ''} warnings=${integ.warnings.length}`);
  log.info(turnoverNote);
  log.info(`  ℹ️ adjustment=${res.adjustment} — 수정주가 정확성은 분할종목 실측 대조 전까지 flag.`);

  if (res.uniqueBars < YEOKMAE_MIN_BARS) {
    log.warn(`[YEOKMAE-FETCH] INSUFFICIENT_HISTORY — uniqueBars=${res.uniqueBars} < ${YEOKMAE_MIN_BARS}. windowDays 확대/추가 페이지 필요.`);
    process.exit(3); return;
  }
  const lastConfirmed = cache.body?.confirmedThrough ?? res.lastDate;
  log.info(`[YEOKMAE-FETCH] OK — ${symbol} ${ready.reason} (has600=${ready.has600} hasWarmup=${ready.hasWarmup}). 다음: npm run yeokmae:diag -- ${symbol} ${lastConfirmed} ${market}`);
}
main();
