// 역매공파 소액 PILOT 프리뷰 (P0-35P) — 실행: npm run yeokmae:pilot-preview -- US|KR [PRICE]
//   ⚠️ 실제 주문 전송 없음. <market>.real-signals.json 의 confirmed 화살표 종목만 PILOT 후보로 변환하고
//      PILOT 게이트 + [YEOKMAE-PILOT-CHECKLIST] 출력. 하나라도 불명확(false)이면 fail-closed(allowed=false).
//   PILOT 은 사용자 승인 소액 실계정 시험 — 검증완료 아님(STRATEGY_VALIDATED=false / SEMANTICS_VERIFIED=false 유지).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildYeokmaeLiveCandidate, evaluateYeokmaePilotGate, formatYeokmaePilotChecklist, formatYeokmaeExitPolicy,
  DEFAULT_YEOKMAE_EXIT_CONFIG, YEOKMAE_PILOT_MAX_POSITIONS,
  YEOKMAE_STRATEGY_VALIDATED, YEOKMAE_SEMANTICS_VERIFIED,
  type YeokmaeSignalType,
} from '../src/lib/yeokmae';
import { YEOKMAE_DAILY_ROOT } from './yeokmae-daily-cache';
import { YeokmaePositionStore } from './yeokmae-position-store';

const SIGNAL_KEYS: YeokmaeSignalType[] = ['112_ORIGINAL', '224_ORIGINAL', '112_UPGRADE', '224_UPGRADE', 'LONG_TERM'];

function main() {
  const market = ((process.argv[2] || 'US').toUpperCase() === 'KR' ? 'KR' : 'US') as 'KR' | 'US';
  const price = Number(process.argv[3] || 0) || 0;
  const budgetUSD = Number(process.env.LS_US_PER_TRADE_BUDGET_USD || 60) || 60;
  const liveTrading = process.env.LS_LIVE_TRADING === 'true';
  const yeokmaeLive = process.env.YEOKMAE_LIVE_TRADING === 'true';
  const pilotLive = process.env.YEOKMAE_PILOT_LIVE === 'true';
  const legacyBbBlocked = process.env.LEGACY_BB_LIVE_ENABLED !== 'true';
  const assumeSafety = process.env.YEOKMAE_LIVE_ASSUME_SAFETY === 'true';

  console.log(`===== [YEOKMAE-PILOT-PREVIEW] market=${market} — 소액 PILOT 실거래 프리뷰 (⚠️ 주문 전송 없음) =====`);
  console.log(`[YEOKMAE-SAFETY] LS_LIVE_TRADING=${liveTrading} YEOKMAE_LIVE_TRADING=${yeokmaeLive} YEOKMAE_PILOT_LIVE=${pilotLive} · YEOKMAE_STRATEGY_VALIDATED=${YEOKMAE_STRATEGY_VALIDATED} YEOKMAE_SEMANTICS_VERIFIED=${YEOKMAE_SEMANTICS_VERIFIED} REAL_ORDER_FROM_YEOKMAE=false`);
  console.log(formatYeokmaeExitPolicy(DEFAULT_YEOKMAE_EXIT_CONFIG));
  if (assumeSafety) console.log(`[YEOKMAE-PILOT] ⚠️ YEOKMAE_LIVE_ASSUME_SAFETY=true → 안전게이트 SIMULATED(실집행 아님).`);
  else console.log(`[YEOKMAE-PILOT] 안전게이트(cash-only/통합증거금/pending/reconciliation/idempotency)는 실행시 기존 US BUY 파이프라인이 강제 — 프리뷰에선 미평가(✗).`);

  const posStore = new YeokmaePositionStore(); posStore.load();
  const currentYeokmaePositions = posStore.all().length;

  const file = join(YEOKMAE_DAILY_ROOT, `${market}.real-signals.json`);
  if (!existsSync(file)) {
    console.log(`[YEOKMAE-PILOT-PREVIEW] 신호 파일 없음: ${file} → collector 실행 필요(confirmed 화살표 발생 시 저장).`);
    console.log(`[YEOKMAE-PILOT-STATUS] pilotCandidates=0 currentYeokmaePositions=${currentYeokmaePositions}/${YEOKMAE_PILOT_MAX_POSITIONS} — 실주문 미전송.`);
    return;
  }
  let signals: any[] = [];
  try { signals = JSON.parse(readFileSync(file, 'utf8')).signals ?? []; } catch { console.error(`파싱 실패: ${file}`); process.exit(2); }

  const safety = {
    cashOnly: assumeSafety, capitalGuardOk: assumeSafety, perSymbolBudgetOk: assumeSafety && price > 0,
    noPending: assumeSafety, reconciliationOk: assumeSafety, notDuplicateOrder: assumeSafety,
  };
  const calcQty = price > 0 ? Math.floor(budgetUSD / price) : 0;

  let candidateCount = 0, allowedCount = 0;
  for (const s of signals) {
    const matchedSignals = SIGNAL_KEYS.filter(k => s[k] === true);
    const cand = buildYeokmaeLiveCandidate({ symbol: s.symbol, exchange: s.exchange, confirmedDate: s.confirmedDate, matchedSignals, isProvisional: false, searcherFormula: !!s.searcherFormula, verifiedFailed: s.verifiedFailed ?? [], unverifiedExternal: s.unverified ?? ['A', 'B', 'C', 'T'] });
    if (!cand) continue;
    candidateCount++;
    const gateInput = {
      candidate: cand, liveTrading, yeokmaeLive, pilotLive, legacyBbBlocked, ...safety,
      currentYeokmaePositions, maxPilotPositions: YEOKMAE_PILOT_MAX_POSITIONS,
    };
    const gate = evaluateYeokmaePilotGate(gateInput);
    console.log('');
    console.log(formatYeokmaePilotChecklist(gateInput, { strategyTag: 'YEOKMAE', orderBudgetUSD: budgetUSD, calcQty, committedKRW: 0, remainingKRW: 0, sellPolicyArmed: true, exitConfig: DEFAULT_YEOKMAE_EXIT_CONFIG }));
    console.log(`[YEOKMAE-PILOT-GATE] symbol=${cand.symbol} allowed=${gate.allowed} reasons=[${gate.reasons.join(',')}]`);
    if (gate.allowed) allowedCount++;
    if (candidateCount === 1) break;   // PILOT 은 1개만 — 첫 후보만 평가(2번째 신규 금지)
  }

  console.log(`\n[YEOKMAE-PILOT-STATUS] pilotCandidates=${candidateCount} gateAllowed=${allowedCount} currentYeokmaePositions=${currentYeokmaePositions}/${YEOKMAE_PILOT_MAX_POSITIONS} — 실주문 미전송(프리뷰).`);
  console.log(`  PILOT = 사용자 승인 소액 실계정 시험 — 검증완료 아님. 실제 POST 는 env(LS_LIVE_TRADING·YEOKMAE_LIVE_TRADING·YEOKMAE_PILOT_LIVE) + 실 파이프라인에서만.`);
}
main();
