// 역매공파 US 실보유 복원 (P0-35US6) — broker evidence(COSAQ00102 + COSOQ00201 보유)로 원장을 복원한다.
//   ⚠️ 절대 재주문/재POST 금지, candle/order lock 삭제 금지. broker evidence 가 local state 보다 우선.
//   이미 접수된 PRGO 주문(00040 성공)을 재조회로만 확인해 strategyTag=YEOKMAE 원장에 반영한다.
import type { LocalLSConfig } from './ls-client';
import {
  queryLSUSOrderExec, getLSUSHoldings, resolveUSExchcd, LS_US_ORDEREXEC_EMPTY_CODES,
  type LSOrderExec, type LSUSHolding, type OrderExecClassification,
} from '../src/lib/ls-api';
import type { YeokmaePositionStore, YeokmaePosition } from './yeokmae-position-store';
import { DEFAULT_YEOKMAE_EXIT_CONFIG, YEOKMAE_PILOT_MAX_POSITIONS } from '../src/lib/yeokmae';

// COSAQ00102 원문 진단(P0-35US8) — BUSINESS_ERROR 원인 규명용. rsp_cd/rows 를 그대로 노출(신뢰판정 미사용).
export interface YeokmaeRecoverReconDiag {
  ordDate: string; exchcd: string; symbol: string;
  rspCd: string; rspMsg: string; httpStatus: number | null; hasEnvelope: boolean;
  rawRows: number; symbolRows: number;
  ordNo: string; ordQty: number; execQty: number; unfilledQty: number; avgExecPrc: string;
  classification: OrderExecClassification; failureReason: string;
}
export interface YeokmaeUSRecovery {
  symbol: string; exchcd: string;
  ordNo: string | null;
  ordQty: number;         // 오늘 매수 주문수량 합(COSAQ00102 ordPtnCode=02)
  execQty: number;        // 체결수량 합
  unfilledQty: number;    // 미체결수량 합
  entryAvgPrice: number;  // 진입가(broker evidence = 주문지정가 OvrsOrdPrc 체결가중; exec-price 필드 미확정 → 추측 금지)
  holdingBalQty: number;  // 실제 보유수량(COSOQ00201 OutBlock4 AstkBalQty)
  holdingSellableQty: number;  // 매도가능수량(AstkSellAbleQty)
  ledgerQty: number;      // 원장 반영 수량 = 보유수량 우선(>0), 없으면 체결수량
  filled: boolean;        // execQty>0 또는 보유수량>0
  reconClassification: OrderExecClassification;
  reconOk: boolean;       // COSAQ00102 SUCCESS/EMPTY (신뢰)
  holdingsOk: boolean;    // COSOQ00201 조회 성공(신뢰)
  evidenceOk: boolean;    // 두 조회 모두 신뢰 → 원장 반영 허용
  // item4: signal/원장상 YEOKMAE + 실보유>0 인데 recon evidence 불완전 → 미해결 보유(신규 BUY fail-closed 대상).
  unresolvedYeokmaeHolding: boolean;
  reconDiag: YeokmaeRecoverReconDiag;
  reason: string;
}

