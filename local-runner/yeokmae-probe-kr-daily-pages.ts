// 역매공파 KR 일봉 페이징 프로브 (P0-32C) — 실행: npm run yeokmae:probe-kr-daily-pages -- 005930
//   목적: 600~800봉 확보용 pagination 방식 실측. 페이지별 rows/firstDate/lastDate/tr_cont/tr_cont_key/body cursor/
//        누적 unique/duplicate 를 출력. 동일 페이지 반복(진전 없음)은 성공으로 간주하지 않는다. 주문 없음.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached } from './ls-client';
import { makeScrubber } from './mask';
import { fetchKRDaily } from './yeokmae/kr-daily';

async function main() {
  loadEnvLocal();
  const log = createLogger('yeokmae-probe-kr-daily-pages');
  const symbol = process.argv[2] || '005930';
  const useAlt = (process.argv[3] || '').toLowerCase() === 't8410';
  log.info(`===== KR 일봉 페이징 프로브 ${symbol} (${useAlt ? 't8410' : 't8413'}) — 주문 없음 =====`);
  let cfg; try { cfg = loadConfig(); } catch (e) { log.error(String(e)); process.exit(1); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); } catch (e) { log.error(`토큰 실패: ${scrub(String(e))}`); process.exit(1); return; }

  const nowMs = Date.now();
  const res = await fetchKRDaily(token, symbol, { nowMs, targetBars: 800, windowDays: 1500, maxPages: 10, useAlt });
  if (!res.ok) { log.error(`[KR-PAGES-PROBE] 실패: ${res.error}`); process.exit(2); return; }

  log.info('[KR-PAGES-PROBE] page/rows/firstDate/lastDate/tr_cont/tr_cont_key/body_cts_date/cumUnique/dup');
  let prevCum = 0; let stalled = false;
  for (const p of res.pages) {
    const grew = p.cumulativeUnique - prevCum;
    if (grew <= 0 && p.page > 1) stalled = true;
    log.info(`  page=${p.page} rows=${p.rows} first=${p.firstDate} last=${p.lastDate} tr_cont='${p.resTrCont}' tr_cont_key='${p.resTrContKey}' body_cts_date='${p.bodyCursor}' cumUnique=${p.cumulativeUnique}(+${grew}) dup=${p.duplicates}`);
    prevCum = p.cumulativeUnique;
  }
  log.info('──── 판정 ────');
  log.info(`  총 unique 일봉=${res.uniqueBars} (firstDate=${res.firstDate} lastDate=${res.lastDate})`);
  log.info(`  600+ 확보=${res.uniqueBars >= 600 ? 'YES' : 'NO'} / 700+ 확보=${res.uniqueBars >= 700 ? 'YES' : 'NO'}`);
  const headerContSeen = res.pages.some(p => p.resTrCont === 'Y' && !!p.resTrContKey);
  const bodyCursorSeen = res.pages.some(p => !!p.bodyCursor);
  log.info(`  DATE_WINDOW 진전=${!stalled ? 'YES(창 이동으로 누적)' : 'STALL(동일페이지 반복 감지 — 방식 재검토 필요)'}`);
  log.info(`  헤더 tr_cont='Y' 관측=${headerContSeen ? 'YES(HEADER_CONT 병행 가능)' : 'NO'} / body cts_date 관측=${bodyCursorSeen ? 'YES(BODY_CURSOR 후보)' : 'NO'}`);
  log.info('  ⚠️ 동일 first/last 가 반복되면(진전 없음) pagination 미작동 — 창/커서 방식 재확인 필요.');
}
main();
