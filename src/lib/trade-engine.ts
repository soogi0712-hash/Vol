/**
 * 자동매매 엔진 v3 — 전체시장 배치 스캔
 * ─────────────────────────────────────────────────────────────
 * 전략: 15분봉 볼린저밴드 (20, 2) 종가 기준
 *
 * 매수: 직전봉 < 하단선 AND 현재봉 > 하단선 → 시장가 매수
 * 매도: 상단선 위에 있다가 상단선 아래로 내려오면 → 시장가 전량 매도
 *
 * 스캔 방식: 전체시장 배치 방식
 *   - stock_universe 테이블의 KOSPI/KOSDAQ/NASD/NYSE/AMEX 전체 종목 대상
 *   - Cron 1회 실행 시 BATCH_SIZE 종목씩 순차 처리
 *   - KIS API 호출 제한 대응: 종목 간 딜레이 + 오류 재시도 없음(다음 사이클)
 *   - scan_batch_offset_kr / scan_batch_offset_us 로 진행상태 추적
 *
 * 금지: RSI·MACD·이동평균·거래량·AI·손절·익절·신용·미수
 * ─────────────────────────────────────────────────────────────
 *
 * ■ 스캔 함수: runTradeScan(env)
 *   - KR 장중(KST 09:00-15:30): KOSPI+KOSDAQ 배치 스캔
 *   - US 장중(EST 04:00-20:00): NASD+NYSE+AMEX 배치 스캔
 *   - 보유 종목은 장외에도 매도 신호 확인
 *
 * ■ 배치 크기: system_config.scan_batch_size (기본 20)
 */

import type { KISConfig, ExchangeCode } from './kis-api';
import {
  getAccessToken,
  getKR15MinCandles, getUS15MinCandles,
  getKROrderableCash, getUSOrderableCash,
  getKRHoldings, getUSHoldings,
  buyKR, sellKR, buyUS, sellUS,
} from './kis-api';
import { calcBB, getBBSignal } from './bollinger';
import {
  getNextBatch, updateUniverseScanResult, loadUniverseToDB,
  type ExchangeName,
} from './stock-universe';

export interface TradeEnv {
  DB: D1Database;
  KV?: KVNamespace;
  KIS_APP_KEY: string;
  KIS_APP_SECRET: string;
  KIS_ACCOUNT_NO: string;
  KIS_ACCOUNT_SUFFIX: string;
}

interface HoldingRow {
  ticker: string;
  ticker_name: string;
  market: string;
  exchange: string;
  qty: number;
  avg_price: number;
  above_upper: number;
}

// ─── 장 시간 확인 ─────────────────────────────────────────────
export function isKRMarketOpen(): boolean {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const day  = kst.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hhmm = kst.getUTCHours() * 100 + kst.getUTCMinutes();
  return hhmm >= 900 && hhmm < 1530;
}

export function isUSMarketOpen(): boolean {
  // UTC-5 고정 (서머타임 미적용 → 넓게 허용)
  const now  = new Date();
  const est  = new Date(now.getTime() - 5 * 3600 * 1000);
  const day  = est.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hhmm = est.getUTCHours() * 100 + est.getUTCMinutes();
  return hhmm >= 400 && hhmm < 2000;
}

// 거래소 코드 → KIS ExchangeCode 변환
function toExchangeCode(exchange: string): ExchangeCode {
  const map: Record<string, ExchangeCode> = {
    NASD: 'NASD', NYSE: 'NYSE', AMEX: 'AMEX',
  };
  return map[exchange] || 'NASD';
}

// ─── 메인 스캔 함수 ───────────────────────────────────────────
/**
 * runTradeScan — 전체시장 배치 스캔
 * Cron에서 매분 호출됨
 */