// ── 순수 복원 코어(테스트용) — 조회결과(rows/holdings)만으로 복원 근거를 계산. 네트워크/부수효과 없음. ──
export function buildYeokmaeUSRecovery(p: {
  symbol: string; exchcd: string;
  rows: LSOrderExec[]; reconClassification: OrderExecClassification; reconOk: boolean;
  holdings: LSUSHolding[]; holdingsOk: boolean;
  // 진단용(선택): 원문 recon 응답. parsedRows 는 BUSINESS_ERROR 여도 원문 rows(신뢰판정 미사용, 표시 전용).
  ordDate?: string; rspCd?: string; rspMsg?: string; httpStatus?: number | null; hasEnvelope?: boolean;
  rawRows?: number; parsedRows?: LSOrderExec[];
  // YEOKMAE 자격(signal metadata 또는 기존 원장). true 여야 미해결 보유(unresolved) 판정 대상.
  yeokmaeEligible?: boolean;
}): YeokmaeUSRecovery {
  const sym = p.symbol.toUpperCase();
  const buyRows = p.rows.filter(r => r.symbol.toUpperCase() === sym && r.ordPtnCode === '02');
  const ordQty = buyRows.reduce((s, r) => s + r.ordQty, 0);
  const execQty = buyRows.reduce((s, r) => s + r.execQty, 0);
  const unfilledQty = buyRows.reduce((s, r) => s + r.unfilledQty, 0);
  // 체결가중 진입가 — exec-price 필드가 공식 미확정이므로 주문지정가(OvrsOrdPrc=ordPrc)를 broker evidence 로 사용.
  const filledRows = buyRows.filter(r => r.execQty > 0);
  const execWeighted = filledRows.reduce((s, r) => s + r.execQty * r.ordPrc, 0);
  const entryAvgPrice = execQty > 0 ? execWeighted / execQty : (buyRows[0]?.ordPrc ?? 0);
  // 주문번호 — 체결 있는 행 우선, 없으면 첫 매수행.
  const ordNo = (filledRows[0]?.ordNo || buyRows[0]?.ordNo) || null;
  const holding = p.holdings.find(h => h.symbol.toUpperCase() === sym) ?? null;
  const holdingBalQty = holding?.balQty ?? 0;
  const holdingSellableQty = holding?.sellableQty ?? 0;
  // 원장 수량 = 실제 보유수량 우선(broker 현재 보유가 진실), 없으면 체결수량.
  const ledgerQty = holdingBalQty > 0 ? holdingBalQty : execQty;
  const filled = execQty > 0 || holdingBalQty > 0;
  const evidenceOk = p.reconOk && p.holdingsOk;
  // item4: YEOKMAE 자격 + 실보유>0 인데 recon evidence 불완전(원장 반영 불가) → 미해결 보유.
  const unresolvedYeokmaeHolding = !!p.yeokmaeEligible && holdingBalQty > 0 && !evidenceOk;
  const reason = unresolvedYeokmaeHolding
    ? `UNRESOLVED_YEOKMAE_HOLDING(실보유 ${holdingBalQty}주 but recon=${p.reconClassification} → 평단 미확정. 신규 BUY 차단, 자동 SELL 미활성)`
    : !evidenceOk
      ? `EVIDENCE_UNTRUSTED(recon=${p.reconClassification}/${p.reconOk} holdingsOk=${p.holdingsOk}) → 원장 미반영(fail-closed)`
      : filled
        ? `FILLED(execQty=${execQty} holdingBalQty=${holdingBalQty} ledgerQty=${ledgerQty} entryAvg=${entryAvgPrice.toFixed(2)})`
        : `NO_FILL(execQty=0 holdingBalQty=0 — 접수만/미체결 또는 보유 없음)`;
  // 진단: parsedRows(원문, BUSINESS_ERROR 여도 유지) 로 PRGO 행을 그대로 노출.
  const diagRows = (p.parsedRows ?? p.rows).filter(r => r.symbol.toUpperCase() === sym && r.ordPtnCode === '02');
  const reconDiag: YeokmaeRecoverReconDiag = {
    ordDate: p.ordDate ?? '-', exchcd: p.exchcd, symbol: sym,
    rspCd: p.rspCd ?? '-', rspMsg: p.rspMsg ?? '-', httpStatus: p.httpStatus ?? null, hasEnvelope: p.hasEnvelope ?? false,
    rawRows: p.rawRows ?? (p.parsedRows ?? p.rows).length, symbolRows: diagRows.length,
    ordNo: (diagRows[0]?.ordNo ?? '-') || '-',
    ordQty: diagRows.reduce((s, r) => s + r.ordQty, 0),
    execQty: diagRows.reduce((s, r) => s + r.execQty, 0),
    unfilledQty: diagRows.reduce((s, r) => s + r.unfilledQty, 0),
    // AvgExecPrc 공식 필드 미확정 → OvrsOrdPrc(주문지정가) 기반 값으로 표시(추측 금지, 라벨 명시).
    avgExecPrc: diagRows.length ? `${diagRows[0].ordPrc}(OvrsOrdPrc·AvgExecPrc필드미확정)` : 'n/a',
    classification: p.reconClassification,
    failureReason: p.reconOk ? '-' : `NON_SUCCESS(rsp_cd=${p.rspCd ?? '-'} classification=${p.reconClassification} — COSAQ00102 성공/EMPTY 코드 미등록 가능)`,
  };
  return {
    symbol: sym, exchcd: p.exchcd, ordNo, ordQty, execQty, unfilledQty, entryAvgPrice,
    holdingBalQty, holdingSellableQty, ledgerQty, filled,
    reconClassification: p.reconClassification, reconOk: p.reconOk, holdingsOk: p.holdingsOk, evidenceOk,
    unresolvedYeokmaeHolding, reconDiag, reason,
  };
}

