// 역매공파 US 일봉 pool 구축/재개 (P0-32F) — 실행: npm run yeokmae:build-us-history
//   g3190 eligible universe(재사용) → 캐시 상태 분류 → MISSING/INSUFFICIENT/STALE 만 g3204 fetch → atomic save →
//   준비되면 즉시 역배열(EMA112<=224<=448) 판정 → 후보 저장 → summary. 중단 후 재실행 시 READY 는 건너뛰고 이어서 진행.
//   ⚠️ 전략/수식 무변경. 주문 0. 매일 전체 재다운로드 금지(READY 는 skip, STALE 은 최근 창만 증분).
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached, resolveUSQuote } from './ls-client';
import { makeScrubber } from './mask';
import { loadUSUniverse } from './us-universe';
import { fetchUSDaily } from './yeokmae/us-daily';
import { DailyCache, YEOKMAE_DAILY_ROOT, type DailyBar } from './yeokmae-daily-cache';
import { computeHistoryCapacity, classifyUSCacheState, needsFetch, reverseAlignmentAt, type CacheState } from './yeokmae/us-history-pool';
import { getLSMinIntervalMs, type LSUSMasterRow } from '../src/lib/ls-api';
import { marketToday } from '../src/lib/yeokmae';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const INITIAL = { targetBars: 1000, windowDays: 1200, maxPages: 4 };   // 최초 백필(~2-3 calls)
const INCREMENTAL = { targetBars: 1, windowDays: 40, maxPages: 1 };    // 증분(최근 창 1 call)
const CANDIDATES_FILE = join(YEOKMAE_DAILY_ROOT, 'US.reverse-candidates.json');

interface CandidateRec { symbol: string; exchange: string; exchcd: string; bars: number; ema112: number; ema224: number; ema448: number; lastConfirmed: string | null }

function confirmedCandlesOf(cache: DailyCache) {
  return (cache.body?.bars ?? []).filter(b => b.confirmed).map(b => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
}
function saveCandidatesAtomic(cands: CandidateRec[], nowIso: string) {
  const tmp = CANDIDATES_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify({ generatedAt: nowIso, market: 'US', count: cands.length, candidates: cands }, null, 2), 'utf8');
  renameSync(tmp, CANDIDATES_FILE);
}