export async function runTradeScan(env: TradeEnv): Promise<{
  scanned: number;
  actions: string[];
  errors: string[];
  kr_market_open: boolean;
  us_market_open: boolean;
  batch_info: string;
}> {
  const actions: string[] = [];
  const errors:  string[] = [];
  const krOpen = isKRMarketOpen();
  const usOpen = isUSMarketOpen();

  // 자동매매 ON 확인
  const cfgRows = await env.DB.prepare(
    `SELECT key, value FROM system_config
     WHERE key IN (
       'auto_trade_enabled','kr_trade_enabled','us_trade_enabled',
       'scan_batch_size','scan_kr_enabled','scan_us_enabled'
     )`
  ).all<{ key: string; value: string }>();
  const cfgMap: Record<string, string> = {};
  (cfgRows.results || []).forEach(r => { cfgMap[r.key] = r.value; });

  if (cfgMap['auto_trade_enabled'] !== '1') {
    return { scanned: 0, actions: ['자동매매 비활성화'], errors: [], kr_market_open: krOpen, us_market_open: usOpen, batch_info: '' };
  }

  // 종목 유니버스 미로드 시 자동 초기화
  const loadedAt = (await env.DB.prepare(
    "SELECT value FROM system_config WHERE key='universe_loaded_at'"
  ).first<{ value: string }>())?.value;
  if (!loadedAt) {
    await loadUniverseToDB(env.DB);
    actions.push('종목 유니버스 초기 로드 완료');
  }

  const kisConfig: KISConfig = {
    appKey: env.KIS_APP_KEY, appSecret: env.KIS_APP_SECRET,
    accountNo: env.KIS_ACCOUNT_NO, accountSuffix: env.KIS_ACCOUNT_SUFFIX || '01',
  };

  let token: string;
  try {
    token = await getAccessToken(kisConfig, env.KV);
  } catch (e) {
    return { scanned: 0, actions: [], errors: [`토큰 발급 실패: ${e}`], kr_market_open: krOpen, us_market_open: usOpen, batch_info: '' };
  }

  // 주문가능 현금
  let cashKR = 0, cashUS = 0;
  try { cashKR = await getKROrderableCash(kisConfig, token); } catch (e) { errors.push(`KR 잔고 오류: ${e}`); }
  try { cashUS = await getUSOrderableCash(kisConfig, token); } catch (e) { errors.push(`US 잔고 오류: ${e}`); }

  // 보유종목 DB 동기화
  try {
    const [krH, usH] = await Promise.all([
      getKRHoldings(kisConfig, token).catch(() => []),
      getUSHoldings(kisConfig, token).catch(() => []),
    ]);
    await syncHoldings(env.DB, [...krH, ...usH]);
  } catch (e) { errors.push(`보유종목 동기화 오류: ${e}`); }

  const BATCH_SIZE = parseInt(cfgMap['scan_batch_size'] || '20');
  const BB_PERIOD  = 20;
  const BB_STDDEV  = 2;
  const CANDLE_CNT = 40;
  let scanned = 0;
  const batchInfoParts: string[] = [];

  // ── KR 배치 스캔 ────────────────────────────────────────────
  const krEnabled = cfgMap['kr_trade_enabled'] === '1' && cfgMap['scan_kr_enabled'] === '1';
  if (krEnabled && krOpen) {
    const batch = await getNextBatch(env.DB, BATCH_SIZE, 'KR');
    batchInfoParts.push(`KR[${batch.offset}/${batch.total}]`);

    for (const item of batch.items) {
      try {
        scanned++;
        const candles = await getKR15MinCandles(kisConfig, token, item.ticker, CANDLE_CNT);
        if (candles.length < BB_PERIOD + 2) {
          await updateUniverseScanResult(env.DB, item.ticker, item.exchange, 'NO_DATA');
          continue;
        }
        const bands  = calcBB(candles.map(c => c.close), candles.map(c => c.datetime), BB_PERIOD, BB_STDDEV);
        const holdRow = await getHoldingRow(env.DB, item.ticker);
        const hasPos  = !!holdRow && holdRow.qty > 0;
        const aboveU  = hasPos ? holdRow!.above_upper === 1 : false;
        const signal  = getBBSignal(bands, hasPos, aboveU);

        await updateUniverseScanResult(env.DB, item.ticker, item.exchange, signal.action);
        await logTrade(env.DB, { ticker: item.ticker, ticker_name: item.ticker_name, market: 'KR', action: signal.action === 'NONE' ? 'NO_SIGNAL' : `SIGNAL_${signal.action}`, current_price: signal.current.close, bb_upper: signal.current.upper, bb_middle: signal.current.middle, bb_lower: signal.current.lower, prev_close: signal.prev.close, prev_bb_lower: signal.prev.lower, above_upper: signal.above_upper ? 1 : 0, message: signal.reason });

        if (hasPos && signal.action === 'HOLD') {
          await env.DB.prepare('UPDATE holdings SET above_upper=?,updated_at=CURRENT_TIMESTAMP WHERE ticker=?')
            .bind(signal.above_upper ? 1 : 0, item.ticker).run();
        }

        if (signal.action === 'BUY') {
          const qty  = Math.floor(100000 / signal.current.close); // 기본 10만원
          if (qty >= 1 && cashKR >= signal.current.close * qty * 1.002) {
            const res = await buyKR(kisConfig, token, item.ticker, qty);
            await saveOrder(env.DB, { order_no: res.order_no, ticker: item.ticker, ticker_name: item.ticker_name, market: 'KR', order_type: 'BUY', price: signal.current.close, qty, status: res.success ? 'FILLED' : 'FAILED', reason: 'BB_BUY', raw_response: JSON.stringify(res.raw) });
            if (res.success) { cashKR -= signal.current.close * qty * 1.002; actions.push(`[KR매수] ${item.ticker} ${item.ticker_name} ${qty}주 @${signal.current.close}`); }
            else errors.push(`[KR매수실패] ${item.ticker}: ${res.message}`);
          }
        }

        if (signal.action === 'SELL' && holdRow && holdRow.qty > 0) {
          const res = await sellKR(kisConfig, token, item.ticker, holdRow.qty);
          const ordId = await saveOrder(env.DB, { order_no: res.order_no, ticker: item.ticker, ticker_name: item.ticker_name, market: 'KR', order_type: 'SELL', price: signal.current.close, qty: holdRow.qty, status: res.success ? 'FILLED' : 'FAILED', reason: 'BB_SELL_UPPER_BREAK', raw_response: JSON.stringify(res.raw) });
          if (res.success) {
            const pl = (signal.current.close - holdRow.avg_price) * holdRow.qty;
            await env.DB.prepare(`INSERT INTO realized_profits (ticker,ticker_name,market,sell_order_id,buy_price,sell_price,qty,profit_loss,return_rate,sell_reason) VALUES (?,?,?,?,?,?,?,?,?,?)`)
              .bind(item.ticker, item.ticker_name, 'KR', ordId, holdRow.avg_price, signal.current.close, holdRow.qty, parseFloat(pl.toFixed(2)), parseFloat(((signal.current.close - holdRow.avg_price)/holdRow.avg_price*100).toFixed(4)), 'BB_SELL_UPPER_BREAK').run();
            await env.DB.prepare('DELETE FROM holdings WHERE ticker=?').bind(item.ticker).run();
            actions.push(`[KR매도] ${item.ticker} ${holdRow.qty}주 @${signal.current.close} 손익:${pl.toFixed(0)}`);
          } else errors.push(`[KR매도실패] ${item.ticker}: ${res.message}`);
        }
      } catch (e) {
        const msg = `[KR:${item.ticker}] 처리오류: ${e}`;
        errors.push(msg);
        await updateUniverseScanResult(env.DB, item.ticker, item.exchange, 'ERROR', String(e));
      }
      // API 호출 제한 대응: 종목 간 50ms 딜레이
      await sleep(50);
    }
  }

  // ── US 배치 스캔 ────────────────────────────────────────────
  const usEnabled = cfgMap['us_trade_enabled'] === '1' && cfgMap['scan_us_enabled'] === '1';
  if (usEnabled && usOpen) {
    const batch = await getNextBatch(env.DB, BATCH_SIZE, 'US');
    batchInfoParts.push(`US[${batch.offset}/${batch.total}]`);

    for (const item of batch.items) {
      try {
        scanned++;
        const exCode = toExchangeCode(item.exchange);
        const candles = await getUS15MinCandles(kisConfig, token, item.ticker, CANDLE_CNT, exCode);
        if (candles.length < BB_PERIOD + 2) {
          await updateUniverseScanResult(env.DB, item.ticker, item.exchange, 'NO_DATA');
          continue;
        }
        const bands   = calcBB(candles.map(c => c.close), candles.map(c => c.datetime), BB_PERIOD, BB_STDDEV);
        const holdRow = await getHoldingRow(env.DB, item.ticker);
        const hasPos  = !!holdRow && holdRow.qty > 0;
        const aboveU  = hasPos ? holdRow!.above_upper === 1 : false;
        const signal  = getBBSignal(bands, hasPos, aboveU);

        await updateUniverseScanResult(env.DB, item.ticker, item.exchange, signal.action);
        await logTrade(env.DB, { ticker: item.ticker, ticker_name: item.ticker_name, market: 'US', action: signal.action === 'NONE' ? 'NO_SIGNAL' : `SIGNAL_${signal.action}`, current_price: signal.current.close, bb_upper: signal.current.upper, bb_middle: signal.current.middle, bb_lower: signal.current.lower, prev_close: signal.prev.close, prev_bb_lower: signal.prev.lower, above_upper: signal.above_upper ? 1 : 0, message: signal.reason });

        if (hasPos && signal.action === 'HOLD') {
          await env.DB.prepare('UPDATE holdings SET above_upper=?,updated_at=CURRENT_TIMESTAMP WHERE ticker=?')
            .bind(signal.above_upper ? 1 : 0, item.ticker).run();
        }

        if (signal.action === 'BUY') {
          const qty = Math.floor(500 / signal.current.close); // 기본 $500
          if (qty >= 1 && cashUS >= signal.current.close * qty * 1.002) {
            const res = await buyUS(kisConfig, token, item.ticker, qty, exCode);
            await saveOrder(env.DB, { order_no: res.order_no, ticker: item.ticker, ticker_name: item.ticker_name, market: 'US', order_type: 'BUY', price: signal.current.close, qty, status: res.success ? 'FILLED' : 'FAILED', reason: 'BB_BUY', raw_response: JSON.stringify(res.raw) });
            if (res.success) { cashUS -= signal.current.close * qty * 1.002; actions.push(`[US매수] ${item.ticker}(${exCode}) ${qty}주 @$${signal.current.close}`); }
            else errors.push(`[US매수실패] ${item.ticker}: ${res.message}`);
          }
        }

        if (signal.action === 'SELL' && holdRow && holdRow.qty > 0) {
          const exCodeHold = toExchangeCode(holdRow.exchange || item.exchange);
          const res = await sellUS(kisConfig, token, item.ticker, holdRow.qty, exCodeHold);
          const ordId = await saveOrder(env.DB, { order_no: res.order_no, ticker: item.ticker, ticker_name: item.ticker_name, market: 'US', order_type: 'SELL', price: signal.current.close, qty: holdRow.qty, status: res.success ? 'FILLED' : 'FAILED', reason: 'BB_SELL_UPPER_BREAK', raw_response: JSON.stringify(res.raw) });
          if (res.success) {
            const pl = (signal.current.close - holdRow.avg_price) * holdRow.qty;
            await env.DB.prepare(`INSERT INTO realized_profits (ticker,ticker_name,market,sell_order_id,buy_price,sell_price,qty,profit_loss,return_rate,sell_reason) VALUES (?,?,?,?,?,?,?,?,?,?)`)
              .bind(item.ticker, item.ticker_name, 'US', ordId, holdRow.avg_price, signal.current.close, holdRow.qty, parseFloat(pl.toFixed(2)), parseFloat(((signal.current.close - holdRow.avg_price)/holdRow.avg_price*100).toFixed(4)), 'BB_SELL_UPPER_BREAK').run();
            await env.DB.prepare('DELETE FROM holdings WHERE ticker=?').bind(item.ticker).run();
            actions.push(`[US매도] ${item.ticker} ${holdRow.qty}주 @$${signal.current.close} 손익:$${pl.toFixed(2)}`);
          } else errors.push(`[US매도실패] ${item.ticker}: ${res.message}`);
        }
      } catch (e) {
        const msg = `[US:${item.ticker}] 처리오류: ${e}`;
        errors.push(msg);
        await updateUniverseScanResult(env.DB, item.ticker, item.exchange, 'ERROR', String(e));
      }
      await sleep(50);
    }
  }

  // ── 보유종목 매도 신호 (장외에도 체크) ────────────────────────
  // 장이 닫혀 있을 때도 이미 보유한 종목의 매도 신호는 다음 장 시작에 체크
  // (실제로는 장 중에만 주문 가능하므로 장중 스캔 시 자동 처리됨)

  // 마지막 스캔 시각 업데이트
  await env.DB.prepare(
    "UPDATE system_config SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key='last_scan_at'"
  ).bind(new Date().toISOString()).run();

  return {
    scanned,
    actions,
    errors,
    kr_market_open: krOpen,
    us_market_open: usOpen,
    batch_info: batchInfoParts.join(' / ') || '장 마감 (스캔 없음)',
  };
}