// ── 보유종목별 복원 계획 (P0-35US7, 순수·테스트용) — exchcd 해결 + YEOKMAE 태깅 자격 판정. ──
//   자격: signal metadata(real-signals 5신호) 또는 기존 YEOKMAE 원장이 있어야 YEOKMAE 로 복원(item2·3).
//   둘 다 없으면 UNKNOWN(임의 태깅 금지 — AIOT/AMSF 같은 기존 BB/수동 보유 보호). exchcd 는 signal > 원장 > universe.
export type HoldingRecoveryAction = 'RECOVER' | 'SKIP_UNKNOWN' | 'SKIP_CONFLICT' | 'SKIP_NO_EXCHCD';
export interface HoldingRecoveryPlan { action: HoldingRecoveryAction; exchcd: string; source: string; strategyTag: 'YEOKMAE' | 'UNKNOWN'; reason: string; }
export function planUSHoldingRecovery(p: {
  symbol: string;
  hasSignal: boolean; signalExchcd?: string | null; signalExchange?: string | null;
  ledgerExists: boolean; ledgerExchcd?: string | null;
  universeExchcd?: string | null;
}): HoldingRecoveryPlan {
  if (!p.hasSignal && !p.ledgerExists) {
    return { action: 'SKIP_UNKNOWN', exchcd: '', source: 'NONE', strategyTag: 'UNKNOWN', reason: 'signal 근거 없음 & YEOKMAE 원장 없음 → 태깅 안 함(기존 BB/수동 보유 보호)' };
  }
  const res = resolveUSExchcd({ storedExchcd: p.signalExchcd ?? p.ledgerExchcd ?? null, storedExchange: p.signalExchange ?? null, universeExchcd: p.universeExchcd ?? null });
  if (res.source === 'CONFLICT') return { action: 'SKIP_CONFLICT', exchcd: '', source: res.source, strategyTag: 'UNKNOWN', reason: res.failureReason };
  if (!res.exchcd) return { action: 'SKIP_NO_EXCHCD', exchcd: '', source: res.source, strategyTag: 'UNKNOWN', reason: res.failureReason };
  return { action: 'RECOVER', exchcd: res.exchcd, source: res.source, strategyTag: 'YEOKMAE', reason: `exchcd=${res.exchcd}(src=${res.source})` };
}

// ── broker 재조회 → 복원 근거 산출(POST 없음: 읽기전용 COSAQ00102 + COSOQ00201). ──
export async function recoverYeokmaeUSFromBroker(
  cfg: LocalLSConfig, token: string,
  p: { symbol: string; exchcd: string; ordDate: string; baseDate: string; yeokmaeEligible?: boolean },
): Promise<YeokmaeUSRecovery> {
  const rec = await queryLSUSOrderExec(cfg, token, { exchcd: p.exchcd, symbol: p.symbol.toUpperCase(), ordDate: p.ordDate }, { emptyCodes: LS_US_ORDEREXEC_EMPTY_CODES });
  const hold = await getLSUSHoldings(cfg, token, p.baseDate);
  return buildYeokmaeUSRecovery({
    symbol: p.symbol, exchcd: p.exchcd,
    rows: rec.rows, reconClassification: rec.classification, reconOk: rec.queryOk,
    holdings: hold.holdings, holdingsOk: hold.ok,
    ordDate: p.ordDate, rspCd: rec.rspCd, rspMsg: rec.rspMsg, httpStatus: rec.httpStatus ?? null,
    hasEnvelope: rec.hasEnvelope, rawRows: (rec.parsedRows ?? rec.rows).length, parsedRows: rec.parsedRows ?? rec.rows,
    yeokmaeEligible: p.yeokmaeEligible,
  });
}

