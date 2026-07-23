/**
 * 국내(KR) 1분봉 조회 → 15분봉 집계 (Phase 1: 수집/집계/저장만, 배치 스캔 미연결)
 * ─────────────────────────────────────────────────────────────
 * KIS 주식당일분봉조회(FHKST03010200)는 당일 1분봉을 호출당 최대 30개 반환한다.
 * FID_INPUT_HOUR_1 에 미래 시각을 넣으면 전 봉이 "현재가"로 반환된다(원인 확정).
 * → 유효(비-미래) 시각을 넣어 역방향 페이징으로 1분봉을 모아 09:00 기준 15분봉으로
 *   집계하고, "완성된 15분봉"만 candle_history(timeframe='15m')에 저장한다.
 *
 * 전략(BB/RSI/validateCandleData/FLAT_CANDLE 등)과 주문 로직은 이 파일에서 다루지 않는다.
 */
import type { Candle } from './kis-api';

const pad2 = (n: number) => String(n).padStart(2, '0');

// KST 로 변환한 Date (getUTC* 로 KST 필드 읽기)
function kstDate(nowMs: number): Date {
  return new Date(nowMs + 9 * 3600 * 1000);
}

/**
 * FID_INPUT_HOUR_1 유효 시각(HHMMSS). 미래 시각을 절대 반환하지 않는다.
 *   09:00 이전 → '090000'
 *   09:00~15:30 → 현재 HHMMSS
 *   15:30 이후 → '153000'
 */
export function clampKisInputHourKST(nowMs: number): string {
  const k = kstDate(nowMs);
  const hh = k.getUTCHours(), mm = k.getUTCMinutes(), ss = k.getUTCSeconds();
  const hhmm = hh * 100 + mm;
  if (hhmm < 900) return '090000';
  if (hhmm >= 1530) return '153000';
  return `${pad2(hh)}${pad2(mm)}${pad2(ss)}`;
}

/** HHMMSS 에서 1분 감소(초는 00 정규화). 09:00 이하로는 내려가지 않게 호출측이 제어. */
export function minusOneMinuteHHMMSS(hhmmss: string): string {
  let h = parseInt(hhmmss.slice(0, 2), 10);
  let m = parseInt(hhmmss.slice(2, 4), 10);
  m -= 1;
  if (m < 0) { m = 59; h -= 1; }
  if (h < 0) { h = 0; m = 0; }
  return `${pad2(h)}${pad2(m)}00`;
}

/**
 * datetime(YYYYMMDDHHMMSS) → 15분 버킷 시작 시각. 09:00~15:29 만 유효.
 * 15:30 이상(및 09:00 미만)은 null → 15:30 단독봉 생성을 방지한다.
 */
export function bucketStart(datetime: string): string | null {
  const date = datetime.slice(0, 8);
  const hh = parseInt(datetime.slice(8, 10), 10);
  const mm = parseInt(datetime.slice(10, 12), 10);
  const hhmm = hh * 100 + mm;
  if (hhmm < 900 || hhmm >= 1530) return null;
  const bmm = Math.floor(mm / 15) * 15;
  return `${date}${pad2(hh)}${pad2(bmm)}00`;
}

function bucketStartMinutes(bucket: string): number {
  return parseInt(bucket.slice(8, 10), 10) * 60 + parseInt(bucket.slice(10, 12), 10);
}

export interface Aggregated {
  completed: Candle[];
  inProgress: Candle | null;
}

/**
 * 1분봉 배열 → 15분봉 집계.
 *  - timestamp 중복 제거, 오름차순 정렬
 *  - 유효 OHLC(유한, close>0)만 사용
 *  - 09:00 기준 15분 버킷: open=첫봉 시가, high=max, low=min, close=마지막봉 종가, vol=합
 *  - 완성 판정(시간 기준): 버킷 날짜가 과거이거나, 오늘이면 KST now ≥ 버킷시작+15분
 *  - 진행 중(미완성) 버킷은 completed 에 넣지 않고 inProgress 로 분리(마지막 1개)
 *  - 행 수(<15)로 폐기하지 않는다(저유동 종목 고려). 죽은 데이터는 하류 검증이 거른다.
 */
export function aggregateTo15Min(oneMin: readonly Candle[], nowMs: number): Aggregated {
  const seen = new Set<string>();
  const bars: Candle[] = [];
  for (const c of oneMin) {
    if (!Number.isFinite(c.open) || !Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close)) continue;
    if (c.close <= 0) continue;
    if (seen.has(c.datetime)) continue;
    seen.add(c.datetime);
    bars.push(c);
  }
  bars.sort((a, b) => a.datetime.localeCompare(b.datetime));

  const groups = new Map<string, Candle[]>();
  for (const b of bars) {
    const bk = bucketStart(b.datetime);
    if (!bk) continue;
    const g = groups.get(bk);
    if (g) g.push(b); else groups.set(bk, [b]);
  }

  const k = kstDate(nowMs);
  const nowDate = `${k.getUTCFullYear()}${pad2(k.getUTCMonth() + 1)}${pad2(k.getUTCDate())}`;
  const nowMinutes = k.getUTCHours() * 60 + k.getUTCMinutes();

  const completed: Candle[] = [];
  let inProgress: Candle | null = null;

  for (const [bk, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => a.datetime.localeCompare(b.datetime));
    const bar: Candle = {
      ticker: list[0].ticker, market: 'KR', datetime: bk,
      open: list[0].open,
      high: Math.max(...list.map(c => c.high)),
      low: Math.min(...list.map(c => c.low)),
      close: list[list.length - 1].close,
      volume: list.reduce((s, c) => s + (Number.isFinite(c.volume) ? c.volume : 0), 0),
    };
    const bkDate = bk.slice(0, 8);
    let done: boolean;
    if (bkDate < nowDate) done = true;
    else if (bkDate > nowDate) done = false;
    else done = nowMinutes >= bucketStartMinutes(bk) + 15;

    if (done) completed.push(bar);
    else inProgress = bar;   // 오늘·미완성 버킷 = 진행봉 (마지막 1개만)
  }
  return { completed, inProgress };
}