async function main() {
  loadEnvLocal();
  const log = createLogger('yeokmae-build-us-history');
  log.info('===== 역매공파 US 일봉 pool 구축/재개 (주문 0) =====');
  log.info('[YEOKMAE-SAFETY] LEGACY_BB_LIVE=false · YEOKMAE_LIVE_TRADING=false · YEOKMAE_STRATEGY_VALIDATED=false · REAL_ORDER_FROM_YEOKMAE=false');

  let cfg; try { cfg = loadConfig(); } catch (e) { log.error(String(e)); process.exit(1); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); } catch (e) { log.error(`토큰 실패: ${scrub(String(e))}`); process.exit(1); return; }
  const delaygb = resolveUSQuote().delaygb ?? 'R';

  // 1) 기존 g3190 eligible universe 재사용(임의 생성 금지)
  const exgubunList = (process.env.LS_US_MASTER_EXGUBUN || '2,1,3').split(',').map(s => s.trim()).filter(Boolean);
  log.info(`g3190 universe 로드 (exgubun=[${exgubunList.join(',')}]) …`);
  const uni = await loadUSUniverse(cfg, token, exgubunList);
  log.info(`universe: total=${uni.total} eligible=${uni.eligible.length} complete=${uni.complete} (NASDAQ=${uni.eligiblePerExchange.NASDAQ} NYSE_AMEX=${uni.eligiblePerExchange.NYSE_AMEX})`);
  if (!uni.eligible.length) { log.error('eligible universe 비어있음 — 중단.'); process.exit(2); return; }

  // 유동성 우선(marketcap desc) — 순환은 전체(임의 상위 N 영구제한 금지). 테스트용 상한만 env.
  const maxSymbols = Number(process.env.YEOKMAE_BUILD_MAX || 0) || 0;
  const rows: LSUSMasterRow[] = [...uni.eligible].sort((a, b) => (b.marketcap || 0) - (a.marketcap || 0));
  const work = maxSymbols > 0 ? rows.slice(0, maxSymbols) : rows;
  if (maxSymbols > 0) log.info(`⚠️ YEOKMAE_BUILD_MAX=${maxSymbols} → 이번 실행은 상위 ${work.length}개만(부분). 전체 순환하려면 env 해제.`);

  const nowMs = Date.now();
  const todayYmd = marketToday(nowMs, 'US');

  // 2) capacity 먼저 계산(로컬 분류, 네트워크 0)
  let readyCount = 0; let workCount = 0;
  const stateOf = new Map<string, CacheState>();
  for (const r of work) {
    const cache = new DailyCache('US', r.symbol); cache.load();
    const confirmed = cache.corrupt ? 0 : confirmedCandlesOf(cache).length;
    const st = cache.corrupt ? 'MISSING' : classifyUSCacheState({ confirmedCount: confirmed, confirmedThrough: cache.body?.confirmedThrough ?? null, marketTodayYmd: todayYmd });
    stateOf.set(r.symbol, st);
    if (needsFetch(st)) workCount++; else readyCount++;
  }
  const cap = computeHistoryCapacity({ universeCount: work.length, readyCount, workCount, callsPerSymbol: 3, minIntervalMs: getLSMinIntervalMs() });
  log.info(`[YEOKMAE-HISTORY-CAPACITY] universe=${cap.universe} cached=${cap.cached} missing=${cap.missing} callsNeeded=${cap.callsNeeded} reqPerSec=${cap.reqPerSec} ETA=${cap.etaHuman}`);

  // 3) 순차 구축(rate limiter 가 직렬화 — 병렬 폭주 금지)
  const candidates: CandidateRec[] = [];
  let done = 0, fetched = 0, skipped = 0, failed = 0, insufficientAfter = 0;
  for (let idx = 0; idx < work.length; idx++) {
    const r = work[idx];
    const cache = new DailyCache('US', r.symbol); cache.load();
    const st = stateOf.get(r.symbol)!;
    const tag = `${idx + 1}/${work.length} ${r.symbol}(${r.market})`;
    if (!needsFetch(st) && !cache.corrupt) {
      skipped++;
      log.info(`[YEOKMAE-HISTORY] ${tag} state=READY → skip(resume)`);
    } else {
      const mode = (st === 'STALE') ? INCREMENTAL : INITIAL;
      const action = (st === 'STALE') ? 'DAILY_INCREMENTAL' : 'INITIAL_BACKFILL';
      try {
        const res = await fetchUSDaily(token, { symbol: r.symbol, exchcd: r.exchcd, delaygb }, { nowMs, ...mode });
        fetched++;
        if (!res.ok) { failed++; log.warn(`[YEOKMAE-HISTORY] ${tag} state=${st} ${action} FETCH_FAIL ${res.error}`); continue; }
        const merged: DailyBar[] = res.bars;
        if (cache.corrupt) { log.warn(`[YEOKMAE-HISTORY] ${tag} 기존 캐시 손상 → 새로 저장`); cache.body = null; cache.corrupt = false; }
        cache.upsert(merged, { sourceTR: res.sourceTR, adjustment: res.adjustment as any, fetchedAtISO: new Date(nowMs).toISOString() });
        cache.flush();   // atomic(tmp+rename)
        const conf = confirmedCandlesOf(cache).length;
        log.info(`[YEOKMAE-HISTORY] ${tag} state=${st} ${action} pages=${res.pages.length} confirmed=${conf} through=${cache.body?.confirmedThrough} prov=${cache.body?.provisionalDate ?? '-'}`);
      } catch (e) { failed++; log.warn(`[YEOKMAE-HISTORY] ${tag} EXCEPTION ${scrub(String(e))}`); continue; }
    }

    // 6) 준비 즉시 역배열 판정(1차 필터). 원본 EMA112<=224<=448.
    const ra = reverseAlignmentAt(confirmedCandlesOf(cache));
    if (!ra.ready) { insufficientAfter++; }
    else if (ra.reverse) {
      const rec: CandidateRec = { symbol: r.symbol, exchange: r.market, exchcd: r.exchcd, bars: ra.bars, ema112: +ra.ema112.toFixed(2), ema224: +ra.ema224.toFixed(2), ema448: +ra.ema448.toFixed(2), lastConfirmed: ra.lastDate };
      candidates.push(rec);
      log.info(`[YEOKMAE-REVERSE-CANDIDATE] symbol=${r.symbol} exch=${r.market} bars=${ra.bars} ema112=${rec.ema112}<=ema224=${rec.ema224}<=ema448=${rec.ema448} lastConfirmed=${ra.lastDate}`);
      saveCandidatesAtomic(candidates, new Date(nowMs).toISOString());   // 점진 저장(중단 대비)
    }
    done++;
  }

  saveCandidatesAtomic(candidates, new Date(nowMs).toISOString());
  log.info('──── [YEOKMAE-HISTORY-SUMMARY] ────');
  log.info(`  processed=${done} fetched=${fetched} skipped(ready)=${skipped} failed=${failed} stillInsufficient=${insufficientAfter}`);
  log.info(`  reverseCandidates=${candidates.length} → ${CANDIDATES_FILE}`);
  log.info(`  다음: npm run yeokmae:scan-candidates -- US  (후보별 A~U + 5신호). 중단됐다면 이 명령 재실행 시 READY 는 건너뜀.`);
}
main();
