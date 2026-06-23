/**
 * 자동매매 엔진 v2
 * ─────────────────────────────────────────────────────────────
 * 전략: 15분봉 볼린저밴드 (20, 2) 종가 기준
 *
 * 매수: 직전봉 < 하단선 AND 현재봉 > 하단선 → 시장가 매수
 * 매도: 상단선 위에 있다가 상단선 아래로 내려오면 → 시장가 전량 매도
 *
 * 금지: RSI·MACD·이동평균·거래량·AI·손절률·익절률·분할매수·분할매도
 *       신용·미수, 보유 중 추가매수
 * ─────────────────────────────────────────────────────────────
 */

import type { KISConfig } from './kis-api';
import {
  getAccessToken,
  getKR15MinCandles, getUS15MinCandles,
  getKROrderableCash, getUSOrderableCash,
  getKRHoldings, getUSHoldings,
  buyKR, sellKR, buyUS, sellUS,
} from './kis-api';
import { calcBB, getBBSignal } from './bollinger';

export interface TradeEnv {
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
  market: 'KR' | 'US';
  buy_amount: number;
}

interface HoldingRow {
  ticker: string;
  ticker_name: string;
  market: string;
  qty: number;
  avg_price: number;
  above_upper: number; // 0 | 1
}

// ─── 장 시간 확인 ─────────────────────────────────────────────
function isKRMarketOpen(): boolean {
  // KST = UTC+9
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const day  = kst.getUTCDay();           // 0=일, 6=토
  if (day === 0 || day === 6) return false;
  const hhmm = kst.getUTCHours() * 100 + kst.getUTCMinutes();
  return hhmm >= 900 && hhmm < 1530;
}

function isUSMarketOpen(): boolean {
  // 프리마켓 04:00 ~ 애프터마켓 20:00 EST (UTC-5 / 서머타임 UTC-4)
  const now    = new Date();
  const utc    = now.getTime();
  // 간단히 UTC-5 고정 (서머타임 무시 → 넓게 허용)
  const est    = new Date(utc - 5 * 3600 * 1000);
  const day    = est.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hhmm   = est.getUTCHours() * 100 + est.getUTCMinutes();
  return hhmm >= 400 && hhmm < 2000;
}

