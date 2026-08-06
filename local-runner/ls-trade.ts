// 로컬 트레이드 러너 — 실행: npm run ls:trade
// 현재 단계(Phase 1 검증 후): 잔고 점검 + 전략엔진 로드 확인까지.
// ⚠️ 시세/15분봉/주문(Phase 2)은 LS 공식 TR 확정 후 추가 — 아직 주문을 내지 않는다.
// 안전장치 2중: (1) observe-only 기본값, (2) 주문 구현 자체가 미완(무조건 차단).
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, runBalanceCheck } from './ls-client';
// 유지 대상 엔진(볼린저/RSI)을 로컬에서도 그대로 재사용함을 확인
import { calcBB, calcRSI, getBBSignal } from '../src/lib/bollinger';

async function main() {
  loadEnvLocal();
  const log = createLogger('ls-trade');
  log.info('===== LS 트레이드 러너 =====');

  let cfg;
  try { cfg = loadConfig(); }
  catch (e) { log.error(String(e)); process.exit(1); return; }

  const observeOnly = !cfg.liveTrading;   // LS_LIVE_TRADING=true 아니면 observe-only
  log.info(`모드: ${observeOnly ? 'OBSERVE-ONLY (주문 없음)' : 'LIVE 요청됨 (LS_LIVE_TRADING=true)'}`);

  // Phase 1 게이트: 잔고 점검이 통과해야 다음 단계로 간다.
  const r = await runBalanceCheck(cfg, log);
  if (!(r.token_ok && r.kr_balance_ok && r.us_balance_ok)) {
    log.error('Phase 1(토큰·잔고) 미통과 → 중단. ls:diag 로 먼저 점검하세요.');
    process.exit(1); return;
  }

  // 엔진 로드 확인(유지 대상): 실제 시세 대신 로드/호출 가능성만 검증.
  const loaded = typeof calcBB === 'function' && typeof calcRSI === 'function' && typeof getBBSignal === 'function';
  log.info(`전략엔진(BB/RSI/getBBSignal) 로드: ${loaded ? 'OK' : '실패'}`);

  // ── Phase 2 경계: 시세/15분봉/주문은 아직 미구현 ──
  log.warn('Phase 2(LS 시세·15분봉·주문 TR)는 아직 미구현입니다. 공식 TR 확정 후 추가합니다.');
  if (cfg.liveTrading) {
    log.error('LS_LIVE_TRADING=true 이지만 주문 기능이 아직 없어 주문을 실행하지 않습니다 (안전 차단).');
  }
  log.info(`orders_submitted=0 (observe_only=${observeOnly})`);
  process.exit(0);
}
main();
