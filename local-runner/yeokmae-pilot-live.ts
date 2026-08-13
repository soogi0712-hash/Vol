// 역매공파 소액 PILOT 실거래 실행기 (P0-35P2/P3) — 실행: npm run yeokmae:pilot-live -- KR|US [--dry-run]
//   ⚠️ 이 명령에서만 PILOT 실주문 가능(다른 명령은 주문 없음). --dry-run 은 실계정 게이트 전부 조회하되 POST 0(=preflight).
//   기존 안전 BUY executor(executeBuyOrder/executeKRBuyOrder) 재사용 → reconciliation/pending/cash-only/idempotency/fresh orderable
//   전부 경유 후에만 POST. 최종 = LS_LIVE_TRADING ∧ YEOKMAE_LIVE_TRADING ∧ YEOKMAE_PILOT_LIVE ∧ PILOT게이트 ∧ YEOKMAE포지션 0개.
//   YEOKMAE_STRATEGY_VALIDATED/SEMANTICS_VERIFIED 는 false 유지(별도 승인 경로). 하나라도 불명확이면 fail-closed(POST 0).
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { loadConfig, getTokenCached } from './ls-client';
import { makeScrubber } from './mask';
import { executeBuyOrder, type TraderDeps } from './trader';
import { executeKRBuyOrder, type KRTraderDeps } from './kr-trader';
import {
  getLSUSDeposit, usCashOnlyUsdCap, placeLSUSBuyOrder, queryLSUSOrderExec, cancelLSUSOrder,
  placeLSKRBuyOrder, queryLSKROrderExecUnified, cancelLSKRBuyOrder, getLSKRBalance, LS_US_ORDEREXEC_EMPTY_CODES,
  buildKRBuyInBlock, resolveKRMbrNo,
} from '../src/lib/ls-api';
import {
  runYeokmaePilotBuy, formatYeokmaeExitPolicy, DEFAULT_YEOKMAE_EXIT_CONFIG,
  YEOKMAE_STRATEGY_VALIDATED, YEOKMAE_SEMANTICS_VERIFIED,
} from '../src/lib/yeokmae';
import { pilotPreflight, logPilotPreflight } from './yeokmae-pilot-core';

