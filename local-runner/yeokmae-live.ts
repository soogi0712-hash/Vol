// 역매공파 지속실행 러너 (P0-35US6/US10) — 실행: npm run yeokmae:live -- US [--once] [--dry-run]
//   오늘 미국장 동안 계속: ① broker 실보유 복원(원장 우선순위: broker evidence) → ② 시작요약 →
//   ③ quote 갱신 → ④ P0-34 자동 SELL(위험청산) → ⑤ 신규 confirmed 신호(PILOT 1포지션 제한: 보유 중 신규 BUY 0).
//   BUY POST 는 여기서 하지 않는다(pilot-live 담당). SELL 실 POST 는 LS_LIVE_TRADING ∧ YEOKMAE_SELL_LIVE ∧ !dryRun ∧
//   전 안전게이트 통과 시에만. --dry-run 은 실가격으로 HOLD/SELL 판정+게이트까지만(POST 0). candle/order lock 삭제 금지.
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached, resolveUSQuote } from './ls-client';
import { makeScrubber } from './mask';
import { loadUSSymbols } from './universe';
import { OrderStore } from './order-store';
import { YeokmaePositionStore } from './yeokmae-position-store';
import { YEOKMAE_DAILY_ROOT } from './yeokmae-daily-cache';
import { marketDate } from './yeokmae-pilot-core';
import { recoverYeokmaeUSFromBroker, applyYeokmaeRecoveryToLedger, summarizeYeokmaeLive, planUSHoldingRecovery } from './yeokmae-recover';
import { runYeokmaeSell, type YeokmaeSellIO } from './yeokmae-sell';
import { executeSellOrder } from './us-seller';
import { getLSUSHoldings, getLSUSPrice, usEtSession, placeLSUSSellOrder, queryLSUSOrderExec, LS_US_ORDEREXEC_EMPTY_CODES } from '../src/lib/ls-api';
import {
  evaluateYeokmaeExit, updateHighestPrice, formatYeokmaeExitPolicy, DEFAULT_YEOKMAE_EXIT_CONFIG,
  YEOKMAE_PILOT_MAX_POSITIONS, YEOKMAE_STRATEGY_VALIDATED, YEOKMAE_SEMANTICS_VERIFIED,
} from '../src/lib/yeokmae';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SIGNAL_KEYS = ['112_ORIGINAL', '224_ORIGINAL', '112_UPGRADE', '224_UPGRADE', 'LONG_TERM'];

// real-signals.json → symbol별 진입근거(confirmedDate/matchedSignals/exchange/exchcd) 매핑(있으면).
interface SignalMeta { confirmedDate: string | null; matchedSignals: string[]; exchange: string; exchcd: string | null; }
function loadSignalMeta(market: 'US'): Map<string, SignalMeta> {
  const m = new Map<string, SignalMeta>();
  const file = join(YEOKMAE_DAILY_ROOT, `${market}.real-signals.json`);
  if (!existsSync(file)) return m;
  try {
    const signals: any[] = JSON.parse(readFileSync(file, 'utf8')).signals ?? [];
    for (const s of signals) {
      const matched = SIGNAL_KEYS.filter(k => s[k] === true);
      if (matched.length === 0) continue;   // 5신호 ON 인 confirmed 후보만(BUY 근거) — item2·3
      m.set(String(s.symbol).toUpperCase(), { confirmedDate: s.confirmedDate ?? null, matchedSignals: matched, exchange: String(s.exchange ?? ''), exchcd: s.exchcd != null ? String(s.exchcd) : null });
    }
  } catch { /* 무시 — 메타 없어도 원장 기존 포지션은 broker evidence 로 동기화 */ }
  return m;
}

