// Phase 1 진단 — 로컬 Windows 프로세스에서 LS 토큰 발급 + 국내/해외 잔고 확인.
// 실행: npm run ls:diag
// 비밀값은 .env.local 에서만 읽고, 콘솔/파일 로그에는 마스킹된 값만 남긴다.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getPublicIp, runBalanceCheck, getTokenFor, resolveUSQuote, type LocalLSConfig } from './ls-client';
import { keyFingerprint } from './mask';
import { probeLSUSQuote } from '../src/lib/ls-api';
import type { Logger } from './logger';

// req 6·7: 동일 AAPL g3101 요청을 KR 키 vs US 키 토큰으로 각각 호출해 rsp_cd 비교.
async function runKeyTest(cfg: LocalLSConfig, log: Logger) {
  const q = resolveUSQuote();
  const delaygb = q.delaygb ?? 'R';   // 키 비교 목적이므로 공식 확인값 R 로 진행
  log.info(`===== LS_US_KEY_TEST: AAPL g3101 을 KR키 vs US키 로 비교 (delaygb=${delaygb}) =====`);
  for (const [label, pair, market] of [['KR', cfg.kr, 'kr'], ['US', cfg.us, 'us']] as const) {
    try {
      const token = await getTokenFor(pair, market);
      const p = await probeLSUSQuote(token, 'AAPL', '82', delaygb);
      log.info(`[KEYTEST g3101 AAPL] via ${label} key(${keyFingerprint(pair.appKey)}) → rsp_cd='${p.rspCd}' rsp_msg='${p.rspMsg}' price=${p.price} textLen=${p.diag?.textLen ?? '-'}`);
    } catch (e) {
      log.error(`[KEYTEST g3101 AAPL] via ${label} key(${keyFingerprint(pair.appKey)}) 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log.info('판정: US키 rsp_cd="00000" 이고 KR키 rsp_cd="" 이면 → 해외는 US 전용 키가 필요함이 확정.');
}

async function main() {
  loadEnvLocal();
  const log = createLogger('ls-diag');
  log.info('===== LS Phase 1 진단 시작 (observe-only, 주문 없음) =====');

  const ip = await getPublicIp();
  log.info(`현재 공인 IP: ${ip ?? '(확인 실패)'} — 이 IP 가 LS Open API 에 등록돼 있어야 합니다.`);

  let cfg;
  try { cfg = loadConfig(); }
  catch (e) { log.error(String(e)); process.exit(1); return; }

  // req 6: 키 비교 진단은 LS_US_KEY_TEST=true 일 때만 실행
  if (process.env.LS_US_KEY_TEST === 'true') { await runKeyTest(cfg, log); }

  // [DIAG] 원문 로그는 기본 비활성 — 필요 시 .env.local 에 LS_DIAG_RAW=true (req 14)
  const r = await runBalanceCheck(cfg, log, { diagRaw: process.env.LS_DIAG_RAW === 'true' });

  log.info('----- 결과 요약 -----');
  log.info(JSON.stringify({
    broker: 'LS', observe_only: true, orders_submitted: 0,
    account_masked: r.account_masked, account_suffix: r.account_suffix,
    token_ok: r.token_ok,
    kr_balance_ok: r.kr_balance_ok, kr_rsp_cd: r.kr_rsp_cd, kr_total_eval: r.kr_total_eval, kr_orderable_cash: r.kr_orderable_cash,
    us_balance_ok: r.us_balance_ok, us_rsp_cd: r.us_rsp_cd, us_total_eval_krw: r.us_total_eval_krw,
    errors: r.errors,
  }, null, 2));
  log.info(`로그 파일: ${log.file}`);

  const ok = r.token_ok && r.kr_balance_ok && r.us_balance_ok;
  log.info(ok ? '✅ Phase 1 검증 성공 (토큰·국내·해외 잔고 OK)' : '❌ 일부 실패 — 위 errors/IP 등록 확인');
  process.exit(ok ? 0 : 1);
}
main();
