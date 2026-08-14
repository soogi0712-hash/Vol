// 역매공파 US 일봉 parameter 조합 프로브 (P0-32C 재설계) — 실행: npm run yeokmae:probe-us-daily -- AAPL
//   ⚠️ gubun=0 은 실측상 rows=0(오해의 원인). 확정 후보(g3204/gubun='2'/plain/range)를 최우선으로 실측.
//   근거 있는 후보만(buildUSProbeCombos) — 임의 gubun 0~9 brute-force 금지. rows>0 조합 발견 시에만 확정. 주문 없음.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached, resolveUSQuote } from './ls-client';
import { loadUSSymbols } from './universe';
import { makeScrubber } from './mask';
import { lsOverseasChartRaw, LSApiError } from '../src/lib/ls-api';
import { buildUSProbeCombos, type USProbeCombo } from './yeokmae/us-daily-probe';

function ymd(offsetDays = 0): string {
  const k = new Date(Date.now() - offsetDays * 86400_000);
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, '0')}${String(k.getUTCDate()).padStart(2, '0')}`;
}

async function main() {
  loadEnvLocal();
  const log = createLogger('yeokmae-probe-us-daily');
  log.info('===== US 일봉 parameter 조합 프로브 (근거 후보 우선순위, 주문 없음) =====');
  let cfg; try { cfg = loadConfig(); } catch (e) { log.error(String(e)); process.exit(1); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); log.info('LS 토큰 OK'); } catch (e) { log.error(`토큰 실패: ${scrub(String(e))}`); process.exit(1); return; }

  const us = loadUSSymbols();
  const want = (process.argv[2] || 'AAPL').toUpperCase();
  const sym = us.ok.find(s => s.symbol === want) ?? us.ok.find(s => s.symbol === 'AAPL') ?? { symbol: want, exchange: 'NASDAQ', exchcd: '82' };
  const delaygb = resolveUSQuote().delaygb ?? 'R';
  const exchcd = sym.exchcd; const symbol = sym.symbol; const keysymbol = exchcd + symbol;
  const sdate = ymd(1500), edate = ymd(0);
  log.info(`대상 symbol=${symbol} exchcd=${exchcd} keysymbol=${keysymbol} delaygb=${delaygb} sdate=${sdate} edate=${edate}`);

  const combos = buildUSProbeCombos({ exchcd, symbol, keysymbol, delaygb, sdate, edate });   // 근거 우선순위 정렬
  let hit: USProbeCombo | null = null;
  for (const c of combos) {
    try {
      const r = await lsOverseasChartRaw(token, c.tr, { [`${c.tr}InBlock`]: c.inBlock });
      const keys = r.out1.length ? Object.keys(r.out1[0]) : Object.keys(r.outBlock || {});
      log.info('[YEOKMAE-US-PROBE]');
      log.info(`  tr=${c.tr} (priority=${c.priority} ${c.label})`);
      log.info(`  request=${JSON.stringify(c.inBlock)}`);
      log.info(`  rsp_cd=${r.rspCd}`);
      log.info(`  rsp_msg=${r.rspMsg || ''}`);
      log.info(`  rows=${r.out1.length}`);
      log.info(`  outBlock1Keys=[${keys.join(',')}]`);
      log.info(`  first=${r.out1.length ? JSON.stringify(r.out1[0]) : 'n/a'}`);
      log.info(`  last=${r.out1.length ? JSON.stringify(r.out1[r.out1.length - 1]) : 'n/a'}`);
      if (r.out1.length && !hit) { hit = c; break; }   // 근거 우선순위 → 첫 rows>0 이 정답. 이후 후보 불필요.
    } catch (e) {
      if (e instanceof LSApiError) log.warn(`[YEOKMAE-US-PROBE] ${c.label} ERR rsp_cd=${e.rspCd ?? e.kind} msg=${e.message}`);
      else log.warn(`[YEOKMAE-US-PROBE] ${c.label} EXCEPTION ${scrub(String(e))}`);
    }
  }

  log.info('──── 판정 ────');
  if (hit) {
    log.info(`  ✅ rows>0 조합 확정: tr=${hit.tr} gubun=${hit.inBlock.gubun} symbolFmt=${hit.inBlock.symbol === keysymbol ? 'prefixed' : 'plain'} request=${JSON.stringify(hit.inBlock)}`);
    log.info(`  → daily-tr-config.ts(US) 는 이미 g3204/gubun='2'/plain 로 배선됨. 위 실측이 동일하면 그대로, 다르면 field map 갱신 후 fetch 연결.`);
    log.info(`  ℹ️ gubun=0/1 rows=0 은 정상(잘못된 gubun) — TR 폐기 근거 아님.`);
  } else {
    log.warn('  ⛔ 모든 근거 후보 rows=0. US 일봉 실계정 응답 확인 필요(overseas-chart 권한/시세권한 포함) → 봉인 유지.');
    log.warn('     원인분류: (a) 계정 해외차트 권한 (b) exchcd/symbol 매핑 (c) gubun 의미 (d) date range 요구.');
    log.warn('     추가 확장은 LS 공식 g3103/g3204 문서의 InBlock 예제값으로만(추측 필드 금지).');
  }
  log.info('[YEOKMAE-SAFETY] 관찰 전용 · 주문 0 · REAL_ORDER_FROM_YEOKMAE=false');
}
main();
