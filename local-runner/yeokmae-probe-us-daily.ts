// 역매공파 US 일봉 parameter 조합 프로브 (P0-32C) — 실행: npm run yeokmae:probe-us-daily -- AAPL
//   g3103/g3204 가 gubun=0 에서 rows=0 이었다 → TR 폐기 금지. repo 에서 '존재가 확인된' overseas-chart InBlock
//   필드(delaygb/keysymbol/exchcd/symbol/gubun/ncnt/qrycnt/comp_yn/sdate/edate)만 값 조합으로 실측한다.
//   ⚠️ 임의 신규 필드 주입 금지. rows>0 조합을 찾으면 그때만 field map 확정. 주문 없음.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached, resolveUSQuote } from './ls-client';
import { loadUSSymbols } from './universe';
import { makeScrubber } from './mask';
import { lsOverseasChartRaw, LSApiError } from '../src/lib/ls-api';

function ymd(offsetDays = 0): string {
  const k = new Date(Date.now() - offsetDays * 86400_000);
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, '0')}${String(k.getUTCDate()).padStart(2, '0')}`;
}

interface Combo { tr: string; label: string; inBlock: Record<string, unknown> }

async function main() {
  loadEnvLocal();
  const log = createLogger('yeokmae-probe-us-daily');
  log.info('===== US 일봉 parameter 조합 프로브 (repo 확인필드만, 주문 없음) =====');
  let cfg; try { cfg = loadConfig(); } catch (e) { log.error(String(e)); process.exit(1); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); } catch (e) { log.error(`토큰 실패: ${scrub(String(e))}`); process.exit(1); return; }

  const us = loadUSSymbols();
  const want = process.argv[2] || 'AAPL';
  const sym = us.ok.find(s => s.symbol === want) ?? us.ok.find(s => s.symbol === 'AAPL') ?? { symbol: want, exchange: 'NASDAQ', exchcd: '82' };
  const delaygb = resolveUSQuote().delaygb ?? 'R';
  const exchcd = sym.exchcd; const symbol = sym.symbol; const keysymbol = exchcd + symbol;
  const sdate = ymd(1500), edate = ymd(0);
  log.info(`대상 symbol=${symbol} exchcd=${exchcd} keysymbol=${keysymbol} delaygb=${delaygb} sdate=${sdate} edate=${edate}`);

  // repo 확인필드만 값 변형. (1) gubun enum 0/1/2 (2) symbol 형식(plain vs prefixed) (3) date range 유무.
  const combos: Combo[] = [];
  for (const tr of ['g3103', 'g3204']) {
    for (const gubun of ['0', '1', '2']) {
      // (a) plain symbol + keysymbol, date range 지정
      combos.push({ tr, label: `${tr} gubun=${gubun} plain+range`, inBlock: { delaygb, keysymbol, exchcd, symbol, gubun, qrycnt: 700, comp_yn: 'N', sdate, edate } });
      // (b) plain symbol, date range 미지정(빈 문자열)
      combos.push({ tr, label: `${tr} gubun=${gubun} plain+norange`, inBlock: { delaygb, keysymbol, exchcd, symbol, gubun, qrycnt: 700, comp_yn: 'N', sdate: '', edate: '' } });
      // (c) exchange-prefixed symbol(=keysymbol) 형식, date range 지정
      combos.push({ tr, label: `${tr} gubun=${gubun} prefixed+range`, inBlock: { delaygb, keysymbol, exchcd, symbol: keysymbol, gubun, qrycnt: 700, comp_yn: 'N', sdate, edate } });
    }
  }

  let hit: Combo | null = null;
  for (const c of combos) {
    try {
      const r = await lsOverseasChartRaw(token, c.tr, { [`${c.tr}InBlock`]: c.inBlock });
      const keys = r.out1.length ? Object.keys(r.out1[0]) : Object.keys(r.outBlock || {});
      log.info('[US-DAILY-PROBE]');
      log.info(`  tr=${c.tr}`);
      log.info(`  params=${JSON.stringify(c.inBlock)}`);
      log.info(`  rsp_cd=${r.rspCd}`);
      log.info(`  rsp_msg=${r.rspMsg || ''}`);
      log.info(`  rows=${r.out1.length}`);
      log.info(`  outBlock1Keys=[${keys.join(',')}]`);
      if (r.out1.length) {
        log.info(`  first=${JSON.stringify(r.out1[0])}`);
        log.info(`  last=${JSON.stringify(r.out1[r.out1.length - 1])}`);
        if (!hit) hit = c;
      }
    } catch (e) {
      if (e instanceof LSApiError) log.warn(`[US-DAILY-PROBE] ${c.label} ERR rsp_cd=${e.rspCd ?? e.kind} msg=${e.message}`);
      else log.warn(`[US-DAILY-PROBE] ${c.label} EXCEPTION ${scrub(String(e))}`);
    }
  }

  log.info('──── 판정 ────');
  if (hit) {
    log.info(`  ✅ rows>0 조합 발견: tr=${hit.tr} params=${JSON.stringify(hit.inBlock)}`);
    log.info(`  → 위 outBlock1Keys 로 daily-tr-config.ts(US) field map/trCode/pagination 확정 후 fetch 연결.`);
  } else {
    log.warn('  ⛔ 모든 조합 rows=0. US 일봉 TR/parameter 여전히 미확정 → 봉인 유지.');
    log.warn('     남은 미확정: symbol 형식/exchcd 매핑/gubun 의미/date range 요구/keysymbol 규칙/continuation.');
    log.warn('     추가 확인 필요 시 LS 공식 g3103/g3204 문서의 InBlock 예제값으로만 조합 확장(추측 필드 금지).');
  }
  log.info('[YEOKMAE-SAFETY] 관찰 전용 · 주문 0');
}
main();
