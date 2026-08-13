// 역매공파 LIVE 후보 연결 프리뷰 (P0-33) — 실행: npm run yeokmae:live-candidates -- US
//   ⚠️ 실제 주문 전송 없음. collector 의 US.real-signals.json(=confirmed 화살표 종목)만 LIVE 후보로 변환하고,
//      최종 게이트를 평가해 [YEOKMAE-LIVE-CANDIDATE]/[YEOKMAE-LIVE-GATE]/[YEOKMAE-LIVE-CHECKLIST] 출력.
//   후보 조건: confirmed 봉 + 5신호 중 1개+ matched. reverse-only/near-match/provisional 은 후보 아님.
//   최종 POST = liveTrading ∧ yeokmaeLive ∧ YEOKMAE_STRATEGY_VALIDATED(코드상수 false) ∧ 기존 안전게이트.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildYeokmaeLiveCandidate, evaluateYeokmaeLiveGate, formatYeokmaeLiveChecklist,
  formatYeokmaeExitPolicy, DEFAULT_YEOKMAE_EXIT_CONFIG,
  YEOKMAE_STRATEGY_VALIDATED, YEOKMAE_SELL_RULE_DEFINED, YEOKMAE_BUY_SELL_POLICY,
  YEOKMAE_SEMANTICS_VERIFIED, YEOKMAE_SEMANTICS_STATUS, yeokmaeActivationReadiness,
  type YeokmaeSignalType,
} from '../src/lib/yeokmae';
import { YEOKMAE_DAILY_ROOT } from './yeokmae-daily-cache';

const SIGNAL_KEYS: YeokmaeSignalType[] = ['112_ORIGINAL', '224_ORIGINAL', '112_UPGRADE', '224_UPGRADE', 'LONG_TERM'];

