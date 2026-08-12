// 역매공파 KR 일봉 실취득 (P0-32C/32D) — t8413(primary, 수정주가) DATE_WINDOW 페이징(공용 코어).
//   ⚠️ turnoverKRW 는 단정하지 않음(rawTurnover 보존, 단위는 estimateTurnoverUnit 로 실측 추정만).
import { lsDomesticChartRaw } from '../../src/lib/ls-api';
import { estimateTurnoverUnit, type TurnoverUnitEstimate } from '../../src/lib/yeokmae/history';
import { isConfirmedBar, marketToday } from '../../src/lib/yeokmae/calendar';
import { KR_DAILY_TR, KR_DAILY_TR_ALT, type DailyTRConfig } from './daily-tr-config';
import { windowedDailyFetch, ymdFromDashed, type DailyWindowPage } from './daily-window';
import type { DailyBar } from '../yeokmae-daily-cache';

export interface KRDailyFetchResult {
  ok: boolean; error?: string;
  sourceTR: string; adjustment: 'ADJUSTED' | 'RAW' | 'UNKNOWN';
  bars: DailyBar[]; uniqueBars: number; confirmed: number; provisional: number;
  firstDate: string | null; lastDate: string | null;
  turnoverUnit: TurnoverUnitEstimate; pages: DailyWindowPage[];
}

export async function fetchKRDaily(
  token: string, symbol: string,
  opts: { nowMs: number; targetBars?: number; windowDays?: number; maxPages?: number; useAlt?: boolean },
): Promise<KRDailyFetchResult> {
  const cfg: DailyTRConfig = opts.useAlt ? KR_DAILY_TR_ALT : KR_DAILY_TR;
  const adjustment: KRDailyFetchResult['adjustment'] = cfg.adjustedAvailable ? 'ADJUSTED' : 'UNKNOWN';
  const build = cfg.buildInBlock!;
  const res = await windowedDailyFetch({
    callPage: (sdate, edate) => lsDomesticChartRaw(token, cfg.trCode!, build({ symbol, sdate, edate })),
    fieldMap: cfg.fieldMap, successCodes: cfg.successCodes!,
    startEdateYmd: ymdFromDashed(marketToday(opts.nowMs, 'KR')),
    targetBars: opts.targetBars ?? 800, windowDays: opts.windowDays ?? 1500, maxPages: opts.maxPages ?? 10,
  });
  if (!res.ok) return { ok: false, error: res.error, sourceTR: cfg.trCode!, adjustment, bars: [], uniqueBars: 0, confirmed: 0, provisional: 0, firstDate: null, lastDate: null, turnoverUnit: { samples: 0, medianMultiplier: null, guessLabel: 'UNKNOWN' }, pages: res.pages };

  const bars: DailyBar[] = res.barsRaw.map(b => ({
    date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    turnoverKRW: null, rawTurnover: b.turnover,
    confirmed: isConfirmedBar(b.date, opts.nowMs, 'KR'),
  }));
  const confirmed = bars.filter(b => b.confirmed).length;
  const turnoverUnit = estimateTurnoverUnit(bars.map(b => ({ close: b.close, volume: b.volume, rawTurnover: b.rawTurnover })));
  return {
    ok: true, sourceTR: cfg.trCode!, adjustment, bars, uniqueBars: bars.length, confirmed, provisional: bars.length - confirmed,
    firstDate: bars.length ? bars[0].date : null, lastDate: bars.length ? bars[bars.length - 1].date : null,
    turnoverUnit, pages: res.pages,
  };
}
