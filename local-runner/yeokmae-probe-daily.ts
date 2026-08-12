// 역매공파 일봉 TR 프로브 (P0-32A) — 실행: npm run yeokmae:probe-daily -- [SYMBOL_KR] [SYMBOL_US]
//   목적: KR/US 일봉 후보 TR 을 실계정에서 1회 호출해 '실제 OutBlock1 필드명 + 샘플행'을 그대로 덤프.
//   ⚠️ OHLCV 필드 매핑을 추측하지 않기 위한 도구. 이 출력으로 공식 필드를 확인한 뒤에만 정식 fetcher 를 구현한다.
//   ⚠️ 주문 없음. 후보 InBlock 은 CANDIDATE(미확인) — rsp_cd/필드로 맞는지 사용자/후속단계가 판단.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached, resolveUSQuote } from './ls-client';
import { loadUSSymbols } from './universe';
import { makeScrubber } from './mask';
import { lsDomesticChartRaw, lsOverseasChartRaw, LSApiError } from '../src/lib/ls-api';

function ymd(offsetDays = 0): string {
  const k = new Date(Date.now() + 9 * 3600 * 1000 - offsetDays * 86400_000);
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, '0')}${String(k.getUTCDate()).padStart(2, '0')}`;
}

async function dump(label: string, fn: () => Promise<{ rspCd: string; rspMsg: string; out1: any[]; outBlock: any }>, log: any) {
  try {
    const r = await fn();
    const keys = r.out1.length ? Object.keys(r.out1[0]) : Object.keys(r.outBlock || {});
    log.info(`[YEOKMAE-PROBE ${label}] rsp_cd='${r.rspCd || '(빈)'}' rows=${r.out1.length} outBlock1Keys=[${keys.join(',')}]${r.rspMsg ? ` msg='${r.rspMsg}'` : ''}`);
    if (r.out1.length) {
      log.info(`  first=${JSON.stringify(r.out1[0])}`);
      log.info(`  last=${JSON.stringify(r.out1[r.out1.length - 1])}`);
    } else if (Object.keys(r.outBlock || {}).length) {
      log.info(`  outBlock=${JSON.stringify(r.outBlock)}`);
    }
  } catch (e) {
    if (e instanceof LSApiError) log.warn(`[YEOKMAE-PROBE ${label}] ERR rsp_cd=${e.rspCd ?? e.kind} msg=${e.message}`);
    else log.warn(`[YEOKMAE-PROBE ${label}] EXCEPTION ${String(e)}`);
  }
}

async function main() {
  loadEnvLocal();
  const log = createLogger('yeokmae-probe-daily');
  log.info('===== 역매공파 일봉 TR 프로브 (KR/US 후보 TR 원문 필드 확인) — 주문 없음 =====');
  let cfg; try { cfg = loadConfig(); } catch (e) { log.error(String(e)); process.exit(1); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); } catch (e) { log.error(`토큰 실패: ${scrub(String(e))}`); process.exit(1); return; }

  const krSym = process.argv[2] || '005930';
  const sdate = ymd(400), edate = ymd(0);

  log.info('──── KR 일봉 후보 TR (CANDIDATE InBlock — 필드 미확인, 응답으로 확인) ────');
  // t8410 주식종목별기간별주가 / t8413 주식차트(일주월) — 후보 InBlock(공식 확인 필요)
  await dump('KR t8410', () => lsDomesticChartRaw(token, 't8410', { t8410InBlock: { shcode: krSym, gubun: '2', qrycnt: 700, sdate, edate, cts_date: '', comp_yn: 'N' } }), log);
  await dump('KR t8413', () => lsDomesticChartRaw(token, 't8413', { t8413InBlock: { shcode: krSym, gubun: '2', qrycnt: 700, sdate, edate, cts_date: '', comp_yn: 'N', sujung: 'Y' } }), log);

  log.info('──── US 일봉 후보 TR (g3103 일주월 / g3204 일주월년) ────');
  const us = loadUSSymbols();
  const provided = process.argv[3];
  const usSym = provided ? us.ok.find(s => s.symbol === provided) : (us.ok.find(s => s.symbol === 'AAPL') ?? us.ok[0]);
  const sym = usSym ?? { symbol: 'AAPL', exchange: 'NASDAQ', exchcd: '82' };
  const delaygb = resolveUSQuote().delaygb ?? 'R';
  const keysymbol = sym.exchcd + sym.symbol;
  await dump('US g3103(gubun=0 일)', () => lsOverseasChartRaw(token, 'g3103', { delaygb, keysymbol, exchcd: sym.exchcd, symbol: sym.symbol, gubun: '0', qrycnt: 700, comp_yn: 'N', sdate, edate }), log);
  await dump('US g3204(gubun=0 일)', () => lsOverseasChartRaw(token, 'g3204', { delaygb, keysymbol, exchcd: sym.exchcd, symbol: sym.symbol, gubun: '0', qrycnt: 700, comp_yn: 'N', sdate, edate }), log);

  log.info('──── 확인 항목 ────');
  log.info('  · 어느 TR 이 rsp_cd 정상 + 일봉 rows>0 을 반환하는가');
  log.info('  · OutBlock1 의 date/open/high/low/close/volume/거래대금 실제 필드명');
  log.info('  · 수정주가 여부(sujung 등), 최대 취득 건수, 연속조회(tr_cont) 지원 여부');
  log.info('  ⚠️ 위 InBlock 은 CANDIDATE. 실제 필드가 확인되면 정식 일봉 fetcher 를 구현(추측 금지).');
}
main();
