// 자동매매 엔진

import type { KISConfig } from './kis-api';
import {
  getAccessToken,
  getDailyCandles,
  getOrderableBalance,
  getHoldings,
  placeBuyOrder,
  placeSellOrder,
} from './kis-api';
import { calcBollingerBands, getBollingerSignal } from './bollinger';

export interface TradeEngineBindings {
  DB: D1Database;
  KV?: KVNamespace;
  KIS_APP_KEY: string;
  KIS_APP_SECRET: string;
  KIS_ACCOUNT_NO: string;
  KIS_ACCOUNT_SUFFIX: string;
}

interface WatchItem {
  id: number;
  ticker: string;
  ticker_name: string;
  bb_period: number;
  bb_stddev: number;
  buy_qty: number;
}

// 현재 장 시간인지 확인 (KST 09:00 ~ 15:30)
function isMarketOpen(): boolean {
  const now = new Date();
  // UTC+9 (KST)
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const h = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  const timeNum = h * 100 + m;
  // 월~금
  const day = kst.getUTCDay(); // 0=일, 6=토
  if (day === 0 || day === 6) return false;
  return timeNum >= 900 && timeNum <= 1530;
}

// 메인 스캔 함수
export async function runTradeScan(env: TradeEngineBindings): Promise<{
  scanned: number;
  actions: string[];
  errors: string[];
}> {
  const actions: string[] = [];
  const errors: string[] = [];

  // 자동매매 활성화 여부 확인
  const configRow = await env.DB.prepare(
    "SELECT value FROM system_config WHERE key = 'auto_trade_enabled'"
  ).first<{ value: string }>();
  
  if (!configRow || configRow.value !== '1') {
    return { scanned: 0, actions: ['자동매매가 비활성화 상태입니다.'], errors: [] };
  }

  // 장 시간 확인
  if (!isMarketOpen()) {
    return { scanned: 0, actions: ['장 시간이 아닙니다 (09:00~15:30, 평일)'], errors: [] };
  }

  const config: KISConfig = {
    appKey: env.KIS_APP_KEY,
    appSecret: env.KIS_APP_SECRET,
    accountNo: env.KIS_ACCOUNT_NO,
    accountSuffix: env.KIS_ACCOUNT_SUFFIX || '01',
  };

  let token: string;
  try {
    token = await getAccessToken(config, env.KV);
  } catch (e) {
    const msg = `토큰 발급 실패: ${String(e)}`;
    errors.push(msg);
    return { scanned: 0, actions, errors };
  }

  // 감시 종목 가져오기
  const watchItems = await env.DB.prepare(
    'SELECT id, ticker, ticker_name, bb_period, bb_stddev, buy_qty FROM watch_list WHERE is_active = 1'
  ).all<WatchItem>();

  if (!watchItems.results || watchItems.results.length === 0) {
    return { scanned: 0, actions: ['감시 종목이 없습니다.'], errors: [] };
  }

  // 실시간 보유 종목 동기화
  let holdings: Awaited<ReturnType<typeof getHoldings>> = [];
  try {
    holdings = await getHoldings(config, token);
    // DB 보유 종목 동기화
    await syncHoldings(env.DB, holdings);
  } catch (e) {
    errors.push(`보유 종목 조회 실패: ${String(e)}`);
  }

  const holdingMap = new Map(holdings.map((h) => [h.ticker, h]));

  // 주문가능 현금
  let availableCash = 0;
  try {
    const balance = await getOrderableBalance(config, token, 10000);
    availableCash = balance.cash;
  } catch (e) {
    errors.push(`잔고 조회 실패: ${String(e)}`);
  }

  let scanned = 0;

  for (const item of watchItems.results) {
    try {
      scanned++;
      const holding = holdingMap.get(item.ticker);
      const hasPosition = !!holding && holding.qty > 0;

      // 일봉 데이터 조회 (최근 period+10 개)
      const candleCount = item.bb_period + 10;
      const candles = await getDailyCandles(config, token, item.ticker, candleCount);

      if (candles.length < item.bb_period) {
        await logTrade(env.DB, {
          ticker: item.ticker,
          ticker_name: item.ticker_name,
          action: 'NO_SIGNAL',
          current_price: 0,
          bb_upper: 0,
          bb_middle: 0,
          bb_lower: 0,
          prev_close: 0,
          prev_bb_lower: 0,
          message: `데이터 부족: ${candles.length}개 (필요: ${item.bb_period}개)`,
        });
        continue;
      }

      const closes = candles.map((c) => c.close);
      const dates = candles.map((c) => c.date);
      const bands = calcBollingerBands(closes, dates, item.bb_period, item.bb_stddev);

      const signal = getBollingerSignal(bands, hasPosition);

      // 로그 기록
      await logTrade(env.DB, {
        ticker: item.ticker,
        ticker_name: item.ticker_name,
        action: signal.action === 'NONE' ? 'NO_SIGNAL' : `SIGNAL_${signal.action}`,
        current_price: signal.current.close,
        bb_upper: signal.current.upper,
        bb_middle: signal.current.middle,
        bb_lower: signal.current.lower,
        prev_close: signal.prev.close,
        prev_bb_lower: signal.prev.lower,
        message: signal.reason,
      });

      if (signal.action === 'NONE') {
        continue;
      }

      // 매수
      if (signal.action === 'BUY') {
        const estimatedCost = signal.current.close * item.buy_qty * 1.0015; // 수수료 포함
        if (availableCash < estimatedCost) {
          const msg = `[${item.ticker}] 매수 신호 → 잔액 부족 (필요: ${estimatedCost.toFixed(0)}원, 가용: ${availableCash.toFixed(0)}원)`;
          actions.push(msg);
          continue;
        }

        const result = await placeBuyOrder(config, token, item.ticker, item.buy_qty);
        await saveOrder(env.DB, {
          order_no: result.order_no,
          ticker: item.ticker,
          ticker_name: item.ticker_name,
          order_type: 'BUY',
          price: signal.current.close,
          qty: item.buy_qty,
          status: result.success ? 'FILLED' : 'FAILED',
          reason: 'BB_BUY',
          raw_response: JSON.stringify(result.raw),
        });

        if (result.success) {
          availableCash -= estimatedCost;
          const msg = `[${item.ticker}] ${item.ticker_name} 매수 완료 (${item.buy_qty}주 @ ${signal.current.close.toFixed(0)}원) - ${signal.reason}`;
          actions.push(msg);
        } else {
          actions.push(`[${item.ticker}] 매수 주문 실패: ${result.message}`);
        }
      }

      // 매도
      if ((signal.action === 'SELL_MID' || signal.action === 'SELL_UPPER') && holding) {
        const sellQty = holding.qty;
        const sellReason = signal.action === 'SELL_UPPER' ? 'BB_SELL_UPPER' : 'BB_SELL_MID';

        const result = await placeSellOrder(config, token, item.ticker, sellQty);
        const orderId = await saveOrder(env.DB, {
          order_no: result.order_no,
          ticker: item.ticker,
          ticker_name: item.ticker_name,
          order_type: 'SELL',
          price: signal.current.close,
          qty: sellQty,
          status: result.success ? 'FILLED' : 'FAILED',
          reason: sellReason,
          raw_response: JSON.stringify(result.raw),
        });

        if (result.success) {
          // 실현손익 기록
          const profitLoss = (signal.current.close - holding.avg_price) * sellQty;
          const returnRate = ((signal.current.close - holding.avg_price) / holding.avg_price) * 100;
          await env.DB.prepare(
            `INSERT INTO realized_profits (ticker, ticker_name, sell_order_id, buy_price, sell_price, qty, profit_loss, return_rate, sell_reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              item.ticker,
              item.ticker_name,
              orderId,
              holding.avg_price,
              signal.current.close,
              sellQty,
              profitLoss,
              returnRate,
              sellReason
            )
            .run();

          const msg = `[${item.ticker}] ${item.ticker_name} 매도 완료 (${sellQty}주 @ ${signal.current.close.toFixed(0)}원, 손익: ${profitLoss.toFixed(0)}원, ${returnRate.toFixed(2)}%) - ${signal.reason}`;
          actions.push(msg);
        } else {
          actions.push(`[${item.ticker}] 매도 주문 실패: ${result.message}`);
        }
      }
    } catch (e) {
      const msg = `[${item.ticker}] 처리 오류: ${String(e)}`;
      errors.push(msg);
      await logTrade(env.DB, {
        ticker: item.ticker,
        ticker_name: item.ticker_name,
        action: 'ERROR',
        current_price: 0,
        bb_upper: 0,
        bb_middle: 0,
        bb_lower: 0,
        prev_close: 0,
        prev_bb_lower: 0,
        message: msg,
      });
    }
  }

  // 마지막 스캔 시각 업데이트
  await env.DB.prepare(
    "UPDATE system_config SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'last_scan_at'"
  )
    .bind(new Date().toISOString())
    .run();

  return { scanned, actions, errors };
}

// ─── 헬퍼 함수 ───────────────────────────────────────────────

async function syncHoldings(
  db: D1Database,
  holdings: Awaited<ReturnType<typeof getHoldings>>
): Promise<void> {
  // 기존 보유 종목 초기화
  await db.prepare('DELETE FROM holdings').run();

  for (const h of holdings) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO holdings (ticker, ticker_name, qty, avg_price, current_price, eval_profit_loss, eval_return_rate, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      )
      .bind(h.ticker, h.ticker_name, h.qty, h.avg_price, h.current_price, h.eval_profit_loss, h.eval_return_rate)
      .run();
  }
}

async function logTrade(
  db: D1Database,
  data: {
    ticker: string;
    ticker_name: string;
    action: string;
    current_price: number;
    bb_upper: number;
    bb_middle: number;
    bb_lower: number;
    prev_close: number;
    prev_bb_lower: number;
    message: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO trade_logs (ticker, ticker_name, action, current_price, bb_upper, bb_middle, bb_lower, prev_close, prev_bb_lower, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      data.ticker,
      data.ticker_name,
      data.action,
      data.current_price,
      data.bb_upper,
      data.bb_middle,
      data.bb_lower,
      data.prev_close,
      data.prev_bb_lower,
      data.message
    )
    .run();
}

async function saveOrder(
  db: D1Database,
  data: {
    order_no: string;
    ticker: string;
    ticker_name: string;
    order_type: string;
    price: number;
    qty: number;
    status: string;
    reason: string;
    raw_response: string;
  }
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO orders (order_no, ticker, ticker_name, order_type, price, qty, status, reason, raw_response)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      data.order_no,
      data.ticker,
      data.ticker_name,
      data.order_type,
      data.price,
      data.qty,
      data.status,
      data.reason,
      data.raw_response
    )
    .run();
  return result.meta?.last_row_id as number;
}
