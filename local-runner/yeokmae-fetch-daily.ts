// 역매공파 실 일봉 취득→캐시 저장 (P0-32C) — 실행: npm run yeokmae:fetch-daily -- KR 005930
//   KR: t8413 DATE_WINDOW 페이징으로 600~800봉 확보 → DailyCache 증분 저장(오늘=진행봉 분리). 주문 없음.
//   US: field map 미확정(봉인) → 취득 금지. `npm run yeokmae:probe-us-daily` 로 조합 실측 먼저.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached } from './ls-client';
import { makeScrubber } from './mask';
import { fetchKRDaily } from './yeokmae/kr-daily';
import { DailyCache } from './yeokmae-daily-cache';
import { validateDailyIntegrity, evaluateYeokmaeHistoryReadiness, YEOKMAE_MIN_BARS } from '../src/lib/yeokmae';

async function main() {
  loadEnvLocal();
  const log = createLogger('yeokmae-fetch-daily');
  const marketArg = (process.argv[2] || '').toUpperCase();
  const symbol = process.argv[3];
  if (!symbol || (marketArg !== 'KR' && marketArg !== 'US')) {
    log.error('사용법: npm run yeokmae:fetch-daily -- KR 005930  (US 는 field map 미확정 → 봉인)');
    process.exit(1); return;
  }
  log.info('[YEOKMAE-SAFETY] 관찰 전용 · 주문 0 · REAL_ORDER_FROM_YEOKMAE=false');

  if (marketArg === 'US') {
    log.warn('[YEOKMAE-FETCH] market=US → US 일봉 TR/field map 미확정(봉인). rows>0 조합 확인 전 취득 금지.');
    log.warn('  → npm run yeokmae:probe-us-daily -- AAPL 로 parameter 조합 실측 후 daily-tr-config.ts(US) 확정.');
    process.exit(2); return;
  }

  let cfg; try { cfg = loadConfig(); } catch (e) { log.error(String(e)); process.exit(1); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); } catch (e) { log.error(`토큰 실패: ${scrub(String(e))}`); process.exit(1); return; }

  const nowMs = Date.now();
  const res = await fetchKRDaily(token, symbol, { nowMs, targetBars: 800 });
  if (!res.ok) { log.error(`[YEOKMAE-FETCH] 취득 실패: ${res.error}`); process.exit(2); return; }

  // 캐시 증분 저장
  const cache = new DailyCache('KR', symbol); cache.load();
  if (cache.corrupt) { log.error(`[YEOKMAE-FETCH] 기존 캐시 손상: ${cache.file}`); process.exit(2); return; }
  const { added, total } = cache.upsert(res.bars, { sourceTR: res.sourceTR, adjustment: res.adjustment, fetchedAtISO: new Date(nowMs).toISOString() });
  cache.flush();

  // pages 요약(연속조회/진전 확인)
  for (const p of res.pages) {
    log.info(`  [PAGE ${p.page}] rows=${p.rows} first=${p.firstDate} last=${p.lastDate} tr_cont='${p.resTrCont}' tr_cont_key='${p.resTrContKey}' body_cts_date='${p.bodyCursor}' cumUnique=${p.cumulativeUnique} dup=${p.duplicates}`);
  }
  const integ = validateDailyIntegrity(res.bars);
  const ready = evaluateYeokmaeHistoryReadiness(cache.toCandles(), cache.body?.confirmedThrough);
  const tu = res.turnoverUnit;

  log.info('[YEOKMAE-FETCH]');
  log.info(`  market=KR`);
  log.info(`  symbol=${symbol}`);
  log.info(`  sourceTR=${res.sourceTR} adjustment=${res.adjustment}`);
  log.info(`  uniqueBars=${res.uniqueBars}`);
  log.info(`  confirmed=${res.confirmed}`);
  log.info(`  provisional=${res.provisional}`);
  log.info(`  firstDate=${res.firstDate}`);
  log.info(`  lastDate=${res.lastDate}`);
  log.info(`  cacheAdded=${added} cacheTotal=${total} confirmedThrough=${cache.body?.confirmedThrough} provisionalDate=${cache.body?.provisionalDate ?? '없음'}`);
  log.info(`  integrity=${integ.valid ? 'OK' : 'FAIL'} errors=${integ.errors.length}${integ.errors.length ? ' ['+integ.errors.slice(0,5).join(',')+']' : ''} warnings=${integ.warnings.length}`);
  log.info(`[YEOKMAE-TURNOVER] rawField=value samples=${tu.samples} medianMultiplierToKRW=${tu.medianMultiplier ? Math.round(tu.medianMultiplier) : 'n/a'} unitGuess=${tu.guessLabel} (⚠️ 단위 공식 미확인 — 단정 금지, 검색기 T 는 close×volume(원) 사용)`);
  if (res.adjustment === 'ADJUSTED') log.info(`  ℹ️ adjustment=ADJUSTED 는 t8413 sujung='Y' 요청 기준 — 분할종목 실측 대조 전까지 정확성 flag.`);

  if (res.uniqueBars < YEOKMAE_MIN_BARS) {
    log.warn(`[YEOKMAE-FETCH] INSUFFICIENT_HISTORY — uniqueBars=${res.uniqueBars} < ${YEOKMAE_MIN_BARS}. windowDays 확대/추가 페이지 필요.`);
    process.exit(3); return;
  }
  log.info(`[YEOKMAE-FETCH] OK — ${symbol} ${ready.reason} (has600=${ready.has600} hasWarmup=${ready.hasWarmup}). 다음: npm run yeokmae:diag -- ${symbol} ${res.lastDate} KR`);
}
main();
