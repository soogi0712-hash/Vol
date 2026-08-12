// 역매공파 일봉 fetcher 어댑터 (P0-32B) — KR/US 공통 구조. probe 전까지 fail-closed(추측 금지).
//   probe 후 daily-tr-config.ts 만 채우면 이 어댑터가 즉시 동작. 실계정 없이 구조/실패경로를 완성한다.
import { lsDomesticChartRaw, lsOverseasChartRaw, type LSConfig } from '../../src/lib/ls-api';
import { normalizeDailyRows, type DailyBarNorm } from '../../src/lib/yeokmae/history';
import { dailyTRConfig, isDailyTRReady, type DailyTRConfig } from './daily-tr-config';

export interface RawDailyPage { rspCd: string; rspMsg: string; rows: any[]; cont: string; contKey: string }
export interface DailyFetchResult { ok: boolean; error?: string; candles: DailyBarNorm[]; pages: number; sourceTR: string | null }

export interface DailyHistoryFetcher {
  readonly market: 'KR' | 'US';
  ready(): { ready: boolean; reason: string };
  // 전체 취득(연속조회 포함). fail-closed: 설정 미확정이면 즉시 error 반환(호출 안 함).
  fetch(cfg: LSConfig, token: string, p: { symbol: string; exchcd?: string; delaygb?: string; sdate: string; edate: string }): Promise<DailyFetchResult>;
}

// 공통 어댑터 — endpoint 에 따라 KR/US raw 호출. pagination 전략별 연속조회.
class RawDailyAdapter implements DailyHistoryFetcher {
  constructor(public readonly market: 'KR' | 'US', private cfg: DailyTRConfig) {}
  ready() { return isDailyTRReady(this.cfg); }

  async fetch(lsCfg: LSConfig, token: string, p: { symbol: string; exchcd?: string; delaygb?: string; sdate: string; edate: string }): Promise<DailyFetchResult> {
    const r = this.ready();
    if (!r.ready) return { ok: false, error: r.reason, candles: [], pages: 0, sourceTR: this.cfg.trCode };
    const call = this.cfg.endpoint === '/stock/chart' ? lsDomesticChartRaw : lsOverseasChartRaw;
    const build = this.cfg.buildInBlock!;
    const all: any[] = [];
    let cont = 'N', contKey = '', pages = 0;
    const maxPages = 200;   // 무한루프 방지(연속조회 안전상한)
    while (pages < maxPages) {
      const inBlock = build({ symbol: p.symbol, exchcd: p.exchcd, sdate: p.sdate, edate: p.edate, cursor: contKey, delaygb: p.delaygb });
      const resp = await call(token, this.cfg.trCode!, inBlock, { trCont: cont, trContKey: contKey });
      pages++;
      if (!this.cfg.successCodes!.includes(resp.rspCd)) return { ok: false, error: `RSP_CD_NOT_SUCCESS(${resp.rspCd})`, candles: [], pages, sourceTR: this.cfg.trCode };
      all.push(...resp.out1);
      // continuation 전략별 다음 페이지 여부 (probe 후 pagination 값에 따라)
      const more = this.hasNext(resp);
      if (!more.next) break;
      cont = 'Y'; contKey = more.cursor;
    }
    const norm = normalizeDailyRows(all, this.cfg.fieldMap);
    if (!norm.ok) return { ok: false, error: norm.error, candles: [], pages, sourceTR: this.cfg.trCode };
    return { ok: true, candles: norm.candles, pages, sourceTR: this.cfg.trCode };
  }

  private hasNext(resp: { outBlock: any }): { next: boolean; cursor: string } {
    switch (this.cfg.pagination) {
      case 'NONE': case 'FIXED_PAGE': return { next: false, cursor: '' };
      case 'HEADER_CONT': { const k = String(resp.outBlock?.cts_date ?? resp.outBlock?.cont_key ?? ''); return { next: !!k, cursor: k }; }
      case 'BODY_CURSOR': { const k = String(resp.outBlock?.cts_date ?? ''); return { next: !!k, cursor: k }; }
      case 'DATE_WINDOW': return { next: false, cursor: '' };   // 날짜창 방식은 fetch 상위에서 window 이동(probe 후 구현)
      default: return { next: false, cursor: '' };              // UNCONFIRMED → 단일페이지(그러나 ready()에서 이미 차단됨)
    }
  }
}

export function makeKRDailyFetcher(): DailyHistoryFetcher { return new RawDailyAdapter('KR', dailyTRConfig('KR')); }
export function makeUSDailyFetcher(): DailyHistoryFetcher { return new RawDailyAdapter('US', dailyTRConfig('US')); }