// 실행용 SELL IO 배선 — us-seller 안전경로에 LS 함수 연결(place=매도 OrdPtnCode=01, 대사/신선매도가능).
function buildSellIO(cfg: any, token: string, etDate: string, log: (m: string) => void): YeokmaeSellIO {
  const freshSellable = async (p: { exchcd: string; symbol: string }) => {
    const h = await getLSUSHoldings(cfg, token, etDate);
    const hh = h.holdings.find(x => x.symbol.toUpperCase() === p.symbol.toUpperCase());
    return { ok: h.ok, qty: hh?.sellableQty ?? 0 };
  };
  return {
    freshSellable,
    reconcile: async (p) => { const q = await queryLSUSOrderExec(cfg, token, p, { emptyCodes: LS_US_ORDEREXEC_EMPTY_CODES }); return { ok: q.queryOk, classification: q.classification }; },
    executeSell: executeSellOrder,
    sellDeps: {
      place: (pp) => placeLSUSSellOrder(cfg, token, pp),
      query: (pp) => queryLSUSOrderExec(cfg, token, pp, { emptyCodes: LS_US_ORDEREXEC_EMPTY_CODES }),
      sellableQty: freshSellable,
      now: () => Date.now(), log,
    },
  };
}

async function watchCycle(ctx: { cfg: any; token: string; posStore: YeokmaePositionStore; etDate: string; sellLive: boolean; dryRun: boolean; sellIO: YeokmaeSellIO; log: (m: string) => void }): Promise<{ fullExits: number }> {
  const { cfg, token, posStore, log } = ctx;
  const held = posStore.all().filter(p => p.qty > 0);
  const delaygb = resolveUSQuote().delaygb ?? 'R';
  let fullExits = 0;
  for (const pos of held) {
    let price = 0; let quoteOk = false;
    try { const q = await getLSUSPrice(cfg, token, pos.symbol, pos.exchcd, delaygb); price = q.price; quoteOk = price > 0; }
    catch (e) { log(`[YEOKMAE-LIVE-WATCH] ${pos.symbol} quote 조회실패 → SELL 판정 보류(관찰). ${e instanceof Error ? e.message : String(e)}`); continue; }
    if (quoteOk) { posStore.updateHighest(pos.symbol, price); posStore.flush(); }
    const decision = evaluateYeokmaeExit({
      state: { entryAvgPrice: pos.entryAvgPrice, qty: pos.qty, highestPrice: updateHighestPrice(pos.highestPrice, price), holdDays: pos.holdDays },
      config: { ...DEFAULT_YEOKMAE_EXIT_CONFIG, stopLossPct: pos.stopLossPct, takeProfitPct: pos.takeProfitPct, profitMode: pos.profitMode, trailingActivatePct: pos.trailingActivatePct, trailingDrawdownPct: pos.trailingDrawdownPct },
      quote: { reliableRealtime: quoteOk, price },
    });
    log(`[YEOKMAE-LIVE-WATCH] ${pos.symbol} qty=${pos.qty} entryAvg=${pos.entryAvgPrice.toFixed(2)} price=${quoteOk ? price.toFixed(2) : 'n/a'} pnl=${decision.pnlPct == null ? 'n/a' : decision.pnlPct.toFixed(2) + '%'} action=${decision.action}${decision.reason ? ` reason=${decision.reason}` : ''} holdDays=${pos.holdDays}/${DEFAULT_YEOKMAE_EXIT_CONFIG.maxHoldDays}`);
    if (decision.action !== 'SELL') continue;
    // 위험청산 신호 → P0-34 SELL 게이트 + us-seller 실행(POST 는 sellLive ∧ !dryRun 시에만). strategyTag=YEOKMAE 만.
    const orders = new OrderStore(`YEOKMAE_US_${pos.symbol}`); orders.load();
    const res = await runYeokmaeSell(ctx.sellIO, {
      posStore, orders, position: pos, exchcd: pos.exchcd,
      exitAction: decision.action, exitReason: decision.reason, pnlPct: decision.pnlPct,
      currentPrice: price, etDate: ctx.etDate, sellLive: ctx.sellLive, dryRun: ctx.dryRun, log,
    });
    if (res.status === 'placed-filled' && res.remainingQty <= 0) fullExits++;
  }
  return { fullExits };
}

