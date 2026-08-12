// 역매공파 일봉 DATE_WINDOW 페이징 공용 코어 (P0-32D) — KR/US 공통.
//   한 창(sdate~edate)씩 조회 → 정규화·dedup 누적 → edate 를 이번 창 最古 하루 전으로 밀어 과거로 진행.
//   진전 없으면(동일 first 반복) 중단(무한루프 방지 + '동일봉 반복=성공' 오판 금지). 주문 없음.
import { normalizeDailyRows, type DailyFieldMap, type DailyBarNorm } from '../../src/lib/yeokmae/history';

export interface DailyWindowPage {
  page: number; requestSdate: string; requestEdate: string; rows: number;
  firstDate: string; lastDate: string; newUnique: number;
  resTrCont: string; resTrContKey: string; bodyCursor: string;
  cumulativeUnique: number; duplicates: number;
}
export interface DailyWindowResult { ok: boolean; error?: string; barsRaw: DailyBarNorm[]; pages: DailyWindowPage[] }

export interface RawChartResp { rspCd: string; rspMsg: string; out1: any[]; outBlock: any; diag: { trCont: string; trContKey: string } }

export function ymdFromDashed(d: string): string { return d.replace(/\D/g, ''); }
export function addDaysYmd(ymdOrDash: string, deltaDays: number): string {
  const ymd = ymdFromDashed(ymdOrDash);
  const t = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + deltaDays * 86400_000;
  const p = new Date(t);
  return `${p.getUTCFullYear()}${String(p.getUTCMonth() + 1).padStart(2, '0')}${String(p.getUTCDate()).padStart(2, '0')}`;
}
export const prevYmd = (d: string) => addDaysYmd(d, -1);

export async function windowedDailyFetch(p: {
  callPage: (sdate: string, edate: string) => Promise<RawChartResp>;
  fieldMap: DailyFieldMap;
  successCodes: string[];
  startEdateYmd: string;             // 시장 현지 오늘(YYYYMMDD)
  targetBars: number;
  windowDays: number;
  maxPages: number;
}): Promise<DailyWindowResult> {
  const byDate = new Map<string, DailyBarNorm>();
  const pages: DailyWindowPage[] = [];
  let edate = ymdFromDashed(p.startEdateYmd);
  let prevOldest: string | null = null;

  for (let page = 1; page <= p.maxPages; page++) {
    const sdate = addDaysYmd(edate, -p.windowDays);
    const resp = await p.callPage(sdate, edate);
    if (!p.successCodes.includes(resp.rspCd)) return { ok: false, error: `RSP_CD_NOT_SUCCESS(${resp.rspCd}) ${resp.rspMsg || ''}`.trim(), barsRaw: [], pages };
    const norm = normalizeDailyRows(resp.out1, p.fieldMap);
    if (!norm.ok) return { ok: false, error: norm.error, barsRaw: [], pages };

    let dup = 0; let newUnique = 0;
    for (const c of norm.candles) {
      if (byDate.has(c.date)) dup++; else newUnique++;
      byDate.set(c.date, c);
    }
    const dates = norm.candles.map(c => c.date).sort();
    const pageFirst = dates[0] ?? '';
    const pageLast = dates[dates.length - 1] ?? '';
    pages.push({
      page, requestSdate: sdate, requestEdate: edate, rows: norm.candles.length,
      firstDate: pageFirst, lastDate: pageLast, newUnique,
      resTrCont: resp.diag.trCont, resTrContKey: resp.diag.trContKey, bodyCursor: String(resp.outBlock?.cts_date ?? ''),
      cumulativeUnique: byDate.size, duplicates: dup,
    });

    if (byDate.size >= p.targetBars) break;
    if (norm.candles.length === 0) break;
    if (prevOldest !== null && pageFirst >= prevOldest) break;   // 진전 없음 → 중단
    prevOldest = pageFirst;
    edate = prevYmd(pageFirst);
  }

  const barsRaw = [...byDate.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return { ok: true, barsRaw, pages };
}
