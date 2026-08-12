// 역매공파 KR 일봉 실취득 (P0-32C) — t8413(primary, 수정주가) DATE_WINDOW 역방향 페이징으로 600~800봉 확보.
//   실측: 한 창(sdate~edate)당 그 구간 영업일 반환 → edate 를 과거로 밀어 누적(중복 date 는 dedup).
//   동일 페이지 반복(진전 없음)이면 성공으로 간주하지 않고 중단. 헤더 tr_cont 관측치도 함께 보고(참고).
//   ⚠️ turnoverKRW 는 단정하지 않음(rawTurnover 보존, 단위는 estimateTurnoverUnit 로 실측 추정만).
import { lsDomesticChartRaw } from '../../src/lib/ls-api';
import { normalizeDailyRows, estimateTurnoverUnit, type TurnoverUnitEstimate } from '../../src/lib/yeokmae/history';
import { isConfirmedBar } from '../../src/lib/yeokmae/calendar';
import { KR_DAILY_TR, KR_DAILY_TR_ALT, type DailyTRConfig } from './daily-tr-config';
import type { DailyBar } from '../yeokmae-daily-cache';

function toYmd(ms: number): string {
  const k = new Date(ms + 9 * 3600_000);   // KST
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, '0')}${String(k.getUTCDate()).padStart(2, '0')}`;
}
function prevYmd(ymdOrDash: string): string {
  const ymd = ymdOrDash.replace(/\D/g, '');   // 'YYYY-MM-DD' / 'YYYYMMDD' 모두 허용
  const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6), d = +ymd.slice(6, 8);
  const t = Date.UTC(y, m - 1, d) - 86400_000;
  const p = new Date(t);
  return `${p.getUTCFullYear()}${String(p.getUTCMonth() + 1).padStart(2, '0')}${String(p.getUTCDate()).padStart(2, '0')}`;
}

export interface KRDailyPageInfo { page: number; rows: number; firstDate: string; lastDate: string; resTrCont: string; resTrContKey: string; bodyCursor: string; cumulativeUnique: number; duplicates: number }
export interface KRDailyFetchResult {
  ok: boolean; error?: string;
  sourceTR: string; adjustment: 'ADJUSTED' | 'RAW' | 'UNKNOWN';
  bars: DailyBar[]; uniqueBars: number; confirmed: number; provisional: number;
  firstDate: string | null; lastDate: string | null;
  turnoverUnit: TurnoverUnitEstimate; pages: KRDailyPageInfo[];
}

export async function fetchKRDaily(
  token: string, symbol: string,
  opts: { nowMs: number; targetBars?: number; windowDays?: number; maxPages?: number; useAlt?: boolean } ,
): Promise<KRDailyFetchResult> {
  const cfg: DailyTRConfig = opts.useAlt ? KR_DAILY_TR_ALT : KR_DAILY_TR;
  const targetBars = opts.targetBars ?? 800;
  const windowDays = opts.windowDays ?? 1500;
  const maxPages = opts.maxPages ?? 10;
  const adjustment: KRDailyFetchResult['adjustment'] = cfg.adjustedAvailable ? 'ADJUSTED' : 'UNKNOWN';
  const byDate = new Map<string, { date: string; open: number; high: number; low: number; close: number; volume: number; rawTurnover: number | null }>();
  const pages: KRDailyPageInfo[] = [];
  const build = cfg.buildInBlock!;

  let edate = toYmd(opts.nowMs);
  let prevOldest: string | null = null;

  for (let page = 1; page <= maxPages; page++) {
    // sdate = edate - windowDays (창 시작)
    const sMs = Date.UTC(+edate.slice(0, 4), +edate.slice(4, 6) - 1, +edate.slice(6, 8)) - windowDays * 86400_000;
    const s = new Date(sMs);
    const sdate = `${s.getUTCFullYear()}${String(s.getUTCMonth() + 1).padStart(2, '0')}${String(s.getUTCDate()).padStart(2, '0')}`;
    const inBlock = build({ symbol, sdate, edate });
    const resp = await lsDomesticChartRaw(token, cfg.trCode!, inBlock);
    if (!cfg.successCodes!.includes(resp.rspCd)) {
      return { ok: false, error: `RSP_CD_NOT_SUCCESS(${resp.rspCd}) ${resp.rspMsg || ''}`.trim(), sourceTR: cfg.trCode!, adjustment, bars: [], uniqueBars: 0, confirmed: 0, provisional: 0, firstDate: null, lastDate: null, turnoverUnit: { samples: 0, medianMultiplier: null, guessLabel: 'UNKNOWN' }, pages };
    }
    const norm = normalizeDailyRows(resp.out1, cfg.fieldMap);
    if (!norm.ok) return { ok: false, error: norm.error, sourceTR: cfg.trCode!, adjustment, bars: [], uniqueBars: 0, confirmed: 0, provisional: 0, firstDate: null, lastDate: null, turnoverUnit: { samples: 0, medianMultiplier: null, guessLabel: 'UNKNOWN' }, pages };

    let dup = 0;
    for (const c of norm.candles) {
      if (byDate.has(c.date)) dup++;
      byDate.set(c.date, { date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, rawTurnover: c.turnover });
    }
    const sorted = norm.candles.map(c => c.date).sort();
    const pageFirst = sorted[0] ?? '';
    const pageLast = sorted[sorted.length - 1] ?? '';
    pages.push({ page, rows: norm.candles.length, firstDate: pageFirst, lastDate: pageLast, resTrCont: resp.diag.trCont, resTrContKey: resp.diag.trContKey, bodyCursor: String(resp.outBlock?.cts_date ?? ''), cumulativeUnique: byDate.size, duplicates: dup });

    if (byDate.size >= targetBars) break;
    if (norm.candles.length === 0) break;
    // 진전 판정: 이번 창의 最古(pageFirst)가 직전보다 과거로 내려가야 함(아니면 반복 → 중단).
    if (prevOldest !== null && pageFirst >= prevOldest) break;
    prevOldest = pageFirst;
    edate = prevYmd(pageFirst);   // 다음 창은 이번 最古 하루 전까지
  }

  const allBars = [...byDate.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const bars: DailyBar[] = allBars.map(b => ({
    date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    turnoverKRW: null, rawTurnover: b.rawTurnover,
    confirmed: isConfirmedBar(b.date, opts.nowMs, 'KR'),
  }));
  const confirmed = bars.filter(b => b.confirmed).length;
  const provisional = bars.length - confirmed;
  const turnoverUnit = estimateTurnoverUnit(bars.map(b => ({ close: b.close, volume: b.volume, rawTurnover: b.rawTurnover })));
  return {
    ok: true, sourceTR: cfg.trCode!, adjustment, bars, uniqueBars: bars.length, confirmed, provisional,
    firstDate: bars.length ? bars[0].date : null, lastDate: bars.length ? bars[bars.length - 1].date : null,
    turnoverUnit, pages,
  };
}
