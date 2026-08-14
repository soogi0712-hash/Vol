// 역매공파 KR 일봉 pool 구축/재개 + 실신호 발견 (P0-35KR) — 실행: npm run yeokmae:build-kr-history
//   기존 KR universe(KOSPI+KOSDAQ, t8436) 재사용 → 캐시 상태 분류 → MISSING/INSUFFICIENT/STALE 만 t8413 fetch →
//   atomic save → 준비 즉시 역배열(EMA112<=224<=448) → 통과 시 A~U + 5신호 → 5신호 1개+ true 면 [YEOKMAE-KR-REAL-SIGNAL] 저장.
//   ⚠️ 원본 수식 무변경. 주문 0. 당일봉=PROVISIONAL(확정봉만 신호계산 → 전일 CONFIRMED 우선). US 캐시/파일 미변경.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached } from './ls-client';
import { makeScrubber } from './mask';
import { loadKRUniverse } from './kr-universe';
import { fetchKRDaily } from './yeokmae/kr-daily';
import { DailyCache, YEOKMAE_DAILY_ROOT, type DailyBar } from './yeokmae-daily-cache';
import { computeHistoryCapacity, classifyUSCacheState, needsFetch, type CacheState } from './yeokmae/us-history-pool';
import { analyzeSymbol, summarize, rankNearMatches, conditionsLine, SIGNAL_TYPES, type SymbolDiscovery } from './yeokmae/discovery';
import { collectRankedSignals, formatKRSignalDetail, signalTierCounts } from './yeokmae/signal-detail';
import { getLSMinIntervalMs } from '../src/lib/ls-api';
import { marketToday, buildYeokmaeSnapshot, type Candle, type YeokmaeSnapshot } from '../src/lib/yeokmae';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const INITIAL = { targetBars: 1000, windowDays: 2000, maxPages: 8 };   // 최초 백필(KR 한 창=구간 영업일 → 여러 창 누적)
const INCREMENTAL = { targetBars: 1, windowDays: 40, maxPages: 1 };     // 증분(최근 창)
const CANDIDATES_FILE = join(YEOKMAE_DAILY_ROOT, 'KR.reverse-candidates.json');
const SIGNALS_FILE = join(YEOKMAE_DAILY_ROOT, 'KR.real-signals.json');
const SNAPSHOTS_FILE = join(YEOKMAE_DAILY_ROOT, 'KR.signal-report.json');

interface CandidateRec { symbol: string; name: string; exchange: string; bars: number; ema112: number; ema224: number; ema448: number; lastConfirmed: string | null }
interface SignalRec {
  symbol: string; name: string; exchange: string; confirmedDate: string | null; searcherFormula: boolean;
  '112_ORIGINAL': boolean; '224_ORIGINAL': boolean; '112_UPGRADE': boolean; '224_UPGRADE': boolean; 'LONG_TERM': boolean;
  conditions: string; ema112: number; ema224: number; ema448: number; verifiedFailed: string[]; unverified: string[];
}

