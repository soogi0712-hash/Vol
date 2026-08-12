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
import { computeHistoryCapacity, classifyUSCacheState, needsFetch, type CacheState } from './yeokmae/us-history-pool';
import { analyzeSymbol, summarize, rankNearMatches, conditionsLine, SIGNAL_TYPES, type SymbolDiscovery } from './yeokmae/discovery';
import { getLSMinIntervalMs, type LSUSMasterRow } from '../src/lib/ls-api';
import { marketToday, buildYeokmaeSnapshot, type Candle, type YeokmaeSnapshot } from '../src/lib/yeokmae';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const INITIAL = { targetBars: 1000, windowDays: 1200, maxPages: 4 };   // 최초 백필(~2-3 calls)
const INCREMENTAL = { targetBars: 1, windowDays: 40, maxPages: 1 };    // 증분(최근 창 1 call)
const CANDIDATES_FILE = join(YEOKMAE_DAILY_ROOT, 'US.reverse-candidates.json');
const SIGNALS_FILE = join(YEOKMAE_DAILY_ROOT, 'US.real-signals.json');
const SNAPSHOTS_FILE = join(YEOKMAE_DAILY_ROOT, 'US.signal-report.json');

interface CandidateRec { symbol: string; exchange: string; exchcd: string; bars: number; ema112: number; ema224: number; ema448: number; lastConfirmed: string | null }
interface SignalRec {
  symbol: string; exchange: string; confirmedDate: string | null; searcherFormula: boolean;
  '112_ORIGINAL': boolean; '224_ORIGINAL': boolean; '112_UPGRADE': boolean; '224_UPGRADE': boolean; 'LONG_TERM': boolean;
  conditions: string; ema112: number; ema224: number; ema448: number; verifiedFailed: string[]; unverified: string[];
}

function confirmedCandlesOf(cache: DailyCache): Candle[] {
  return (cache.body?.bars ?? []).filter(b => b.confirmed).map(b => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
}
function saveJsonAtomic(file: string, payload: unknown) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, file);
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
  const signalRecs: SignalRec[] = [];
  const snapshots: YeokmaeSnapshot[] = [];
  const discoveries: SymbolDiscovery[] = [];
  const nowIso = new Date(nowMs).toISOString();
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

    // 6~7) 준비 즉시 1차 역배열 → 통과 시 A~U + 5신호(계층화, 원본 무변경).
    const d = analyzeSymbol(r.symbol, confirmedCandlesOf(cache), { excluded: false, isCommonStock: true, isEtfEtnSpac: false });
    discoveries.push(d);
    if (!d.ready) { insufficientAfter++; }
    else if (d.reverse) {
      candidates.push({ symbol: r.symbol, exchange: r.market, exchcd: r.exchcd, bars: d.bars, ema112: +d.ema112.toFixed(2), ema224: +d.ema224.toFixed(2), ema448: +d.ema448.toFixed(2), lastConfirmed: d.lastConfirmed });
      saveJsonAtomic(CANDIDATES_FILE, { generatedAt: nowIso, market: 'US', count: candidates.length, candidates });   // 점진 저장(exMap 소스)
      if (d.anyArrow) {
        // 4) 화살표 1개+ true → 실제 신호. 역배열만 true(화살표 0)는 여기 저장 안 함(BUY 후보 아님).
        const rec: SignalRec = {
          symbol: r.symbol, exchange: r.market, confirmedDate: d.lastConfirmed, searcherFormula: d.searcherFormulaPass,
          '112_ORIGINAL': d.arrows['112_ORIGINAL'], '224_ORIGINAL': d.arrows['224_ORIGINAL'], '112_UPGRADE': d.arrows['112_UPGRADE'], '224_UPGRADE': d.arrows['224_UPGRADE'], 'LONG_TERM': d.arrows['LONG_TERM'],
          conditions: conditionsLine(d.conditions), ema112: +d.ema112.toFixed(2), ema224: +d.ema224.toFixed(2), ema448: +d.ema448.toFixed(2), verifiedFailed: d.verifiedFailed, unverified: d.unverifiedExternal,
        };
        signalRecs.push(rec);
        saveJsonAtomic(SIGNALS_FILE, { generatedAt: nowIso, market: 'US', count: signalRecs.length, signals: signalRecs });
        // rule 2: 실신호 종목 상세 스냅샷 자동 저장(HTS 대조용).
        const snap = buildYeokmaeSnapshot(r.symbol, confirmedCandlesOf(cache));
        if (snap) { snapshots.push(snap); saveJsonAtomic(SNAPSHOTS_FILE, { generatedAt: nowIso, market: 'US', count: snapshots.length, snapshots }); }
        const on = SIGNAL_TYPES.filter(t => d.arrows[t]);
        log.info(`[YEOKMAE-REAL-SIGNAL] symbol=${r.symbol} exch=${r.market} confirmedDate=${d.lastConfirmed} arrows=[${on.join(',')}] searcherFormula=${d.searcherFormulaPass} verifiedFailed=[${d.verifiedFailed.join(',')}] unverified=[${d.unverifiedExternal.join(',')}] snapshot=saved`);
      }
    }
    done++;
  }

  saveJsonAtomic(CANDIDATES_FILE, { generatedAt: nowIso, market: 'US', count: candidates.length, candidates });
  saveJsonAtomic(SIGNALS_FILE, { generatedAt: nowIso, market: 'US', count: signalRecs.length, signals: signalRecs });
  saveJsonAtomic(SNAPSHOTS_FILE, { generatedAt: nowIso, market: 'US', count: snapshots.length, snapshots });

  const sum = summarize(done, discoveries);
  const near = rankNearMatches(discoveries).slice(0, 10);
  log.info('──── [YEOKMAE-DISCOVERY-SUMMARY] ────');
  log.info(`  cached=${sum.cached} reverse=${sum.reverse} arrow112Original=${sum.arrow112Original} arrow224Original=${sum.arrow224Original} arrow112Upgrade=${sum.arrow112Upgrade} arrow224Upgrade=${sum.arrow224Upgrade} longTerm=${sum.longTerm}`);
  log.info(`  searcherFormulaPass=${sum.searcherFormulaPass} bothSearcherAndArrow=${sum.bothSearcherAndArrow} withAnyArrow=${sum.anyArrow}`);
  log.info(`  topNearMatches(verifiedFailedCount 오름차순, BUY 아님)=[${near.map(d => `${d.symbol}:${d.verifiedFailedCount}`).join(' ') || '없음'}]`);
  log.info(`  build: processed=${done} fetched=${fetched} skipped(ready)=${skipped} failed=${failed} stillInsufficient=${insufficientAfter}`);
  log.info(`  files: ${CANDIDATES_FILE} · ${SIGNALS_FILE}`);
  log.info(`  다음: npm run yeokmae:signals -- US (실신호) / npm run yeokmae:near-matches -- US (근접후보). 재실행 시 READY skip(resume).`);
}
main();
