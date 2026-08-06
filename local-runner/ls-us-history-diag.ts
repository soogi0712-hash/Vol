// LS 해외 과거차트 진단 — 실행: npm run ls:us-history-diag
// AAPL 1종목에 대해 공식 해외차트 TR(g3203/g3202/g3103/g3204)을 각각 1회 호출해
// rsp_cd, rawCount(행수), 시간범위, 생성 가능한 15분봉 수를 출력한다. 어떤 TR이 실제로
// 과거 데이터를 반환하는지 실계정에서 경험적으로 확인하기 위한 도구. ⚠️ 주문 없음.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached, resolveUSQuote } from './ls-client';
import { loadUSSymbols } from './universe';
import { makeScrubber } from './mask';
import { lsOverseasChartRaw, LSApiError } from '../src/lib/ls-api';
import { aggregateTicksTo15Min, type RTCandle } from './ls-us-websocket';

function kstYmd(offsetDays = 0): string {
  const k = new Date(Date.now() + 9 * 3600 * 1000 - offsetDays * 86400_000);
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, '0')}${String(k.getUTCDate()).padStart(2, '0')}`;
}
const num = (v: unknown) => { const n = parseFloat(String(v ?? '').trim()); return Number.isFinite(n) ? n : 0; };

interface ProbeOut { rspCd: string; rspMsg: string; rawCount: number; range: string; bars15: number; note: string; }

async function probe(
  token: string, trCd: string, inBlock: Record<string, unknown>,
  extract: (out1: any[]) => { range: string; bars15: number; note: string },
): Promise<ProbeOut> {
  try {
    const r = await lsOverseasChartRaw(token, trCd, inBlock);
    const e = extract(r.out1);
    return { rspCd: r.rspCd || '(빈)', rspMsg: r.rspMsg || '', rawCount: r.out1.length, ...e };
  } catch (err) {
    if (err instanceof LSApiError) return { rspCd: err.rspCd || `ERR(${err.kind})`, rspMsg: err.message, rawCount: 0, range: '-', bars15: 0, note: err.kind };
    return { rspCd: 'EXCEPTION', rspMsg: String(err), rawCount: 0, range: '-', bars15: 0, note: 'unknown' };
  }
}

// date+loctime 행 → 시간범위 문자열
function rangeMin(out1: any[], dateKey: string, timeKey: string): string {
  if (!out1.length) return '-';
  const dts = out1.map(r => String(r[dateKey]) + String(r[timeKey] ?? '').padStart(6, '0')).sort();
  return `${dts[0]} ~ ${dts[dts.length - 1]}`;
}
function rangeDay(out1: any[], dateKey: string): string {
  if (!out1.length) return '-';
  const ds = out1.map(r => String(r[dateKey])).sort();
  return `${ds[0]} ~ ${ds[ds.length - 1]}`;
}

async function main() {
  loadEnvLocal();
  const log = createLogger('ls-us-history-diag');
  log.info('===== LS 해외 과거차트 진단 (g3203/g3202/g3103/g3204) — 주문 없음 =====');

  let cfg;
  try { cfg = loadConfig(); } catch (e) { log.error(String(e)); process.exit(1); return; }
  const scrub0 = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); }
  catch (e) { log.error(`토큰 실패: ${scrub0(String(e))}`); process.exit(1); return; }

  // 대상 종목: LS_US_SYMBOLS 첫 종목, 없으면 AAPL(NASDAQ=82)
  const us = loadUSSymbols();
  const sym = us.ok.find(s => s.symbol === 'AAPL') ?? us.ok[0] ?? { symbol: 'AAPL', exchange: 'NASDAQ', exchcd: '82' };
  const keysymbol = sym.exchcd + sym.symbol;
  const quote = resolveUSQuote();
  const delaygb = quote.delaygb ?? 'R';   // 미설정 시 진단 기본값 R(공식 확인값). 실제 사용값과 다르면 로그로 표시.
  const sdate = kstYmd(10);
  log.info(`대상: ${sym.exchange}:${sym.symbol} (exchcd=${sym.exchcd}, keysymbol=${keysymbol}) delaygb=${delaygb}${quote.delaygb ? '' : '(LS_US_DELAYGB 미설정 → R 로 진단)'} sdate=${sdate}`);

  const results: Array<{ tr: string; kind: string } & ProbeOut> = [];

  // g3203 NMIN(15분) — 그대로 15분봉
  results.push({ tr: 'g3203', kind: '15분봉(NMIN)', ...await probe(token, 'g3203',
    { delaygb, keysymbol, exchcd: sym.exchcd, symbol: sym.symbol, ncnt: 15, qrycnt: 5, comp_yn: 'N', sdate, edate: '' },
    (o) => {
      const dts = o.map(r => String(r.date) + String(r.loctime ?? '').padStart(6, '0')).sort();
      const bars = dts.length > 1 ? dts.length - 1 : dts.length;   // 형성봉 1 제외
      return { range: rangeMin(o, 'date', 'loctime'), bars15: bars, note: '직접 15분봉' };
    }) });

  // g3202 NTICK(과거 틱) — 15분 재집계
  results.push({ tr: 'g3202', kind: '과거틱(NTICK)', ...await probe(token, 'g3202',
    { delaygb, keysymbol, exchcd: sym.exchcd, symbol: sym.symbol, ncnt: 5, qrycnt: 5, comp_yn: 'N', sdate, edate: '' },
    (o) => {
      const ticks: RTCandle[] = o.map(r => ({ datetime: String(r.date) + String(r.loctime ?? '').padStart(6, '0'), open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.close), volume: num(r.exevol) }));
      const bars = aggregateTicksTo15Min(ticks);
      return { range: rangeMin(o, 'date', 'loctime'), bars15: bars.length, note: '틱→15분 재집계(1회분)' };
    }) });

  // g3103 일주월 — 일봉류(15분봉 부적합)
  results.push({ tr: 'g3103', kind: '일주월', ...await probe(token, 'g3103',
    { delaygb, keysymbol, exchcd: sym.exchcd, symbol: sym.symbol, gubun: '4', date: sdate },
    (o) => ({ range: rangeDay(o, 'chedate'), bars15: 0, note: '일봉류 — 15분봉 부적합(사용 안 함)' })) });

  // g3204 일주월년 — 일봉류(15분봉 부적합)
  results.push({ tr: 'g3204', kind: '일주월년', ...await probe(token, 'g3204',
    { delaygb, keysymbol, exchcd: sym.exchcd, symbol: sym.symbol, gubun: '2', qrycnt: 5, comp_yn: 'N', sdate, edate: '' },
    (o) => ({ range: rangeDay(o, 'date'), bars15: 0, note: '일봉류 — 15분봉 부적합(사용 안 함)' })) });

  log.info('──────── 결과 (1회 호출 기준) ────────');
  for (const r of results) {
    log.info(`[${r.tr} ${r.kind}] rsp_cd='${r.rspCd}' rawCount=${r.rawCount} 시간범위=${r.range} 생성가능15분봉=${r.bars15} · ${r.note}${r.rspMsg ? ` · msg='${r.rspMsg}'` : ''}`);
  }

  const usable = results.filter(r => (r.tr === 'g3203' || r.tr === 'g3202') && r.bars15 > 0);
  if (usable.length) {
    log.info(`✅ 과거 15분봉 확보 가능 TR: ${usable.map(r => `${r.tr}(${r.bars15}봉/1회)`).join(', ')} — 연속조회로 확장 가능.`);
  } else {
    log.info('⚠️ g3203·g3202 모두 1회 호출로 과거 15분봉을 만들지 못함(빈 응답 가능성). → WebSocket GSC 누적만으로 확정봉을 모아야 함(가짜 봉 생성 금지).');
  }
  log.info(`진단 종료 · orders_submitted=0 · 로그: ${log.file}`);
  process.exit(0);
}
main();