async function main() {
  loadEnvLocal();
  const log = createLogger('yeokmae-pilot-live');
  const args = process.argv.slice(2);
  const market = (args.find(a => !a.startsWith('--')) || '').toUpperCase();
  const dryRun = args.includes('--dry-run');
  if (market !== 'KR' && market !== 'US') { log.error('사용법: npm run yeokmae:pilot-live -- KR | US [--dry-run]'); process.exit(1); return; }

  const env = {
    liveTrading: process.env.LS_LIVE_TRADING === 'true',
    yeokmaeLive: process.env.YEOKMAE_LIVE_TRADING === 'true',
    pilotLive: process.env.YEOKMAE_PILOT_LIVE === 'true',
    legacyBbBlocked: process.env.LEGACY_BB_LIVE_ENABLED !== 'true',
    budgetUSD: Number(process.env.LS_US_PER_TRADE_BUDGET_USD || 60) || 60,
  };
  log.info(`===== [YEOKMAE-PILOT-LIVE] market=${market}${dryRun ? ' (--dry-run: POST 0)' : ''} =====`);
  log.info(`[YEOKMAE-SAFETY] LS_LIVE_TRADING=${env.liveTrading} YEOKMAE_LIVE_TRADING=${env.yeokmaeLive} YEOKMAE_PILOT_LIVE=${env.pilotLive} · YEOKMAE_STRATEGY_VALIDATED=${YEOKMAE_STRATEGY_VALIDATED} YEOKMAE_SEMANTICS_VERIFIED=${YEOKMAE_SEMANTICS_VERIFIED} · PILOT=사용자승인 소액시험(검증완료 아님)`);
  log.info(formatYeokmaeExitPolicy(DEFAULT_YEOKMAE_EXIT_CONFIG));

  let cfg; try { cfg = loadConfig(); } catch (e) { log.error(`[YEOKMAE-PILOT-ORDER] FAIL_CLOSED(config: ${String(e)}) → 주문 없음.`); process.exit(2); return; }
  const scrub = makeScrubber([cfg.appKey, cfg.appSecret]);
  let token: string;
  try { token = await getTokenCached(cfg); } catch (e) { log.error(`[YEOKMAE-PILOT-ORDER] FAIL_CLOSED(token: ${scrub(String(e))}) → 주문 없음.`); process.exit(2); return; }

  // 실계정 게이트 전부 조회(POST 없음)
  const pf = await pilotPreflight(cfg, token, market as 'KR' | 'US', env, scrub);
  logPilotPreflight((m) => log.info(m), pf);
  if (!pf.ok) { process.exit(2); return; }

  // P0-35P8: MbrNo 라우팅을 공용 resolver 로 통일(ls-kr-scan/ls-trade 와 동일). env 미설정=NXT(문서 예제값).
  const mbr = resolveKRMbrNo(process.env.LS_KR_MBR_NO);
  const krMbrNo = mbr.value;
  // P0-35P7/P8: 전송 전 CSPAT00601 request InBlock + MbrNo 라우팅 진단(주문 0). dry-run 에서도 출력.
  if (market === 'KR' && pf.candidate) {
    const ib = buildKRBuyInBlock({ shcode: pf.candidate.symbol, qty: pf.qty, price: pf.price, mbrNo: krMbrNo }).CSPAT00601InBlock1 as any;
    log.info(`[KR-MBR-ROUTING-DIAG] envValue=${mbr.envValue === null ? '(미설정)' : `'${mbr.envValue}'`} resolvedValue='${mbr.value}' source=${mbr.source} IsuNo=${ib.IsuNo} market=${pf.candidate.exchange}`);
    log.info(`[KR-PILOT-ORDER-REQ] IsuNo=${ib.IsuNo} OrdQty=${ib.OrdQty} OrdPrc=${ib.OrdPrc} BnsTpCode=${ib.BnsTpCode}(매수) OrdprcPtnCode=${ib.OrdprcPtnCode}(지정가) MgntrnCode=${ib.MgntrnCode}(현금) LoanDt='${ib.LoanDt}' OrdCndiTpCode=${ib.OrdCndiTpCode} MbrNo=${ib.MbrNo}`);
    log.info(`  ℹ️ MbrNo=NXT 는 넥스트레이드 ATS 라우팅(repo 내 유일 확정근거=공식 reqExample). 정규거래소(KRX) 값은 repo 에 공식 catalog 없음 → 추측 금지. LS 공식 문서 확인 후 LS_KR_MBR_NO 로 지정(빈 문자열도 명시 가능).`);
  }

  if (dryRun) { log.info(`[YEOKMAE-PILOT-STATUS] --dry-run → BUY POST=0 (게이트만 조회). realOrderEnabled=${pf.realOrderEnabled}`); return; }

  // executor 연결 — realOrderEnabled=true 일 때만 POST(runYeokmaePilotBuy 가 강제).
  const orders = pf.orders!; const posStore = pf.posStore; const candidate = pf.candidate!;
  const buyDeps = market === 'US' ? (() => {
    const traderDeps: TraderDeps = {
      place: (pp) => placeLSUSBuyOrder(cfg, token, pp),
      query: (pp) => queryLSUSOrderExec(cfg, token, pp, { emptyCodes: LS_US_ORDEREXEC_EMPTY_CODES }),
      cancel: (pp) => cancelLSUSOrder(cfg, token, pp),
      cashOrderable: async () => { const d = await getLSUSDeposit(cfg, token); return { ok: d.ok, cash: usCashOnlyUsdCap(d, {}) }; },
      now: () => Date.now(), log: (m) => log.info(m),
    };
    return {
      executeBuy: async (o: any) => { const out = await executeBuyOrder(traderDeps, { orders, exchcd: o.exchcd, symbol: o.symbol, candleDatetime: o.candleDatetime, qty: o.qty, price: o.price, etDate: o.etDate, dailyMaxBuys: 1 }); return { status: out.status, ordNo: out.ordNo, filledQty: out.status === 'placed-filled' ? o.qty : 0, fillPrice: o.price }; },
      recordPosition: (o: any) => { posStore.applyYeokmaeBuyFill(o); posStore.flush(); },
      log: (m: string) => log.info(m),
    };
  })() : (() => {
    const krDeps: KRTraderDeps = {
      place: (pp) => placeLSKRBuyOrder(cfg, token, pp),
      queryExec: (pp) => queryLSKROrderExecUnified(cfg, token, pp),   // P0-35P6: preflight 와 동일 strict classifier
      cancel: (pp) => cancelLSKRBuyOrder(cfg, token, pp),
      cashOrderable: async () => { try { const b = await getLSKRBalance(cfg, token); return { ok: true, cash: b.orderableCash }; } catch { return { ok: false, cash: 0 }; } },
      now: () => Date.now(), log: (m) => log.info(m),
    };
    return {
      executeBuy: async (o: any) => { const out = await executeKRBuyOrder(krDeps, { orders, shcode: o.symbol, candleDatetime: o.candleDatetime, qty: o.qty, price: o.price, krDate: o.etDate, mbrNo: krMbrNo, dailyMaxBuys: 1 }); return { status: out.status, ordNo: out.ordNo, filledQty: out.execQty, fillPrice: o.price }; },
      recordPosition: (o: any) => { posStore.applyYeokmaeBuyFill(o); posStore.flush(); },
      log: (m: string) => log.info(m),
    };
  })();

  const result = await runYeokmaePilotBuy(buyDeps, { realOrderEnabled: pf.realOrderEnabled, candidate, exchcd: pf.exchcd, qty: pf.qty, price: pf.price, candleDatetime: candidate.confirmedDate, etDate: pf.etDate });
  log.info(`[YEOKMAE-PILOT-STATUS] posted=${result.posted} ordNo=${result.ordNo ?? '-'} reason=${result.reason} — ${result.posted ? '체결 시 strategyTag=YEOKMAE 저장 + P0-34 SELL 정책 활성' : '실주문 없음'}`);
  if (result.posted) log.info(`[YEOKMAE-PILOT-SELL-ARMED] symbol=${candidate.symbol} STOP_LOSS=-${DEFAULT_YEOKMAE_EXIT_CONFIG.stopLossPct}% TAKE_PROFIT=+${DEFAULT_YEOKMAE_EXIT_CONFIG.takeProfitPct}% MAX_HOLD_DAYS=${DEFAULT_YEOKMAE_EXIT_CONFIG.maxHoldDays} · BB SELL 미적용(strategyTag=YEOKMAE 전용).`);
}
main();
