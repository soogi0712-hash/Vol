// 역매공파 청산 진단 (P0-34) — 실행: npm run yeokmae:exit-diag -- SYMBOL [PRICE] [ENTRY] [HOLDDAYS] [HIGHEST]
//   포지션(us-yeokmae-positions.json)의 청산정책 판정을 계산해 출력. ⚠️ 주문 없음. YEOKMAE_SELL_LIVE=false.
//   PRICE 미지정 → 실시간가 없음(NO_QUOTE, stale close 로 손절/익절 금지). ENTRY 지정 시 합성 진단(포지션 없어도 정책 확인).
import {
  evaluateYeokmaeExit, DEFAULT_YEOKMAE_EXIT_CONFIG, computeYeokmaeSellQty,
  YEOKMAE_SOURCE_BASED_SELL, YEOKMAE_AUTOMATION_RISK_POLICY, YEOKMAE_STRATEGY_VALIDATED,
  type YeokmaeExitState, type YeokmaeExitConfig,
} from '../src/lib/yeokmae';
import { YeokmaePositionStore } from './yeokmae-position-store';

function main() {
  const [symbol, priceArg, entryArg, holdArg, highArg] = process.argv.slice(2);
  if (!symbol) { console.error('사용법: npm run yeokmae:exit-diag -- SYMBOL [PRICE] [ENTRY] [HOLDDAYS] [HIGHEST]'); process.exit(1); }
  const sellLive = process.env.YEOKMAE_SELL_LIVE === 'true';
  console.log(`===== [YEOKMAE-EXIT-DIAG] ${symbol} — 청산정책 판정 (주문 0) =====`);
  console.log(`[YEOKMAE-SAFETY] SOURCE_BASED_SELL=${YEOKMAE_SOURCE_BASED_SELL} AUTOMATION_RISK_POLICY=${YEOKMAE_AUTOMATION_RISK_POLICY} · YEOKMAE_SELL_LIVE=${sellLive} · YEOKMAE_STRATEGY_VALIDATED=${YEOKMAE_STRATEGY_VALIDATED} · REAL_ORDER_FROM_YEOKMAE=false`);

  const store = new YeokmaePositionStore(); store.load();
  const pos = store.get(symbol);
  let state: YeokmaeExitState; let config: YeokmaeExitConfig; let strategyTag = 'YEOKMAE'; let entryDate = '-'; let qty = 0; let synthetic = false;

  if (entryArg !== undefined) {
    // 합성 진단(포지션 없어도 정책 확인용) — 명확히 라벨.
    synthetic = true;
    const entry = Number(entryArg);
    config = { ...DEFAULT_YEOKMAE_EXIT_CONFIG };
    state = { entryAvgPrice: entry, qty: 1, highestPrice: highArg !== undefined ? Number(highArg) : entry, holdDays: holdArg !== undefined ? Number(holdArg) : 0 };
    qty = 1;
  } else if (pos) {
    config = { stopLossPct: pos.stopLossPct, profitMode: pos.profitMode, takeProfitPct: pos.takeProfitPct, trailingActivatePct: pos.trailingActivatePct, trailingDrawdownPct: pos.trailingDrawdownPct, maxHoldDays: DEFAULT_YEOKMAE_EXIT_CONFIG.maxHoldDays };
    state = { entryAvgPrice: pos.entryAvgPrice, qty: pos.qty, highestPrice: pos.highestPrice, holdDays: pos.holdDays };
    entryDate = pos.entryDate; qty = pos.qty;
  } else {
    console.log(`[YEOKMAE-EXIT-DIAG] ${symbol} — YEOKMAE 포지션 없음(us-yeokmae-positions.json). ENTRY 인자로 합성 진단 가능.`);
    console.log(`  (역매공파 BUY 는 YEOKMAE_STRATEGY_VALIDATED=false 로 미체결 → 실제 포지션 0 이 정상.)`);
    return;
  }

  const price = priceArg !== undefined ? Number(priceArg) : 0;
  const reliableRealtime = priceArg !== undefined && price > 0;   // PRICE 인자를 실시간 신뢰가로 취급(진단). 미지정=미신뢰.
  const dec = evaluateYeokmaeExit({ state, config, quote: { reliableRealtime, price, bestBid: price } });
  const sellQty = computeYeokmaeSellQty({ programManagedQty: qty, freshSellableQty: qty });

  const f = (x: number | null) => x == null ? 'n/a' : x.toFixed(2);
  console.log(`  symbol=${symbol}${synthetic ? ' (SYNTHETIC 진단)' : ''}`);
  console.log(`  strategyTag=${strategyTag}`);
  console.log(`  entryDate=${entryDate} entryAvgPrice=${f(state.entryAvgPrice)} qty=${qty}`);
  console.log(`  currentPrice=${priceArg !== undefined ? f(price) : '없음(실시간 미신뢰)'} pnlPct=${f(dec.pnlPct)}`);
  console.log(`  highestPrice=${f(state.highestPrice)} highestPnlPct=${f(dec.highestPnlPct)} holdDays=${state.holdDays}`);
  console.log(`  config: stopLoss=${config.stopLossPct}% profitMode=${config.profitMode} takeProfit=${config.takeProfitPct}% trailingActivate=${config.trailingActivatePct}% trailingDrawdown=${config.trailingDrawdownPct}% maxHoldDays=${config.maxHoldDays}`);
  console.log(`  stopLossTriggered=${dec.triggers.stopLoss}`);
  console.log(`  takeProfitTriggered=${dec.triggers.takeProfit}`);
  console.log(`  trailingTriggered=${dec.triggers.trailing}`);
  console.log(`  maxHoldTriggered=${dec.triggers.maxHold}`);
  console.log(`  structureInvalidationObserved=${dec.triggers.structureInvalidation} (OBSERVE_ONLY)`);
  console.log(`  finalExitDecision=${dec.action}${dec.reason ? `(${dec.reason})` : ''} sellQty=${sellQty} — ${dec.note}`);
  if (dec.action === 'SELL' && !sellLive) console.log(`  ⚠️ SELL 판정이나 YEOKMAE_SELL_LIVE=false → 실주문 전송 안 함(관찰). 실행은 기존 US SELL 안전 파이프라인 경유.`);
}
main();