function confirmedCandlesOf(cache: DailyCache): Candle[] {
  return (cache.body?.bars ?? []).filter(b => b.confirmed).map(b => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
}
function saveJsonAtomic(file: string, payload: unknown) { const tmp = file + '.tmp'; writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8'); renameSync(tmp, file); }

async function main() {
  loadEnvLocal();
  const log = createLogger('yeokmae-build-kr-history');
  log.info('===== 역매공파 KR 일봉 pool 구축/재개 + 실신호 발견 (주문 0) =====');
  log.info('[YEOKMAE-SAFETY] LEGACY_BB_LIVE=false · YEOKMAE_LIVE_TRADING=false · YEOKMAE_STRATEGY_VALIDATED=false · REAL_ORDER_FROM_YEOKMAE=false');

  let cfg; try { cfg = loadConfig(); } catch (e) { log.error(String(e)); process.exit(1); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); } catch (e) { log.error(`토큰 실패: ${scrub(String(e))}`); process.exit(1); return; }

  // 1) 기존 KR universe(KOSPI+KOSDAQ) 재사용
  log.info('KR universe 로드(t8436 KOSPI+KOSDAQ) …');
  const uni = await loadKRUniverse(cfg, token);
  log.info(`universe: total=${uni.total} eligible=${uni.eligible.length} (KOSPI=${uni.perMarket.KOSPI} KOSDAQ=${uni.perMarket.KOSDAQ}) · ${uni.rspNote}`);
  if (!uni.eligible.length) { log.error('eligible universe 비어있음 — 중단.'); process.exit(2); return; }

  const maxSymbols = Number(process.env.YEOKMAE_BUILD_MAX || 0) || 0;
  const work = maxSymbols > 0 ? uni.eligible.slice(0, maxSymbols) : uni.eligible;
  if (maxSymbols > 0) log.info(`⚠️ YEOKMAE_BUILD_MAX=${maxSymbols} → 이번 실행은 ${work.length}개만(부분). 전체 순환하려면 env 해제.`);

  const nowMs = Date.now();
  const todayYmd = marketToday(nowMs, 'KR');

  // 2) capacity 먼저(로컬 분류, 네트워크 0)
  let readyCount = 0, workCount = 0;
  const stateOf = new Map<string, CacheState>();
  for (const r of work) {
    const cache = new DailyCache('KR', r.shcode); cache.load();
    const confirmed = cache.corrupt ? 0 : confirmedCandlesOf(cache).length;
    const st = cache.corrupt ? 'MISSING' : classifyUSCacheState({ confirmedCount: confirmed, confirmedThrough: cache.body?.confirmedThrough ?? null, marketTodayYmd: todayYmd });
    stateOf.set(r.shcode, st);
    if (needsFetch(st)) workCount++; else readyCount++;
  }
  const cap = computeHistoryCapacity({ universeCount: work.length, readyCount, workCount, callsPerSymbol: 4, minIntervalMs: getLSMinIntervalMs() });
  log.info(`[YEOKMAE-HISTORY-CAPACITY] market=KR universe=${cap.universe} cached=${cap.cached} missing=${cap.missing} callsNeeded=${cap.callsNeeded} reqPerSec=${cap.reqPerSec} ETA=${cap.etaHuman}`);

  // 3) 순차 구축(rate limiter 직렬화)
  const candidates: CandidateRec[] = [];
  const signalRecs: SignalRec[] = [];
  const snapshots: YeokmaeSnapshot[] = [];
  const discoveries: SymbolDiscovery[] = [];
  const nowIso = new Date(nowMs).toISOString();
  const nameOf = new Map(work.map(r => [r.shcode, r.hname]));
  let done = 0, fetched = 0, skipped = 0, failed = 0, insufficientAfter = 0;

  for (let idx = 0; idx < work.length; idx++) {
    const r = work[idx];
    const cache = new DailyCache('KR', r.shcode); cache.load();
    const st = stateOf.get(r.shcode)!;
    const tag = `${idx + 1}/${work.length} ${r.shcode}(${r.market})`;
    if (!needsFetch(st) && !cache.corrupt) {
      skipped++;
      log.info(`[YEOKMAE-KR-HISTORY] ${tag} state=READY → skip(resume)`);
    } else {
      const mode = (st === 'STALE') ? INCREMENTAL : INITIAL;
      const action = (st === 'STALE') ? 'DAILY_INCREMENTAL' : 'INITIAL_BACKFILL';
      try {
        const res = await fetchKRDaily(token, r.shcode, { nowMs, ...mode });
        fetched++;
        if (!res.ok) { failed++; log.warn(`[YEOKMAE-KR-HISTORY] ${tag} state=${st} ${action} FETCH_FAIL ${res.error}`); continue; }
        if (cache.corrupt) { log.warn(`[YEOKMAE-KR-HISTORY] ${tag} 기존 캐시 손상 → 새로 저장`); cache.body = null; cache.corrupt = false; }
        const merged: DailyBar[] = res.bars;
        cache.upsert(merged, { sourceTR: res.sourceTR, adjustment: res.adjustment as any, fetchedAtISO: nowIso });
        cache.flush();
        const conf = confirmedCandlesOf(cache).length;
        log.info(`[YEOKMAE-KR-HISTORY] ${tag} state=${st} ${action} pages=${res.pages.length} confirmed=${conf} through=${cache.body?.confirmedThrough} prov=${cache.body?.provisionalDate ?? '-'}`);
      } catch (e) { failed++; log.warn(`[YEOKMAE-KR-HISTORY] ${tag} EXCEPTION ${scrub(String(e))}`); continue; }
    }

    // 4~6) 확정봉만으로 역배열 → A~U + 5신호(계층화, 원본 무변경). 당일봉(PROVISIONAL)은 제외.
    const d = analyzeSymbol(r.shcode, confirmedCandlesOf(cache), { excluded: false, isCommonStock: true, isEtfEtnSpac: false });
    discoveries.push(d);
    if (!d.ready) { insufficientAfter++; }
    else if (d.reverse) {
      candidates.push({ symbol: r.shcode, name: r.hname, exchange: r.market, bars: d.bars, ema112: +d.ema112.toFixed(2), ema224: +d.ema224.toFixed(2), ema448: +d.ema448.toFixed(2), lastConfirmed: d.lastConfirmed });
      saveJsonAtomic(CANDIDATES_FILE, { generatedAt: nowIso, market: 'KR', count: candidates.length, candidates });
      if (d.anyArrow) {
        const rec: SignalRec = {
          symbol: r.shcode, name: r.hname, exchange: r.market, confirmedDate: d.lastConfirmed, searcherFormula: d.searcherFormulaPass,
          '112_ORIGINAL': d.arrows['112_ORIGINAL'], '224_ORIGINAL': d.arrows['224_ORIGINAL'], '112_UPGRADE': d.arrows['112_UPGRADE'], '224_UPGRADE': d.arrows['224_UPGRADE'], 'LONG_TERM': d.arrows['LONG_TERM'],
          conditions: conditionsLine(d.conditions), ema112: +d.ema112.toFixed(2), ema224: +d.ema224.toFixed(2), ema448: +d.ema448.toFixed(2), verifiedFailed: d.verifiedFailed, unverified: d.unverifiedExternal,
        };
        signalRecs.push(rec);
        saveJsonAtomic(SIGNALS_FILE, { generatedAt: nowIso, market: 'KR', count: signalRecs.length, signals: signalRecs });
        const snap = buildYeokmaeSnapshot(r.shcode, confirmedCandlesOf(cache));
        if (snap) { snapshots.push(snap); saveJsonAtomic(SNAPSHOTS_FILE, { generatedAt: nowIso, market: 'KR', count: snapshots.length, snapshots }); }
        const on = SIGNAL_TYPES.filter(t => d.arrows[t]);
        log.info(`[YEOKMAE-KR-REAL-SIGNAL] symbol=${r.shcode} name=${r.hname} exch=${r.market} confirmedDate=${d.lastConfirmed} arrows=[${on.join(',')}] searcherFormula=${d.searcherFormulaPass} verifiedFailed=[${d.verifiedFailed.join(',')}] unverified=[${d.unverifiedExternal.join(',')}] snapshot=saved`);
      }
    }
    done++;
  }

  saveJsonAtomic(CANDIDATES_FILE, { generatedAt: nowIso, market: 'KR', count: candidates.length, candidates });
  saveJsonAtomic(SIGNALS_FILE, { generatedAt: nowIso, market: 'KR', count: signalRecs.length, signals: signalRecs });
  saveJsonAtomic(SNAPSHOTS_FILE, { generatedAt: nowIso, market: 'KR', count: snapshots.length, snapshots });

  const sum = summarize(done, discoveries);
  const near = rankNearMatches(discoveries).slice(0, 10);
  log.info('──── [YEOKMAE-KR-DISCOVERY-SUMMARY] ────');
  log.info(`  cached=${sum.cached} reverse=${sum.reverse} arrow112Original=${sum.arrow112Original} arrow224Original=${sum.arrow224Original} arrow112Upgrade=${sum.arrow112Upgrade} arrow224Upgrade=${sum.arrow224Upgrade} longTerm=${sum.longTerm}`);
  log.info(`  searcherFormulaPass=${sum.searcherFormulaPass} bothSearcherAndArrow=${sum.bothSearcherAndArrow} withAnyArrow=${sum.anyArrow}`);
  log.info(`  topNearMatches(verifiedFailedCount 오름차순, BUY 아님)=[${near.map(d => `${d.symbol}(${nameOf.get(d.symbol) ?? '?'}):${d.verifiedFailedCount}`).join(' ') || '없음'}]`);
  log.info(`  build: processed=${done} fetched=${fetched} skipped(ready)=${skipped} failed=${failed} stillInsufficient=${insufficientAfter}`);
  log.info(`  files: ${CANDIDATES_FILE} · ${SIGNALS_FILE} · ${SNAPSHOTS_FILE}`);

  // ── 우선순위 상세 출력 (P0-35KR2) — 수집(SEARCHER_PASS||arrow), 112_UPGRADE/224_UPGRADE 먼저. 주문 0. ──
  const ranked = collectRankedSignals(discoveries);
  const tc = signalTierCounts(ranked);
  log.info(`──── [YEOKMAE-KR-SIGNALS-PRIORITIZED] 수집=${tc.total} (UPGRADE=${tc.upgrade} 기타arrow=${tc.arrow} searcher-only=${tc.searcherOnly}) — UPGRADE 먼저 ────`);
  for (const d of ranked) {
    const c2 = new DailyCache('KR', d.symbol); c2.load();
    const snap = c2.corrupt ? null : buildYeokmaeSnapshot(d.symbol, confirmedCandlesOf(c2));
    for (const line of formatKRSignalDetail(d, snap, nameOf.get(d.symbol) ?? '?')) log.info(line);
  }
  if (ranked.length === 0) log.info('  (SEARCHER_PASS/5신호 종목 없음 — 정상. 조건 완화 금지. 근접후보는 위 topNearMatches 참조.)');
  log.info(`  다음: npm run yeokmae:signals -- KR (캐시서 재출력, 네트워크 0) / npm run yeokmae:signal-report -- KR (HTS 대조표). 재실행 시 READY skip(resume).`);
}
main();