// ── 복원 근거를 strategyTag=YEOKMAE 원장에 반영 — 재POST/lock 삭제 없음. ──
//   · evidenceOk && filled 이고 원장에 없으면 신규 진입으로 기록(entryAvgPrice=체결가, qty=보유/체결).
//   · 이미 원장에 있으면 실제 보유수량으로 qty 만 동기화(중복가산 금지). broker evidence 우선.
export interface RecoveryApplyResult { applied: 'INSERTED' | 'SYNCED' | 'SKIPPED'; qty: number; reason: string; }
export function applyYeokmaeRecoveryToLedger(
  posStore: YeokmaePositionStore, rec: YeokmaeUSRecovery,
  meta: { entryDate: string; confirmedSignalDate: string | null; matchedSignals: string[] },
): RecoveryApplyResult {
  if (posStore.corrupt) return { applied: 'SKIPPED', qty: 0, reason: '원장 파일 손상 → 반영 안 함(fail-closed)' };
  if (!rec.evidenceOk) return { applied: 'SKIPPED', qty: 0, reason: rec.reason };
  if (!rec.filled || !(rec.ledgerQty > 0)) return { applied: 'SKIPPED', qty: 0, reason: '체결/보유 없음 → 원장 반영 안 함' };
  const existing = posStore.get(rec.symbol);
  if (existing) {
    // 중복가산 금지 — 실제 보유수량으로 동기화만.
    posStore.syncQty(rec.symbol, rec.ledgerQty); posStore.flush();
    return { applied: 'SYNCED', qty: rec.ledgerQty, reason: `기존 원장 qty ${existing.qty}→${rec.ledgerQty}(broker 보유 동기화)` };
  }
  posStore.applyYeokmaeBuyFill({
    symbol: rec.symbol, exchcd: rec.exchcd, entryDate: meta.entryDate,
    fillQty: rec.ledgerQty, fillPrice: rec.entryAvgPrice,
    confirmedSignalDate: meta.confirmedSignalDate, matchedSignals: meta.matchedSignals,
  });
  posStore.flush();
  return { applied: 'INSERTED', qty: rec.ledgerQty, reason: `신규 진입 기록(qty=${rec.ledgerQty} entryAvg=${rec.entryAvgPrice.toFixed(2)} strategyTag=YEOKMAE)` };
}

// ── 지속실행 러너 시작요약(테스트용 순수함수) — 원장 기준 포지션/추가BUY 허용/SELL armed 를 산출. ──
//   additionalBuyAllowed = currentYeokmaePositions < maxPositions (PILOT 1포지션 제한 유지).
//   sellArmed = 보유 포지션 존재(청산 감시 활성). BB SELL 은 별도 저장소라 YEOKMAE 에 미적용(물리 분리).
export interface YeokmaeLivePositionView {
  symbol: string; qty: number; strategyTag: string; entryAvgPrice: number;
  confirmedSignalDate: string | null; matchedSignals: string[];
  stopLossPct: number; takeProfitPct: number; maxHoldDays: number; sellArmed: boolean;
}
export interface UnresolvedYeokmaeHolding { symbol: string; holdingQty: number; reason: string; }
export interface YeokmaeLiveStartup {
  positions: YeokmaeLivePositionView[];
  currentYeokmaePositions: number; maxPositions: number;
  additionalBuyAllowed: boolean; sellArmed: boolean;
  unresolvedYeokmaeHoldings: UnresolvedYeokmaeHolding[];
}
// item4 안전장치: unresolved(YEOKMAE 자격 + 실보유>0 인데 복원 evidence 불완전)가 하나라도 있으면
//   중복매수 위험 → additionalBuyAllowed=false 로 fail-closed. 평단 미확정이라 자동 SELL 은 미활성(원장 미반영).
export function summarizeYeokmaeLive(
  positions: YeokmaePosition[], maxPositions = YEOKMAE_PILOT_MAX_POSITIONS,
  unresolvedYeokmaeHoldings: UnresolvedYeokmaeHolding[] = [],
): YeokmaeLiveStartup {
  const held = positions.filter(p => p.qty > 0);
  const views: YeokmaeLivePositionView[] = held.map(p => ({
    symbol: p.symbol, qty: p.qty, strategyTag: p.strategyTag, entryAvgPrice: p.entryAvgPrice,
    confirmedSignalDate: p.confirmedSignalDate ?? null, matchedSignals: p.matchedSignals ?? [],
    stopLossPct: p.stopLossPct, takeProfitPct: p.takeProfitPct,
    maxHoldDays: DEFAULT_YEOKMAE_EXIT_CONFIG.maxHoldDays,
    sellArmed: p.qty > 0 && p.strategyTag === 'YEOKMAE',
  }));
  const count = held.length;
  const hasUnresolved = unresolvedYeokmaeHoldings.length > 0;
  return {
    positions: views, currentYeokmaePositions: count, maxPositions,
    // 슬롯이 남아도 미해결 YEOKMAE 보유가 있으면 신규 BUY 금지(중복매수 방지).
    additionalBuyAllowed: count < maxPositions && !hasUnresolved,
    sellArmed: views.some(v => v.sellArmed),
    unresolvedYeokmaeHoldings,
  };
}
