// 역매공파 US 일봉 페이징 프로브 (P0-32D) — 실행: npm run yeokmae:probe-us-daily-pages -- AAPL
//   g3204 단일창 500봉<600 → 700~800 unique 확보 방법 실측. 첫 창 oldest 보다 과거가 실제 반환되는지 확인.
//   동일 500봉 반복(진전 없음)은 성공으로 간주하지 않는다. 주문 없음.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached, resolveUSQuote } from './ls-client';
import { loadUSSymbols } from './universe';
import { makeScrubber } from './mask';
import { fetchUSDaily } from './yeokmae/us-daily';

async function main() {
  loadEnvLocal();
  const log = createLogger('yeokmae-probe-us-daily-pages');
  const want = (process.argv[2] || 'AAPL').toUpperCase();
  log.info(`===== US 일봉 페이징 프로브 ${want} (g3204) — 주문 없음 =====`);
  let cfg; try { cfg = loadConfig(); } catch (e) { log.error(String(e)); process.exit(1); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); } catch (e) { log.error(`토큰 실패: ${scrub(String(e))}`); process.exit(1); return; }

  const us = loadUSSymbols();
  const sym = us.ok.find(s => s.symbol === want);
  if (!sym) { log.error(`US 종목 미지원/미확인: ${want} (universe 에 없음 — exchcd 추측 금지)`); process.exit(2); return; }
  const delaygb = resolveUSQuote().delaygb ?? 'R';
  log.info(`대상 symbol=${sym.symbol} exchange=${sym.exchange} exchcd=${sym.exchcd} delaygb=${delaygb}`);

  const nowMs = Date.now();
  const res = await fetchUSDaily(token, { symbol: sym.symbol, exchcd: sym.exchcd, delaygb }, { nowMs, targetBars: 800, windowDays: 1200, maxPages: 10 });
  if (!res.ok) { log.error(`[US-DAILY-PAGE] 실패: ${res.error}`); process.exit(2); return; }

  log.info('[US-DAILY-PAGE] page / requestDates / rows / newUnique / first / last / tr_cont / tr_cont_key');
  let stalled = false;
  for (const p of res.pages) {
    if (p.page > 1 && p.newUnique <= 0) stalled = true;
    log.info(`  page=${p.page} req=${p.requestSdate}~${p.requestEdate} rows=${p.rows} newUnique=${p.newUnique} first=${p.firstDate} last=${p.lastDate} tr_cont='${p.resTrCont}' tr_cont_key='${p.resTrContKey}' body_cts='${p.bodyCursor}'`);
  }
  log.info('──── 판정 ────');
  log.info(`  총 unique 일봉=${res.uniqueBars} (firstDate=${res.firstDate} lastDate=${res.lastDate})`);
  log.info(`  600+ 확보=${res.uniqueBars >= 600 ? 'YES' : 'NO'} / 700+ 확보=${res.uniqueBars >= 700 ? 'YES' : 'NO'}`);
  const headerContSeen = res.pages.some(p => p.resTrCont === 'Y' && !!p.resTrContKey);
  log.info(`  DATE_WINDOW 진전=${!stalled ? 'YES(창 이동으로 과거 누적)' : 'STALL(동일 500봉 반복 감지 — 방식 재검토)'}`);
  log.info(`  헤더 tr_cont='Y' 관측=${headerContSeen ? 'YES(HEADER_CONT 병행 가능)' : 'NO'}`);
  log.info('  ⚠️ 첫 창 oldest 보다 과거 date 가 실제 나와야 진전. 동일 first/last 반복이면 pagination 미작동.');
  log.info('[YEOKMAE-SAFETY] 관찰 전용 · 주문 0');
}
main();