function main() {
  const market = ((process.argv[2] || 'US').toUpperCase() === 'KR' ? 'KR' : 'US') as 'KR' | 'US';
  console.log(`===== [YEOKMAE-LIVE-CANDIDATES] market=${market} — 실거래 연결 프리뷰 (⚠️ 주문 전송 없음) =====`);

  // 전략 토글(env) — worker 상수 YEOKMAE_STRATEGY_VALIDATED 는 코드상수(false).
  const liveTrading = process.env.LS_LIVE_TRADING === 'true';
  const yeokmaeLive = process.env.YEOKMAE_LIVE_TRADING === 'true';
  const legacyBbBlocked = process.env.LEGACY_BB_LIVE_ENABLED !== 'true';   // false 여야 정상(차단됨)
  // 기존 안전장치 상태: 이 프리뷰는 실제 주문 파이프라인을 호출하지 않음 → 기본 미평가(✗).
  //   YEOKMAE_LIVE_ASSUME_SAFETY=true 로 '모든 안전 통과 가정(SIMULATED)' 시에도 strategyValidated=false 로 차단됨을 시연.
  const assumeSafety = process.env.YEOKMAE_LIVE_ASSUME_SAFETY === 'true';
  const safety = {
    cashOnly: assumeSafety, capitalGuardOk: assumeSafety, perSymbolBudgetOk: assumeSafety,
    noPending: assumeSafety, reconciliationOk: assumeSafety, notDuplicateOrder: assumeSafety, notSameDayReentry: assumeSafety,
  };

  console.log(`[YEOKMAE-SAFETY] LEGACY_BB_LIVE=${process.env.LEGACY_BB_LIVE_ENABLED === 'true'} · YEOKMAE_LIVE_TRADING=${yeokmaeLive} · YEOKMAE_STRATEGY_VALIDATED=${YEOKMAE_STRATEGY_VALIDATED} · REAL_ORDER_FROM_YEOKMAE=false`);
  console.log(`[YEOKMAE-SELL] ruleDefined=${YEOKMAE_SELL_RULE_DEFINED} policy=${YEOKMAE_BUY_SELL_POLICY} — ⚠️ BB SELL 을 역매공파 SELL 로 사용하지 않음(임의 손절/익절 없음).`);
  // rule 9: 첫 실주문 전 EXIT-POLICY 도 함께 출력.
  console.log(formatYeokmaeExitPolicy(DEFAULT_YEOKMAE_EXIT_CONFIG));
  // rule 3~5: semantics 검증 상태 + 활성화 준비도(HTS 대조 완료 전에는 절대 활성화 불가).
  const semStat = YEOKMAE_SEMANTICS_STATUS;
  console.log(`[YEOKMAE-SEMANTICS-STATUS] verified=${YEOKMAE_SEMANTICS_VERIFIED} shiftDir=${semStat.shiftDir} stddevPopulation=${semStat.stddevPopulation} ichimokuDisplaced=${semStat.ichimokuDisplaced} emaSeed=${semStat.emaSeed}`);
  const activation = yeokmaeActivationReadiness({ semanticsVerified: YEOKMAE_SEMANTICS_VERIFIED, verifiedSignalSymbols: 0 });
  console.log(`[YEOKMAE-ACTIVATION] canActivate=${activation.canActivate} blockers=[${activation.reasons.join(',')}] (HTS 1:1 대조 완료 + 2종목 재현 전 YEOKMAE_STRATEGY_VALIDATED=true 금지)`);
  if (assumeSafety) console.log(`[YEOKMAE-LIVE] ⚠️ YEOKMAE_LIVE_ASSUME_SAFETY=true → 안전게이트 SIMULATED(실집행 아님). 최종 게이트는 strategyValidated 로 여전히 차단.`);
  else console.log(`[YEOKMAE-LIVE] 안전게이트(cash-only/통합증거금/예수금/pending/reconciliation/idempotency/자본100만/종목$60/당일재진입)는 실행시 기존 US BUY 파이프라인이 강제 — 프리뷰에선 미평가(✗).`);

  const file = join(YEOKMAE_DAILY_ROOT, `${market}.real-signals.json`);
  if (!existsSync(file)) {
    console.log(`[YEOKMAE-LIVE-CANDIDATES] 신호 파일 없음: ${file}`);
    console.log(`  → npm run yeokmae:build-us-history 로 collector 실행(실 confirmed 화살표 발생 시 저장됨). 현재 confirmed 화살표 0 이면 후보 0(정상).`);
    reportReady(false);
    return;
  }
  let signals: any[] = [];
  try { signals = JSON.parse(readFileSync(file, 'utf8')).signals ?? []; } catch { console.error(`[YEOKMAE-LIVE-CANDIDATES] 신호 파일 파싱 실패: ${file}`); process.exit(2); }

  let candidateCount = 0, allowedCount = 0;
  for (const s of signals) {
    const matchedSignals = SIGNAL_KEYS.filter(k => s[k] === true);
    const cand = buildYeokmaeLiveCandidate({
      symbol: s.symbol, exchange: s.exchange, confirmedDate: s.confirmedDate,
      matchedSignals, isProvisional: false,   // real-signals.json 은 confirmed 화살표만 저장
      searcherFormula: !!s.searcherFormula, verifiedFailed: s.verifiedFailed ?? [], unverifiedExternal: s.unverified ?? ['A', 'B', 'C', 'T'],
    });
    if (!cand) continue;   // 화살표 0 등 → 후보 아님
    candidateCount++;
    console.log(`\n[YEOKMAE-LIVE-CANDIDATE] symbol=${cand.symbol} exch=${cand.exchange} confirmedDate=${cand.confirmedDate} matchedSignals=[${cand.matchedSignals.join(',')}] searcherFormula=${cand.searcherFormula}(diagnostic) verifiedFailed=[${cand.verifiedFailed.join(',')}] unverified=[${cand.unverifiedExternal.join(',')}]`);
    const gate = evaluateYeokmaeLiveGate({
      candidate: cand, liveTrading, yeokmaeLive, strategyValidated: YEOKMAE_STRATEGY_VALIDATED,
      legacyBbBlocked, ...safety,
    });
    console.log(`[YEOKMAE-LIVE-GATE] symbol=${cand.symbol} allowed=${gate.allowed} reasons=[${gate.reasons.join(',')}]`);
    console.log(formatYeokmaeLiveChecklist(gate));
    if (gate.allowed) allowedCount++;
  }

  console.log(`\n[YEOKMAE-LIVE-CANDIDATES] signalsInFile=${signals.length} liveCandidates=${candidateCount} gateAllowed=${allowedCount}`);
  if (allowedCount > 0) console.log(`  ⚠️ gateAllowed>0 은 코드상수 YEOKMAE_STRATEGY_VALIDATED=false 인 한 발생 불가 — 발생 시 즉시 점검.`);
  reportReady(candidateCount > 0);
}

function reportReady(hasCandidates: boolean) {
  console.log(`\n──── [YEOKMAE-LIVE-STATUS] ────`);
  console.log(`  YEOKMAE_LIVE_READY=false (연결 준비만 — 실주문 미전송)`);
  console.log(`  YEOKMAE_STRATEGY_VALIDATED=${YEOKMAE_STRATEGY_VALIDATED} (하드 차단 — 원본 HTS 검증 완료 전 절대 true 금지)`);
  console.log(`  REAL_ORDER_FROM_YEOKMAE=false`);
  console.log(`  hasLiveCandidates=${hasCandidates} (confirmed 화살표 종목 유무). 후보가 있어도 최종 게이트가 차단.`);
}
main();