// ─── 수집 오케스트레이션 (의존성 주입식, 테스트 가능) ─────────────
export interface CollectDeps {
  ticker: string;
  nowMs: number;
  /** 한 페이지(1분봉 ≤30개) 조회. endHHMMSS 기준 과거. rate limiter 는 호출측이 감싼다. */
  fetchPage: (endHHMMSS: string) => Promise<Candle[]>;
  /** D1 에 저장된 이 종목의 최신 완성 15분봉 candle_ts (없으면 null → 부트스트랩) */
  latestStoredTs: () => Promise<string | null>;
  /** 완성 15분봉 upsert(timeframe='15m'). 신규/업데이트 건수 반환 */
  upsert15m: (bars: Candle[]) => Promise<{ inserted: number; updated: number }>;
  /** 페이지 상한 (Phase 1 안전장치, 기본 15) */
  maxPages?: number;
  /** 증분 모드에서 최대 페이지 (기본 2) */
  incrementalPages?: number;
}

export interface KRCollectDiag {
  ticker: string;
  mode: 'bootstrap' | 'incremental';
  calls: Array<{ endTime: string; rawCount: number; firstTs: string | null; lastTs: string | null }>;
  totalKisCalls: number;
  oneMinBeforeDedup: number;
  oneMinAfterDedup: number;
  uniqTs: number;
  uniqClose: number;
  completedBars: Array<{ ts: string; open: number; high: number; low: number; close: number; volume: number }>;
  inProgress: { ts: string; open: number; high: number; low: number; close: number; volume: number } | null;
  stored: { inserted: number; updated: number };
  stopReason: string;
}

/** 1분봉을 역방향 페이징으로 모아 15분봉 집계·저장하고 진단 리포트를 반환한다. */
export async function collectKR15Min(deps: CollectDeps): Promise<KRCollectDiag> {
  const maxPages = deps.maxPages ?? 15;
  const incrementalPages = deps.incrementalPages ?? 2;
  const latest = await deps.latestStoredTs();
  const mode: 'bootstrap' | 'incremental' = latest ? 'incremental' : 'bootstrap';

  const calls: KRCollectDiag['calls'] = [];
  const all: Candle[] = [];
  const seenTs = new Set<string>();
  let endTime = clampKisInputHourKST(deps.nowMs);
  let stopReason = 'max_pages';

  const pageCap = mode === 'incremental' ? Math.min(incrementalPages, maxPages) : maxPages;

  for (let page = 0; page < pageCap; page++) {
    let rows: Candle[];
    try {
      rows = await deps.fetchPage(endTime);
    } catch (e) {
      stopReason = `fetch_error: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }
    let firstTs: string | null = null, lastTs: string | null = null;
    for (const c of rows) {
      if (firstTs === null || c.datetime < firstTs) firstTs = c.datetime;
      if (lastTs === null || c.datetime > lastTs) lastTs = c.datetime;
    }
    calls.push({ endTime, rawCount: rows.length, firstTs, lastTs });

    if (rows.length === 0) { stopReason = 'empty_page'; break; }

    let newCount = 0;
    for (const c of rows) {
      if (!seenTs.has(c.datetime)) { seenTs.add(c.datetime); all.push(c); newCount++; }
    }
    if (newCount === 0) { stopReason = 'all_duplicate'; break; }

    const minHHMMSS = firstTs!.slice(8, 14);
    if (minHHMMSS <= '090000') { stopReason = 'reached_0900'; break; }
    if (latest && firstTs! <= latest) { stopReason = 'reached_stored'; break; }

    endTime = minusOneMinuteHHMMSS(minHHMMSS);
  }

  const oneMinBeforeDedup = calls.reduce((s, c) => s + c.rawCount, 0);
  const agg = aggregateTo15Min(all, deps.nowMs);
  const stored = await deps.upsert15m(agg.completed);

  return {
    ticker: deps.ticker,
    mode,
    calls,
    totalKisCalls: calls.length,
    oneMinBeforeDedup,
    oneMinAfterDedup: all.length,
    uniqTs: new Set(all.map(c => c.datetime)).size,
    uniqClose: new Set(all.map(c => c.close)).size,
    completedBars: agg.completed.map(b => ({ ts: b.datetime, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
    inProgress: agg.inProgress
      ? { ts: agg.inProgress.datetime, open: agg.inProgress.open, high: agg.inProgress.high, low: agg.inProgress.low, close: agg.inProgress.close, volume: agg.inProgress.volume }
      : null,
    stored,
    stopReason,
  };
}