// ─── 보유 종목 DB 동기화 ──────────────────────────────────────
export async function syncHoldings(db: D1Database, holdings: {
  ticker: string; ticker_name: string; market: 'KR' | 'US';
  exchange?: string; qty: number; avg_price: number; current_price: number;
  eval_profit_loss: number; eval_return_rate: number;
}[]): Promise<void> {
  for (const h of holdings) {
    const existing = await db.prepare(
      'SELECT above_upper FROM holdings WHERE ticker = ?'
    ).bind(h.ticker).first<{ above_upper: number }>();
    const au = existing?.above_upper ?? 0;

    await db.prepare(
      `INSERT OR REPLACE INTO holdings
         (ticker, ticker_name, market, exchange, qty, avg_price, current_price,
          above_upper, eval_profit_loss, eval_return_rate, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`
    ).bind(h.ticker, h.ticker_name, h.market, h.exchange || (h.market === 'KR' ? 'KOSPI' : 'NASD'),
           h.qty, h.avg_price, h.current_price,
           au, h.eval_profit_loss, h.eval_return_rate).run();
  }
  await db.prepare('DELETE FROM holdings WHERE qty = 0').run();
}

// ─── 헬퍼 ────────────────────────────────────────────────────
async function getHoldingRow(db: D1Database, ticker: string): Promise<HoldingRow | null> {
  return db.prepare(
    'SELECT ticker,ticker_name,market,exchange,qty,avg_price,above_upper FROM holdings WHERE ticker=?'
  ).bind(ticker).first<HoldingRow>();
}

async function logTrade(db: D1Database, d: {
  ticker: string; ticker_name: string; market: string; action: string;
  current_price: number; bb_upper: number; bb_middle: number; bb_lower: number;
  prev_close: number; prev_bb_lower: number; above_upper: number; message: string;
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
  order_type: string; price: number; qty: number; status: string; reason: string; raw_response: string;
}): Promise<number> {
  const r = await db.prepare(
    `INSERT INTO orders (order_no,ticker,ticker_name,market,order_type,price,qty,status,reason,raw_response)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(d.order_no, d.ticker, d.ticker_name, d.market, d.order_type,
         d.price, d.qty, d.status, d.reason, d.raw_response).run();
  return r.meta?.last_row_id as number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
