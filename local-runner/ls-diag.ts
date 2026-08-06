// Phase 1 진단 — 로컬 Windows 프로세스에서 LS 토큰 발급 + 국내/해외 잔고 확인.
// 실행: npm run ls:diag
// 비밀값은 .env.local 에서만 읽고, 콘솔/파일 로그에는 마스킹된 값만 남긴다.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getPublicIp, runBalanceCheck } from './ls-client';

async function main() {
  loadEnvLocal();
  const log = createLogger('ls-diag');
  log.info('===== LS Phase 1 진단 시작 (observe-only, 주문 없음) =====');

  const ip = await getPublicIp();
  log.info(`현재 공인 IP: ${ip ?? '(확인 실패)'} — 이 IP 가 LS Open API 에 등록돼 있어야 합니다.`);

  let cfg;
  try { cfg = loadConfig(); }
  catch (e) { log.error(String(e)); process.exit(1); return; }

  const r = await runBalanceCheck(cfg, log);

  log.info('----- 결과 요약 -----');
  log.info(JSON.stringify({
    broker: 'LS', observe_only: true, orders_submitted: 0,
    account_masked: r.account_masked, account_suffix: r.account_suffix,
    token_ok: r.token_ok,
    kr_balance_ok: r.kr_balance_ok, kr_total_eval: r.kr_total_eval, kr_orderable_cash: r.kr_orderable_cash,
    us_balance_ok: r.us_balance_ok, us_total_eval_krw: r.us_total_eval_krw,
    errors: r.errors,
  }, null, 2));
  log.info(`로그 파일: ${log.file}`);

  const ok = r.token_ok && r.kr_balance_ok && r.us_balance_ok;
  log.info(ok ? '✅ Phase 1 검증 성공 (토큰·국내·해외 잔고 OK)' : '❌ 일부 실패 — 위 errors/IP 등록 확인');
  process.exit(ok ? 0 : 1);
}
main();
