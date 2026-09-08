// 역매공파 US 일봉 실취득 (P0-32D) — g3204(primary) DATE_WINDOW 페이징(공용 코어)로 600~800봉 확보.
//   실측: 단일창 500봉(oldest 예 20240814) → edate 를 과거로 밀어 누적. exchcd/delaygb 은 종목별 런타임.
//   ⚠️ amount(거래대금) 통화/단위 미확인 → KRW 변환/turnoverKRW 단정 금지. rawTurnover 로만 보존.
//   ⚠️ 수정주가 플래그 미확인 → adjustment=UNKNOWN.
import { lsOverseasChartRaw } from '../../src/lib/ls-api';
import { isConfirmedBar, marketToday } from '../../src/lib/yeokmae/calendar';
import { US_DAILY_TR } from './daily-tr-config';
import { windowedDailyFetch, ymdFromDashed, type DailyWindowPage } from './daily-window';
import type { DailyBar } from '../yeokmae-daily-cache';

export interface USDailyFetchResult {
  ok: boolean; error?: string;
  sourceTR: string; adjustment: 'UNKNOWN';
  bars: DailyBar[]; uniqueBars: number; confirmed: number; provisional: number;
  firstDate: string | null; lastDate: string | null;
  rawTurnoverField: string; pages: DailyWindowPage[];
}

export async function fetchUSDaily(
  token: string, p: { symbol: string; exchcd: string; delaygb: string; keysymbol?: string },
  opts: { nowMs: number; targetBars?: number; windowDays?: number; maxPages?: number },
): Promise<USDailyFetchResult> {
  const cfg = US_DAILY_TR;
  const build = cfg.buildInBlock!;
  const res = await windowedDailyFetch({
    callPage: (sdate, edate) => lsOverseasChartRaw(token, cfg.trCode!, build({ symbol: p.symbol, exchcd: p.exchcd, keysymbol: p.keysymbol, delaygb: p.delaygb, sdate, edate })),
    fieldMap: cfg.fieldMap, successCodes: cfg.successCodes!,
    startEdateYmd: ymdFromDashed(marketToday(opts.nowMs, 'US')),
    targetBars: opts.targetBars ?? 800, windowDays: opts.windowDays ?? 1200, maxPages: opts.maxPages ?? 10,
  });
  if (!res.ok) return { ok: false, error: res.error, sourceTR: cfg.trCode!, adjustment: 'UNKNOWN', bars: [], uniqueBars: 0, confirmed: 0, provisional: 0, firstDate: null, lastDate: null, rawTurnoverField: 'amount', pages: res.pages };

  const bars: DailyBar[] = res.barsRaw.map(b => ({
    date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    turnoverKRW: null, rawTurnover: b.turnover,   // amount(단위 미확인) — KRW 변환 금지
    confirmed: isConfirmedBar(b.date, opts.nowMs, 'US'),
  }));
  const confirmed = bars.filter(b => b.confirmed).length;
  return {
    ok: true, sourceTR: cfg.trCode!, adjustment: 'UNKNOWN', bars, uniqueBars: bars.length, confirmed, provisional: bars.length - confirmed,
    firstDate: bars.length ? bars[0].date : null, lastDate: bars.length ? bars[bars.length - 1].date : null,
    rawTurnoverField: 'amount', pages: res.pages,
  };
}
