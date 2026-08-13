// 역매공파 US 실보유 복원 (P0-35US6) — broker evidence(COSAQ00102 + COSOQ00201 보유)로 원장을 복원한다.
//   ⚠️ 절대 재주문/재POST 금지, candle/order lock 삭제 금지. broker evidence 가 local state 보다 우선.
//   이미 접수된 PRGO 주문(00040 성공)을 재조회로만 확인해 strategyTag=YEOKMAE 원장에 반영한다.
import type { LocalLSConfig } from './ls-client';
import {
  queryLSUSOrderExec, getLSUSHoldings, LS_US_ORDEREXEC_EMPTY_CODES,
  type LSOrderExec, type LSUSHolding, type OrderExecClassification,
} from '../src/lib/ls-api';
import type { YeokmaePositionStore, YeokmaePosition } from './yeokmae-position-store';
import { DEFAULT_YEOKMAE_EXIT_CONFIG, YEOKMAE_PILOT_MAX_POSITIONS } from '../src/lib/yeokmae';

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
  reason: string;
}

// ── 순수 복원 코어(테스트용) — 조회결과(rows/holdings)만으로 복원 근거를 계산. 네트워크/부수효과 없음. ──
export function buildYeokmaeUSRecovery(p: {
  symbol: string; exchcd: string;
  rows: LSOrderExec[]; reconClassification: OrderExecClassification; reconOk: boolean;
  holdings: LSUSHolding[]; holdingsOk: boolean;
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
  const reason = !evidenceOk
    ? `EVIDENCE_UNTRUSTED(recon=${p.reconClassification}/${p.reconOk} holdingsOk=${p.holdingsOk}) → 원장 미반영(fail-closed)`
    : filled
      ? `FILLED(execQty=${execQty} holdingBalQty=${holdingBalQty} ledgerQty=${ledgerQty} entryAvg=${entryAvgPrice.toFixed(2)})`
      : `NO_FILL(execQty=0 holdingBalQty=0 — 접수만/미체결 또는 보유 없음)`;
  return {
    symbol: sym, exchcd: p.exchcd, ordNo, ordQty, execQty, unfilledQty, entryAvgPrice,
    holdingBalQty, holdingSellableQty, ledgerQty, filled,
    reconClassification: p.reconClassification, reconOk: p.reconOk, holdingsOk: p.holdingsOk, evidenceOk, reason,
  };
}

// ── broker 재조회 → 복원 근거 산출(POST 없음: 읽기전용 COSAQ00102 + COSOQ00201). ──
export async function recoverYeokmaeUSFromBroker(
  cfg: LocalLSConfig, token: string,
  p: { symbol: string; exchcd: string; ordDate: string; baseDate: string },
): Promise<YeokmaeUSRecovery> {
  const rec = await queryLSUSOrderExec(cfg, token, { exchcd: p.exchcd, symbol: p.symbol.toUpperCase(), ordDate: p.ordDate }, { emptyCodes: LS_US_ORDEREXEC_EMPTY_CODES });
  const hold = await getLSUSHoldings(cfg, token, p.baseDate);
  return buildYeokmaeUSRecovery({
    symbol: p.symbol, exchcd: p.exchcd,
    rows: rec.rows, reconClassification: rec.classification, reconOk: rec.queryOk,
    holdings: hold.holdings, holdingsOk: hold.ok,
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
export interface YeokmaeLiveStartup {
  positions: YeokmaeLivePositionView[];
  currentYeokmaePositions: number; maxPositions: number;
  additionalBuyAllowed: boolean; sellArmed: boolean;
}
export function summarizeYeokmaeLive(positions: YeokmaePosition[], maxPositions = YEOKMAE_PILOT_MAX_POSITIONS): YeokmaeLiveStartup {
  const held = positions.filter(p => p.qty > 0);
  const views: YeokmaeLivePositionView[] = held.map(p => ({
    symbol: p.symbol, qty: p.qty, strategyTag: p.strategyTag, entryAvgPrice: p.entryAvgPrice,
    confirmedSignalDate: p.confirmedSignalDate ?? null, matchedSignals: p.matchedSignals ?? [],
    stopLossPct: p.stopLossPct, takeProfitPct: p.takeProfitPct,
    maxHoldDays: DEFAULT_YEOKMAE_EXIT_CONFIG.maxHoldDays,
    sellArmed: p.qty > 0 && p.strategyTag === 'YEOKMAE',
  }));
  const count = held.length;
  return {
    positions: views, currentYeokmaePositions: count, maxPositions,
    additionalBuyAllowed: count < maxPositions,
    sellArmed: views.some(v => v.sellArmed),
  };
}