// ─── 메인 스캔 ────────────────────────────────────────────────
export async function runTradeScan(env: TradeEnv): Promise<{
  scanned: number; actions: string[]; errors: string[];
}> {
  const actions: string[] = [];
  const errors:  string[] = [];

  // 자동매매 ON 확인
  const cfg = await env.DB.prepare(
    "SELECT key, value FROM system_config WHERE key IN ('auto_trade_enabled','kr_trade_enabled','us_trade_enabled')"
  ).all<{ key: string; value: string }>();
  const cfgMap: Record<string, string> = {};
  (cfg.results || []).forEach(r => { cfgMap[r.key] = r.value; });

  if (cfgMap['auto_trade_enabled'] !== '1') {
    return { scanned: 0, actions: ['자동매매 비활성화 상태'], errors: [] };
  }

  const kisConfig: KISConfig = {
    appKey:        env.KIS_APP_KEY,
    appSecret:     env.KIS_APP_SECRET,
    accountNo:     env.KIS_ACCOUNT_NO,
    accountSuffix: env.KIS_ACCOUNT_SUFFIX || '01',
  };

  let token: string;
  try {
    token = await getAccessToken(kisConfig, env.KV);
  } catch (e) {
    return { scanned: 0, actions: [], errors: [`토큰 발급 실패: ${e}`] };
  }

  // 감시 종목
  const watchRows = await env.DB.prepare(
    'SELECT id, ticker, ticker_name, market, buy_amount FROM watch_list WHERE is_active = 1'
  ).all<WatchItem>();
  if (!watchRows.results?.length) {
    return { scanned: 0, actions: ['감시 종목 없음'], errors: [] };
  }

  // KIS API에서 실제 보유 종목 가져와서 DB 동기화
  try {
    const [krH, usH] = await Promise.all([
      getKRHoldings(kisConfig, token).catch(() => []),
      getUSHoldings(kisConfig, token).catch(() => []),
    ]);
    await syncHoldings(env.DB, [...krH, ...usH]);
  } catch (e) { errors.push(`보유종목 동기화 오류: ${e}`); }

  // 주문가능 현금
  let cashKR = 0, cashUS = 0;
  try { cashKR = await getKROrderableCash(kisConfig, token); } catch (e) { errors.push(`KR 잔고 오류: ${e}`); }
  try { cashUS = await getUSOrderableCash(kisConfig, token); } catch (e) { errors.push(`US 잔고 오류: ${e}`); }

  let scanned = 0;
  const BB_PERIOD = 20;
  const BB_STDDEV = 2;
  const CANDLE_COUNT = 40; // 20봉 계산용 여유분

  for (const item of watchRows.results) {
    // 장 시간 확인
    if (item.market === 'KR' && !isKRMarketOpen()) continue;
    if (item.market === 'US' && !isUSMarketOpen()) continue;
    if (cfgMap[`${item.market.toLowerCase()}_trade_enabled`] !== '1') continue;

    try {
      scanned++;

      // DB에서 보유 상태 조회
      const holdRow = await env.DB.prepare(
        'SELECT ticker, ticker_name, market, qty, avg_price, above_upper FROM holdings WHERE ticker = ?'
      ).bind(item.ticker).first<HoldingRow>();
      const hasPos     = !!holdRow && holdRow.qty > 0;
      const aboveUpper = hasPos ? (holdRow!.above_upper === 1) : false;

      // 15분봉 조회
      const candles = item.market === 'KR'
        ? await getKR15MinCandles(kisConfig, token, item.ticker, CANDLE_COUNT)
        : await getUS15MinCandles(kisConfig, token, item.ticker, CANDLE_COUNT);

      if (candles.length < BB_PERIOD + 2) {
        await logTrade(env.DB, {
          ticker: item.ticker, ticker_name: item.ticker_name, market: item.market,
          action: 'NO_SIGNAL', current_price: 0, bb_upper: 0, bb_middle: 0, bb_lower: 0,
          prev_close: 0, prev_bb_lower: 0, above_upper: 0,
          message: `데이터 부족 (${candles.length}봉)`,
        });
        continue;
      }

      const closes    = candles.map(c => c.close);
      const dts       = candles.map(c => c.datetime);
      const bands     = calcBB(closes, dts, BB_PERIOD, BB_STDDEV);
      const signal    = getBBSignal(bands, hasPos, aboveUpper);

      // 로그 기록 (HOLD/NONE도 일부 기록)
      const logAction = signal.action === 'NONE' ? 'NO_SIGNAL' : `SIGNAL_${signal.action}`;
      await logTrade(env.DB, {
        ticker: item.ticker, ticker_name: item.ticker_name, market: item.market,
        action: logAction,
        current_price: signal.current.close,
        bb_upper:  signal.current.upper,
        bb_middle: signal.current.middle,
        bb_lower:  signal.current.lower,
        prev_close:    signal.prev.close,
        prev_bb_lower: signal.prev.lower,
        above_upper:   signal.above_upper ? 1 : 0,
        message: signal.reason,
      });

      // ── above_upper 플래그 업데이트 (HOLD 포함) ──
      if (hasPos && signal.action === 'HOLD') {
        await env.DB.prepare(
          'UPDATE holdings SET above_upper = ?, updated_at = CURRENT_TIMESTAMP WHERE ticker = ?'
        ).bind(signal.above_upper ? 1 : 0, item.ticker).run();
      }

      // ── 매수 ────────────────────────────────────────────
      if (signal.action === 'BUY') {
        const cash = item.market === 'KR' ? cashKR : cashUS;
        const qty  = Math.floor(item.buy_amount / signal.current.close);
        if (qty < 1) {
          actions.push(`[${item.ticker}] 매수 건너뜀 (수량 0 — 매수금액 ${item.buy_amount} < 현재가 ${signal.current.close})`);
          continue;
        }
        const cost = signal.current.close * qty * 1.002;
        if (cash < cost) {
          actions.push(`[${item.ticker}] 매수 건너뜀 (잔고 부족: 필요 ${cost.toFixed(0)}, 가용 ${cash.toFixed(0)})`);
          continue;
        }

        const result = item.market === 'KR'
          ? await buyKR(kisConfig, token, item.ticker, qty)
          : await buyUS(kisConfig, token, item.ticker, qty);

        await saveOrder(env.DB, {
          order_no: result.order_no, ticker: item.ticker,
          ticker_name: item.ticker_name, market: item.market,
          order_type: 'BUY', price: signal.current.close, qty,
          status: result.success ? 'FILLED' : 'FAILED',
          reason: 'BB_BUY', raw_response: JSON.stringify(result.raw),
        });

        if (result.success) {
          if (item.market === 'KR') cashKR -= cost;
          else cashUS -= cost;
          actions.push(`[${item.ticker}] ${item.ticker_name} 매수 ✓ ${qty}주 @${signal.current.close} — ${signal.reason}`);
        } else {
          errors.push(`[${item.ticker}] 매수 주문 실패: ${result.message}`);
        }
      }

      // ── 매도 ────────────────────────────────────────────
      if (signal.action === 'SELL' && holdRow && holdRow.qty > 0) {
        const qty = holdRow.qty;
        const result = item.market === 'KR'
          ? await sellKR(kisConfig, token, item.ticker, qty)
          : await sellUS(kisConfig, token, item.ticker, qty);

        const ordId = await saveOrder(env.DB, {
          order_no: result.order_no, ticker: item.ticker,
          ticker_name: item.ticker_name, market: item.market,
          order_type: 'SELL', price: signal.current.close, qty,
          status: result.success ? 'FILLED' : 'FAILED',
          reason: 'BB_SELL_UPPER_BREAK', raw_response: JSON.stringify(result.raw),
        });

        if (result.success) {
          const pl  = (signal.current.close - holdRow.avg_price) * qty;
          const ret = ((signal.current.close - holdRow.avg_price) / holdRow.avg_price) * 100;
          await env.DB.prepare(
            `INSERT INTO realized_profits (ticker, ticker_name, market, sell_order_id, buy_price, sell_price, qty, profit_loss, return_rate, sell_reason)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
          ).bind(item.ticker, item.ticker_name, item.market, ordId,
                 holdRow.avg_price, signal.current.close, qty,
                 parseFloat(pl.toFixed(2)), parseFloat(ret.toFixed(4)), 'BB_SELL_UPPER_BREAK').run();

          // 보유 기록 삭제
          await env.DB.prepare('DELETE FROM holdings WHERE ticker = ?').bind(item.ticker).run();
          actions.push(`[${item.ticker}] ${item.ticker_name} 매도 ✓ ${qty}주 @${signal.current.close} 손익:${pl.toFixed(0)} (${ret.toFixed(2)}%) — ${signal.reason}`);
        } else {
          errors.push(`[${item.ticker}] 매도 주문 실패: ${result.message}`);
        }
      }

    } catch (e) {
      const msg = `[${item.ticker}] 처리 오류: ${e}`;
      errors.push(msg);
      await logTrade(env.DB, {
        ticker: item.ticker, ticker_name: item.ticker_name, market: item.market,
        action: 'ERROR', current_price: 0, bb_upper: 0, bb_middle: 0, bb_lower: 0,
        prev_close: 0, prev_bb_lower: 0, above_upper: 0, message: msg,
      });
    }
  }

  // 마지막 스캔 시각
  await env.DB.prepare(
    "UPDATE system_config SET value=?, updated_at=CURRENT_TIMESTAMP WHERE key='last_scan_at'"
  ).bind(new Date().toISOString()).run();

  return { scanned, actions, errors };
}

// ─── 보유 종목 DB 동기화 ─────────────────────────────────────
export async function syncHoldings(db: D1Database, holdings: {
  ticker: string; ticker_name: string; market: 'KR' | 'US';
  qty: number; avg_price: number; current_price: number;
  eval_profit_loss: number; eval_return_rate: number;
}[]): Promise<void> {
  // 기존 레코드 삭제 후 재삽입 (above_upper 플래그는 유지)
  for (const h of holdings) {
    const existing = await db.prepare(
      'SELECT above_upper FROM holdings WHERE ticker = ?'
    ).bind(h.ticker).first<{ above_upper: number }>();
    const au = existing?.above_upper ?? 0;

    await db.prepare(
      `INSERT OR REPLACE INTO holdings
         (ticker, ticker_name, market, qty, avg_price, current_price,
          above_upper, eval_profit_loss, eval_return_rate, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`
    ).bind(h.ticker, h.ticker_name, h.market, h.qty, h.avg_price, h.current_price,
           au, h.eval_profit_loss, h.eval_return_rate).run();
  }

  // qty=0 된 종목 제거
  await db.prepare('DELETE FROM holdings WHERE qty = 0').run();
}

// ─── 헬퍼 ────────────────────────────────────────────────────
async function logTrade(db: D1Database, d: {
  ticker: string; ticker_name: string; market: string;
  action: string; current_price: number;
  bb_upper: number; bb_middle: number; bb_lower: number;
  prev_close: number; prev_bb_lower: number;
  above_upper: number; message: string;
}): Promise<void> {
  await db.prepare(
    `INSERT INTO trade_logs (ticker,ticker_name,market,action,current_price,bb_upper,bb_middle,bb_lower,prev_close,prev_bb_lower,above_upper,message)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(d.ticker, d.ticker_name, d.market, d.action, d.current_price,
         d.bb_upper, d.bb_middle, d.bb_lower, d.prev_close, d.prev_bb_lower,
         d.above_upper, d.message).run();
}

async function saveOrder(db: D1Database, d: {
  order_no: string; ticker: string; ticker_name: string; market: string;
  order_type: string; price: number; qty: number;
  status: string; reason: string; raw_response: string;
}): Promise<number> {
  const r = await db.prepare(
    `INSERT INTO orders (order_no,ticker,ticker_name,market,order_type,price,qty,status,reason,raw_response)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(d.order_no, d.ticker, d.ticker_name, d.market, d.order_type,
         d.price, d.qty, d.status, d.reason, d.raw_response).run();
  return r.meta?.last_row_id as number;
}
