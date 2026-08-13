// 역매공파 PILOT 프리플라이트 (P0-35P3) — 실행: npm run yeokmae:pilot-preflight -- KR|US
//   실계정에서 주문 전 게이트를 '전부 실제 조회'(cashOnly/orderableQty/capitalGuard/perSymbolBudget/pending/
//   reconciliation/duplicate/positionCount/calculatedQty)해 출력하되 ⚠️ BUY POST 는 0건. pilot-live 와 동일 게이트.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached } from './ls-client';
import { makeScrubber } from './mask';
import { formatYeokmaeExitPolicy, DEFAULT_YEOKMAE_EXIT_CONFIG, YEOKMAE_STRATEGY_VALIDATED, YEOKMAE_SEMANTICS_VERIFIED } from '../src/lib/yeokmae';
import { pilotPreflight, logPilotPreflight } from './yeokmae-pilot-core';

async function main() {
  loadEnvLocal();
  const log = createLogger('yeokmae-pilot-preflight');
  const market = (process.argv[2] || '').toUpperCase();
  if (market !== 'KR' && market !== 'US') { log.error('사용법: npm run yeokmae:pilot-preflight -- KR | US'); process.exit(1); return; }

  const env = {
    liveTrading: process.env.LS_LIVE_TRADING === 'true',
    yeokmaeLive: process.env.YEOKMAE_LIVE_TRADING === 'true',
    pilotLive: process.env.YEOKMAE_PILOT_LIVE === 'true',
    legacyBbBlocked: process.env.LEGACY_BB_LIVE_ENABLED !== 'true',
    budgetUSD: Number(process.env.LS_US_PER_TRADE_BUDGET_USD || 60) || 60,
    totalCapitalKRW: Number(process.env.LS_US_TOTAL_CAPITAL_KRW || 1000000) || 1000000,
  };
  log.info(`===== [YEOKMAE-PILOT-PREFLIGHT] market=${market} — 실계정 게이트 전량 조회 (⚠️ BUY POST=0) =====`);
  log.info(`[YEOKMAE-SAFETY] LS_LIVE_TRADING=${env.liveTrading} YEOKMAE_LIVE_TRADING=${env.yeokmaeLive} YEOKMAE_PILOT_LIVE=${env.pilotLive} · YEOKMAE_STRATEGY_VALIDATED=${YEOKMAE_STRATEGY_VALIDATED} YEOKMAE_SEMANTICS_VERIFIED=${YEOKMAE_SEMANTICS_VERIFIED}`);
  log.info(formatYeokmaeExitPolicy(DEFAULT_YEOKMAE_EXIT_CONFIG));

  let cfg; try { cfg = loadConfig(); } catch (e) { log.error(`[YEOKMAE-PILOT-PREFLIGHT] FAIL_CLOSED(config: ${String(e)}) → 조회 불가.`); process.exit(2); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); } catch (e) { log.error(`[YEOKMAE-PILOT-PREFLIGHT] FAIL_CLOSED(token: ${scrub(String(e))}) → 조회 불가.`); process.exit(2); return; }

  const pf = await pilotPreflight(cfg, token, market as 'KR' | 'US', env, scrub);
  logPilotPreflight((m) => log.info(m), pf);
  log.info(`[YEOKMAE-PILOT-PREFLIGHT] BUY POST=0 (게이트 조회 전용). PILOT_REAL_ORDER_ENABLED=${pf.realOrderEnabled} — 실주문은 pilot-live 에서만.`);
}
main();