async function main() {
  loadEnvLocal();
  const log = createLogger('yeokmae-live');
  const args = process.argv.slice(2);
  const market = (args.find(a => !a.startsWith('--')) || '').toUpperCase();
  const once = args.includes('--once');
  const dryRun = args.includes('--dry-run');
  if (market !== 'US') { log.error('사용법: npm run yeokmae:live -- US [--once] [--dry-run] (현재 US 전용)'); process.exit(1); return; }
  const intervalSec = Math.max(10, Number(process.env.YEOKMAE_LIVE_INTERVAL_SEC || 30) || 30);
  // SELL 실 POST kill-switch — 보유 위험청산은 BUY validation 과 분리(YEOKMAE_STRATEGY_VALIDATED 무관).
  const liveTrading = process.env.LS_LIVE_TRADING === 'true';
  const yeokmaeSellLive = process.env.YEOKMAE_SELL_LIVE === 'true';
  const sellLive = liveTrading && yeokmaeSellLive && !dryRun;

  log.info(`===== [YEOKMAE-LIVE] market=US 지속실행(복원→감시→P0-34 SELL)${dryRun ? ' [--dry-run: POST 0]' : ''} =====`);
  log.info(`[YEOKMAE-SAFETY] YEOKMAE_STRATEGY_VALIDATED=${YEOKMAE_STRATEGY_VALIDATED} YEOKMAE_SEMANTICS_VERIFIED=${YEOKMAE_SEMANTICS_VERIFIED} · PILOT 1포지션 제한 유지 · BUY POST=0(pilot-live 담당)`);
  log.info(`[YEOKMAE-SELL-LIVE] LS_LIVE_TRADING=${liveTrading} YEOKMAE_SELL_LIVE=${yeokmaeSellLive} dryRun=${dryRun} → SELL_REAL_POST=${sellLive} (보유 위험청산은 STRATEGY_VALIDATED 무관)`);
  log.info(formatYeokmaeExitPolicy(DEFAULT_YEOKMAE_EXIT_CONFIG));

  let cfg; try { cfg = loadConfig(); } catch (e) { log.error(`[YEOKMAE-LIVE] FAIL_CLOSED(config: ${String(e)})`); process.exit(2); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); } catch (e) { log.error(`[YEOKMAE-LIVE] FAIL_CLOSED(token: ${scrub(String(e))})`); process.exit(2); return; }

  const posStore = new YeokmaePositionStore(); posStore.load();
  if (posStore.corrupt) { log.error('[YEOKMAE-LIVE] 원장 파일 손상 → 복원/감시 중단(fail-closed).'); process.exit(2); return; }

  const etDate = marketDate(-5);
  const et = usEtSession(new Date());
  log.info(`[YEOKMAE-LIVE-SESSION] session=${et.session} etTime=${et.etTime} etDate=${etDate}`);

  // ── ① broker 실보유 복원 (broker evidence 우선, 재POST/lock 삭제 없음) ──
  const meta = loadSignalMeta('US');
  const uni = loadUSSymbols();
  let holdingsOk = false; let heldSymbols: string[] = [];
  const holdingQtyMap = new Map<string, number>();
  try {
    const hold = await getLSUSHoldings(cfg, token, etDate);
    holdingsOk = hold.ok; heldSymbols = hold.holdings.map(h => h.symbol.toUpperCase());
    for (const h of hold.holdings) holdingQtyMap.set(h.symbol.toUpperCase(), h.balQty);
    log.info(`[YEOKMAE-LIVE-HOLDINGS] ok=${hold.ok} rsp_cd=${hold.rspCd} 보유종목=[${heldSymbols.join(',') || '없음'}] rawRows=${hold.rawRows}`);
  } catch (e) { log.warn(`[YEOKMAE-LIVE-HOLDINGS] 조회 실패 → 원장 기존값 유지(감시만). ${scrub(String(e))}`); }

  const entryDateISO = `${etDate.slice(0, 4)}-${etDate.slice(4, 6)}-${etDate.slice(6, 8)}`;
  const unresolved: { symbol: string; holdingQty: number; reason: string }[] = [];
  if (holdingsOk) {
    for (const sym of heldSymbols) {
      const md = meta.get(sym);                          // signal metadata(real-signals.json, 5신호 ON)
      const u = uni.ok.find(s => s.symbol === sym);       // static universe(교차검증)
      const ledger = posStore.get(sym);                   // 기존 YEOKMAE 원장(재기동 복원 증거)
      const plan = planUSHoldingRecovery({
        symbol: sym, hasSignal: !!md, signalExchcd: md?.exchcd ?? null, signalExchange: md?.exchange ?? null,
        ledgerExists: !!ledger, ledgerExchcd: ledger?.exchcd ?? null, universeExchcd: u?.exchcd ?? null,
      });
      if (plan.action !== 'RECOVER') {
        log.info(`[YEOKMAE-LIVE-RECOVER] ${sym} strategyTag=${plan.strategyTag} action=${plan.action} → ${plan.reason} (건드리지 않음)`);
        continue;
      }
      try {
        const rec = await recoverYeokmaeUSFromBroker(cfg, token, { symbol: sym, exchcd: plan.exchcd, ordDate: etDate, baseDate: etDate, yeokmaeEligible: true });
        // item1: COSAQ00102 원문 진단 — BUSINESS_ERROR 원인(실 rsp_cd/rows) 노출.
        const d = rec.reconDiag;
        log.info(`[YEOKMAE-RECOVER-RECON-DIAG] ${sym} ordDate=${d.ordDate} exchcd=${d.exchcd} rsp_cd=${d.rspCd} rsp_msg=${d.rspMsg} httpStatus=${d.httpStatus ?? '-'} envelope=${d.hasEnvelope} rawRows=${d.rawRows} symbolRows=${d.symbolRows} OrdNo=${d.ordNo} OrdQty=${d.ordQty} ExecQty=${d.execQty} UnfilledQty=${d.unfilledQty} AvgExecPrc=${d.avgExecPrc} classification=${d.classification} failureReason=${d.failureReason}`);
        log.info(`[YEOKMAE-LIVE-RECOVER] ${sym} exchcd=${plan.exchcd}(src=${plan.source}) ordNo=${rec.ordNo ?? '-'} ordQty=${rec.ordQty} execQty=${rec.execQty} unfilled=${rec.unfilledQty} entryAvg=${rec.entryAvgPrice.toFixed(2)} 보유수량=${rec.holdingBalQty} sellable=${rec.holdingSellableQty} evidenceOk=${rec.evidenceOk} ${rec.reason}`);
        const applied = applyYeokmaeRecoveryToLedger(posStore, rec, { entryDate: entryDateISO, confirmedSignalDate: md?.confirmedDate ?? ledger?.confirmedSignalDate ?? null, matchedSignals: md?.matchedSignals ?? ledger?.matchedSignals ?? [] });
        log.info(`[YEOKMAE-LIVE-LEDGER] ${sym} applied=${applied.applied} qty=${applied.qty} strategyTag=YEOKMAE ${applied.reason}`);
        // item4: 실보유>0 인데 원장 미반영(evidence 불완전) → 미해결 YEOKMAE 보유로 등록(신규 BUY fail-closed).
        if (rec.unresolvedYeokmaeHolding || (rec.holdingBalQty > 0 && applied.applied === 'SKIPPED')) {
          unresolved.push({ symbol: sym, holdingQty: rec.holdingBalQty, reason: rec.unresolvedYeokmaeHolding ? `UNRESOLVED_YEOKMAE_HOLDING(recon=${rec.reconClassification})` : `APPLY_SKIPPED(${applied.reason})` });
          log.warn(`[YEOKMAE-LIVE-UNRESOLVED] ${sym} 실보유 ${rec.holdingBalQty}주 · recon=${rec.reconClassification} → 평단 미확정. 신규 BUY 차단(fail-closed), 자동 SELL 미활성(평단 확보 전).`);
        }
      } catch (e) {
        log.warn(`[YEOKMAE-LIVE-RECOVER] ${sym} 복원 조회 실패 → 보류. ${scrub(String(e))}`);
        // 조회 실패이지만 broker holdings 에는 있는 YEOKMAE 자격 종목 → 미해결로 간주(보수적 BUY 차단).
        const bal = holdingQtyMap.get(sym) ?? 0;
        if (bal > 0) unresolved.push({ symbol: sym, holdingQty: bal, reason: 'RECOVER_QUERY_FAILED' });
      }
    }
  }

  // ── ② 시작요약(item 3·4 필수 확인값) ──
  const startup = summarizeYeokmaeLive(posStore.all(), YEOKMAE_PILOT_MAX_POSITIONS, unresolved);
  for (const p of startup.positions) {
    log.info(`[YEOKMAE-LIVE-POSITION] symbol=${p.symbol} qty=${p.qty} strategyTag=${p.strategyTag} entryAvgPrice=${p.entryAvgPrice.toFixed(2)} confirmedSignalDate=${p.confirmedSignalDate ?? '-'} matchedSignals=[${p.matchedSignals.join(',')}] SELL_ARMED=${p.sellArmed} (STOP_LOSS=-${p.stopLossPct}% TAKE_PROFIT=+${p.takeProfitPct}% MAX_HOLD_DAYS=${p.maxHoldDays})`);
  }
  for (const u of startup.unresolvedYeokmaeHoldings) {
    log.warn(`[YEOKMAE-LIVE-UNRESOLVED-HOLDING] symbol=${u.symbol} holdingQty=${u.holdingQty} reason=${u.reason} → additionalBuyAllowed=false(중복매수 차단). 평단 미확정 → 자동 SELL 미활성. COSAQ00102 실체결 확보 후 복원.`);
  }
  log.info(`[YEOKMAE-LIVE-STARTUP] currentYeokmaePositions=${startup.currentYeokmaePositions}/${startup.maxPositions} additionalBuyAllowed=${startup.additionalBuyAllowed} SELL_ARMED=${startup.sellArmed} unresolvedYeokmaeHoldings=${startup.unresolvedYeokmaeHoldings.length}[${startup.unresolvedYeokmaeHoldings.map(u => u.symbol).join(',')}] · BB SELL 미적용(별도 저장소 물리분리)`);
  if (!startup.additionalBuyAllowed) log.info(`[YEOKMAE-LIVE-BUY-GATE] additionalBuyAllowed=false → 신규 BUY 차단(보유 ${startup.currentYeokmaePositions}/${startup.maxPositions}${startup.unresolvedYeokmaeHoldings.length ? ` + 미해결 YEOKMAE 보유 ${startup.unresolvedYeokmaeHoldings.length}` : ''}). 청산/복원 후에만 신규 진입.`);

  // ── ③~⑤ 지속 감시 루프 — quote 갱신 → P0-34 SELL 게이트/실행(sellLive ∧ !dryRun 시에만 POST). ──
  const sellIO = buildSellIO(cfg, token, etDate, (m) => log.info(m));
  const wctx = { cfg, token, posStore, etDate, sellLive, dryRun, sellIO, log: (m: string) => log.info(m) };
  const summarizeAfter = (r: { fullExits: number }) => {
    if (r.fullExits > 0) {
      const s2 = summarizeYeokmaeLive(posStore.all(), YEOKMAE_PILOT_MAX_POSITIONS, unresolved);
      // 전량 SELL 후에만 슬롯 개방. 단, 동일 tick 신규 BUY 금지(이 러너는 BUY 안 함) — 다음 scan/tick(pilot-live)부터 허용.
      log.info(`[YEOKMAE-LIVE-STARTUP] (post-SELL) currentYeokmaePositions=${s2.currentYeokmaePositions}/${s2.maxPositions} additionalBuyAllowed=${s2.additionalBuyAllowed} SELL_ARMED=${s2.sellArmed} — 신규 BUY 는 다음 tick 부터(동일 tick 금지).`);
    }
  };
  summarizeAfter(await watchCycle(wctx));
  if (once) { log.info(`[YEOKMAE-LIVE] --once → 1회 감시 후 종료. SELL_REAL_POST=${sellLive}${dryRun ? '(dry-run)' : ''}.`); return; }

  log.info(`[YEOKMAE-LIVE] ${intervalSec}s 간격 지속 감시 시작(Ctrl+C 종료). 신규 BUY 는 pilot-live 로 별도 진행(보유 중 차단).`);
  const tick = async () => {
    try { summarizeAfter(await watchCycle(wctx)); }
    catch (e) { log.warn(`[YEOKMAE-LIVE] 감시 tick 오류(계속). ${scrub(String(e))}`); }
    setTimeout(tick, intervalSec * 1000);
  };
  setTimeout(tick, intervalSec * 1000);
}
main();
