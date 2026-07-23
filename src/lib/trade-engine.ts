/**
 * 자동매매 엔진 v3.1 — 구조적 스캔 결함 수정 (전략 불변)
 * ─────────────────────────────────────────────────────────────
 * ※ 매수/매도 전략은 v3와 100% 동일하다. (익절·손절·TP·SL 추가 없음)
 *   - 매수: 직전봉 ≤ 하단선+1틱 AND 현재봉 > 하단선 AND RSI ≤ 35 AND RSI 상승
 *   - 매도: 상단선 위(above_upper) 였다가 상단선 아래로 내려오면 전량 매도
 *   → getBBSignal(bands, hasPos, aboveUpper, rsiValues) 원본 그대로 호출
 *
 * ■ v3에서 "거래가 한 번도 일어나지 않던" 구조적 원인만 수정
 *   ① watch_list 가 스캔 경로에 전혀 없었다 (getNextBatch 유니버스만 순회).
 *      → 활성 watch_list 종목을 매 스캔 확인.
 *   ② 보유 종목은 유니버스 배치가 그 종목에 도달할 때만 매도 신호를 봤다.
 *      → 보유 종목을 매 스캔 확인.
 *   ③ 유니버스 전량 순회(배치)는 그대로 유지 (기회 포착).
 *   ④ 우선셋/배치가 겹치면 티커 기준 1회만 처리 (중복 스캔 제거).
 *   ⑤ 15분봉은 "확정된 봉"에서만 신호 계산 (형성 중인 최신 봉 제외).
 *   ⑥ 모든 API 오류·주문 실패를 DB(trade_logs / orders)에 기록.
 *
 * ■ 스캔 순서 (매 Cron 사이클)
 *   1) 우선 스캔셋 — 보유 종목 + 활성 watch_list  (항상, 소수라 신호 놓치지 않음)
 *   2) 유니버스 배치 — scan_batch_size 종목씩 순차 순회
 *   중복 티커는 seen 으로 1회만 처리.
 * ─────────────────────────────────────────────────────────────
 */

import type { KISConfig, ExchangeCode, Candle } from './kis-api';
import {
  getAccessToken,
  getKR15MinCandles, getUS15MinCandles,
  getKROrderableCash, getUSOrderableCash,
  getKRHoldings, getUSHoldings,
  buyKR, sellKR, buyUS, sellUS,
} from './kis-api';
import { calcBB, calcRSI, getBBSignal, validateCandleData } from './bollinger';
import {
  getNextBatch, updateUniverseScanResult, loadUniverseToDB,
  type ExchangeName,
} from './stock-universe';
// 기술적 지표 (관찰/저장 전용) — 매매 판단과 완전히 분리된 모듈
import {
  updateIndicatorSnapshot, dropForming, snapshotToRow, rowToBindings, INDICATOR_UPSERT_SQL,
  INDICATOR_DEFAULT_DEPTH, INDICATOR_MIN_DEPTH, SNAPSHOT_COMPLETE_HISTORY,
  accumulateKRHistory, CANDLE_HISTORY_UPSERT_SQL, candleHistoryBindings,
  type IndicatorSnapshot, type IndicatorCandle,
} from './indicators';

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

// 스캔 대상 1건
export interface ScanItem {
  ticker: string;
  ticker_name: string;
  market: 'KR' | 'US';
  exchange: ExchangeName;
  source: 'HOLDING' | 'WATCH' | 'UNIVERSE';
}

// 우선 스캔셋 게이트 — 시장별 개장/거래/스캔 활성 플래그
export interface ScanGate {
  krOpen: boolean;
  usOpen: boolean;
  krTradeEnabled: boolean;
  usTradeEnabled: boolean;
  krScanEnabled: boolean;
  usScanEnabled: boolean;
}

/**
 * 우선 스캔셋 선별 (순수 함수, 테스트 대상).
 *
 * 게이트 규칙 — 보유와 감시를 분리 적용:
 *   • 보유(HOLDING): 해당 시장 개장 AND trade_enabled.
 *     scan_*_enabled 와 무관하게 매 사이클 매도 관리를 유지한다.
 *   • 감시(WATCH):   해당 시장 개장 AND trade_enabled AND scan_*_enabled.
 *     스캔이 꺼져 있으면 매수 후보 평가/주문을 하지 않는다.
 *
 * 티커 중복은 보유 우선(먼저 추가)으로 1회만 처리한다. 즉 보유·감시에
 * 동시에 존재하면 보유 항목으로 1회 스캔되고 감시 중복은 제거된다.
 */
export function selectPriorityScanItems(
  holdings: ScanItem[],
  watch: ScanItem[],
  gate: ScanGate,
): ScanItem[] {
  const marketGate = (market: 'KR' | 'US') =>
    market === 'KR'
      ? { open: gate.krOpen, trade: gate.krTradeEnabled, scan: gate.krScanEnabled }
      : { open: gate.usOpen, trade: gate.usTradeEnabled, scan: gate.usScanEnabled };

  const out: ScanItem[] = [];
  const seen = new Set<string>();

  // 보유: 개장 + 거래 활성 (스캔 플래그 무관)
  for (const h of holdings) {
    const g = marketGate(h.market);
    if (!g.open || !g.trade) continue;
    if (seen.has(h.ticker)) continue;
    seen.add(h.ticker);
    out.push(h);
  }

  // 감시: 개장 + 거래 활성 + 스캔 활성
  for (const w of watch) {
    const g = marketGate(w.market);
    if (!g.open || !g.trade || !g.scan) continue;
    if (seen.has(w.ticker)) continue;
    seen.add(w.ticker);
    out.push(w);
  }

  return out;
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

/**
 * ⑤ 확정봉만 남긴다 — 가장 최근(형성 중일 수 있는) 봉 1개를 제거.
 * KIS 15분봉 조회는 진행 중인 봉을 최신으로 반환할 수 있어,
 * 미확정 봉으로 신호를 계산하면 봉이 마감될 때까지 신호가 바뀐다(리페인트).
 * 전략은 "종가" 기준이므로 마지막 확정봉을 현재봉으로 사용한다.
 */
function confirmedCandles(candles: Candle[]): Candle[] {
  return candles.length > 1 ? candles.slice(0, -1) : candles;
}

// ─── 메인 스캔 함수 ───────────────────────────────────────────
/**
 * runTradeScan — 우선 스캔셋 + 전체시장 배치 스캔
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
       'scan_batch_size','scan_kr_enabled','scan_us_enabled',
       'indicator_candle_cnt','observe_only_enabled'
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
    await logSystemError(env.DB, 'TOKEN_ERROR', `토큰 발급 실패: ${e}`);
    return { scanned: 0, actions: [], errors: [`토큰 발급 실패: ${e}`], kr_market_open: krOpen, us_market_open: usOpen, batch_info: '' };
  }

  // 주문가능 현금
  const cash = { kr: 0, us: 0 };
  try { cash.kr = await getKROrderableCash(kisConfig, token); }
  catch (e) { errors.push(`KR 잔고 오류: ${e}`); await logSystemError(env.DB, 'API_ERROR', `KR 잔고 오류: ${e}`); }
  try { cash.us = await getUSOrderableCash(kisConfig, token); }
  catch (e) { errors.push(`US 잔고 오류: ${e}`); await logSystemError(env.DB, 'API_ERROR', `US 잔고 오류: ${e}`); }

  // 보유종목 DB 동기화
  try {
    const [krH, usH] = await Promise.all([
      getKRHoldings(kisConfig, token).catch((e) => { throw new Error(`KR 보유조회: ${e}`); }),
      getUSHoldings(kisConfig, token).catch((e) => { throw new Error(`US 보유조회: ${e}`); }),
    ]);
    await syncHoldings(env.DB, [...krH, ...usH]);
  } catch (e) {
    errors.push(`보유종목 동기화 오류: ${e}`);
    await logSystemError(env.DB, 'API_ERROR', `보유종목 동기화 오류: ${e}`);
  }

  const BATCH_SIZE = parseInt(cfgMap['scan_batch_size'] || '20');
  const BB_PERIOD  = 20;
  const BB_STDDEV  = 2;
  // 확정봉 1개 제거 후에도 충분한 봉 수 확보를 위해 1개 더 조회
  const CANDLE_CNT = 41;
  // 지표(관찰 전용) 확장 조회 깊이 — 매매용 CANDLE_CNT 와 완전히 별개.
  // EMA120(완결봉 120개) 산출을 위해 raw 최소 121개, 기본 150개(설정 가능).
  const INDICATOR_CANDLE_CNT = Math.min(200, Math.max(
    INDICATOR_MIN_DEPTH,
    parseInt(cfgMap['indicator_candle_cnt'] || String(INDICATOR_DEFAULT_DEPTH)) || INDICATOR_DEFAULT_DEPTH,
  ));

  const krTradeEnabled = cfgMap['kr_trade_enabled'] === '1';
  const usTradeEnabled = cfgMap['us_trade_enabled'] === '1';
  const krScanEnabled  = cfgMap['scan_kr_enabled'] === '1';
  const usScanEnabled  = cfgMap['scan_us_enabled'] === '1';
  // 관찰 전용 모드 — auto_trade_enabled=1 로 스캔은 하되 실주문만 차단한다.
  // 매수/매도 결정·수량·사이징은 원본 그대로 계산되며, 최종 주문 호출만 스킵한다.
  const observeOnly    = cfgMap['observe_only_enabled'] === '1';

  let scanned = 0;
  const batchInfoParts: string[] = [];
  const seen = new Set<string>();  // ④ 티커 중복 스캔 제거

  /**
   * 한 종목을 스캔하고 (원본 전략 그대로) 매수/매도 주문을 실행한다.
   * 우선 스캔셋과 유니버스 배치가 공통으로 사용한다.
   */
  async function processSymbol(item: ScanItem): Promise<void> {
    if (seen.has(item.ticker)) return;   // ④ 중복 제거
    seen.add(item.ticker);
    scanned++;

    const isKR   = item.market === 'KR';
    const exCode = toExchangeCode(item.exchange);

    // ── 15분봉 조회 ──────────────────────────────────────────
    let raw: Candle[];
    try {
      raw = isKR
        ? await getKR15MinCandles(kisConfig, token, item.ticker, CANDLE_CNT)
        : await getUS15MinCandles(kisConfig, token, item.ticker, CANDLE_CNT, exCode);
    } catch (apiErr) {
      const errStr = String(apiErr);
      if (!isKR && errStr.includes('404')) {
        const reason = '해외주식 시세 권한 없음 (KIS HTS에서 해외주식 시세 서비스 신청 필요)';
        await updateUniverseScanResult(env.DB, item.ticker, item.exchange, 'ERROR_US_MARKET_DATA_PERMISSION', reason);
        await logTrade(env.DB, blankLog(item, 'ERROR_US_MARKET_DATA_PERMISSION', `[ERROR_US_MARKET_DATA_PERMISSION] ${reason}`));
        errors.push(`[US시세권한없음] ${item.ticker}: 404 — 해외주식 시세 서비스 미신청`);
      } else {
        await updateUniverseScanResult(env.DB, item.ticker, item.exchange, 'ERROR', errStr);
        await logTrade(env.DB, blankLog(item, 'API_ERROR', `[API_ERROR] ${errStr}`));   // ⑥ API 오류 DB 기록
        errors.push(`[${item.market}:${item.ticker}] API 오류: ${errStr}`);
      }
      return;
    }

    // ── ⑤ 확정봉만 사용 ─────────────────────────────────────
    const candles = confirmedCandles(raw);
    const closes  = candles.map(c => c.close);

    // ── 데이터 품질 검증 ─────────────────────────────────────
    const qv = validateCandleData(closes, 30, 20, 0.001);
    if (!qv.valid) {
      await updateUniverseScanResult(env.DB, item.ticker, item.exchange, 'NO_DATA', qv.reason);
      await logTrade(env.DB, blankLog(item, 'NO_DATA', `[NO_DATA] ${qv.reason} (${qv.detail})`, closes.at(-1) ?? 0));
      return;
    }

    // ── 지표 스냅샷 (관찰/저장 전용) ─────────────────────────
    // 매매용 raw/candles/closes 와 getBBSignal 입력에는 전혀 관여하지 않는다.
    // KR: 국내 15분봉은 추가 KIS 요청으로 장기 이력을 얻을 수 없으므로, 매매가
    //     이미 가져온 확정봉(candles)을 candle_history 에 누적한다.
    //     ★ 누적은 스냅샷 스로틀과 분리되어 매 스캔 실행된다 (스냅샷이 이미 있어도 계속).
    const indTs = candles.at(-1)?.datetime ?? null;
    if (isKR) {
      const acc = await accumulateKRHistory({
        market: item.market, symbol: item.ticker,
        confirmedCandles: candles,   // 매매 확정봉 재사용 (형성봉 제외됨)
        upsert: (m, s, cs) => upsertCandleHistory(env.DB, m, s, cs),
      });
      if (acc.status === 'error') {
        await logTrade(env.DB, blankLog(
          item, 'INDICATOR_ERROR',
          `[INDICATOR_ERROR] ${item.market}/${item.ticker} @${indTs ?? '-'} [history_upsert] ${acc.message}`,
          closes.at(-1) ?? 0,
        ));
      }
    }

    // 스냅샷 계산/저장 (관찰 전용).
    // KR: candle_history 에서 최근 N개를 읽어 계산 (추가 KIS 요청 0).
    // US: NREC 최대 200 확장 조회 후 형성봉 제거 (기존 유지).
    // 스로틀: 이미 "충분히 누적된"(>=120, KR) 스냅샷만 건너뛴다 → 이력 부족 스냅샷은
    //   이후 이력이 쌓이면 self-heal 재계산. US=0 → 스냅샷 있으면 항상 스로틀(재조회 방지).
    // 실패는 완전히 격리된다(예외 미전파) — 매매는 이미 조회한 원본 캔들로 계속.
    const indResult = await updateIndicatorSnapshot({
      market: item.market,
      symbol: item.ticker,
      tradingCompletedTs: indTs,
      existingHistoryCount: (m, s, t) => getSnapshotHistoryCount(env.DB, m, s, t),
      throttleMinHistoryCount: isKR ? SNAPSHOT_COMPLETE_HISTORY : 0,
      loadCandles: isKR
        ? () => readCandleHistory(env.DB, item.market, item.ticker, INDICATOR_CANDLE_CNT)
        : async () => dropForming(
            await getUS15MinCandles(kisConfig, token, item.ticker, INDICATOR_CANDLE_CNT, exCode),
          ),
      saveSnapshot: (s, m, snap) => saveIndicatorSnapshot(env.DB, s, m as 'KR' | 'US', snap),
    });
    if (indResult.status === 'error') {
      await logTrade(env.DB, blankLog(
        item, 'INDICATOR_ERROR',
        `[INDICATOR_ERROR] ${item.market}/${item.ticker} @${indTs ?? '-'} [${indResult.stage}] ${indResult.message}`,
        closes.at(-1) ?? 0,
      ));
    }

    // ── 신호 판단 (원본 전략, 4-인자 호출 그대로) ────────────
    const bands     = calcBB(closes, candles.map(c => c.datetime), BB_PERIOD, BB_STDDEV);
    const rsiValues = calcRSI(closes, 14);
    const holdRow   = await getHoldingRow(env.DB, item.ticker);
    const hasPos    = !!holdRow && holdRow.qty > 0;
    const aboveU    = hasPos ? holdRow!.above_upper === 1 : false;
    const signal    = getBBSignal(bands, hasPos, aboveU, rsiValues);

    await updateUniverseScanResult(env.DB, item.ticker, item.exchange, signal.action);
    await logTrade(env.DB, {
      ticker: item.ticker, ticker_name: item.ticker_name, market: item.market,
      action: signal.action === 'NONE' ? 'NO_SIGNAL' : `SIGNAL_${signal.action}`,
      current_price: signal.current.close, bb_upper: signal.current.upper,
      bb_middle: signal.current.middle, bb_lower: signal.current.lower,
      prev_close: signal.prev.close, prev_bb_lower: signal.prev.lower,
      above_upper: signal.above_upper ? 1 : 0, message: signal.reason,
    });

    // 보유 중 HOLD → 상단돌파 플래그 갱신 (원본 동작)
    if (hasPos && signal.action === 'HOLD') {
      await env.DB.prepare('UPDATE holdings SET above_upper=?,updated_at=CURRENT_TIMESTAMP WHERE ticker=?')
        .bind(signal.above_upper ? 1 : 0, item.ticker).run();
    }

    // ── 매수 (원본 사이징: KR 10만원 / US $500) ──────────────
    if (signal.action === 'BUY') {
      const tradeOn = isKR ? krTradeEnabled : usTradeEnabled;
      if (!tradeOn) return;
      const price = signal.current.close;
      const qty   = Math.floor((isKR ? 100000 : 500) / price);
      const need  = price * qty * 1.002;
      const bal   = isKR ? cash.kr : cash.us;
      if (qty < 1) {
        await logTrade(env.DB, blankLog(item, 'BUY_SKIP', `[BUY_SKIP] 수량 부족 (금액/${price} < 1주)`, price));
        return;
      }
      if (bal < need) {
        await logTrade(env.DB, blankLog(item, 'BUY_SKIP', `[BUY_SKIP] 잔고부족 (필요 ${need.toFixed(0)} > 가용 ${bal.toFixed(0)})`, price));
        return;
      }
      // ── 관찰 전용: 실주문 경계에서 차단 (buyKR/buyUS 미호출) ──
      // 결정/수량/사이징은 위에서 원본 그대로 계산됨. 여기서 주문만 스킵하고,
      // 시뮬레이션 액션을 기록한다. 보유/체결주문/실현손익은 만들지 않는다.
      if (observeOnly) {
        await logTrade(env.DB, blankLog(item, 'OBSERVE_ONLY_BUY',
          `[OBSERVE_ONLY_BUY] ${item.market} ${item.ticker} signal=BUY qty=${qty} price=${price} reason=BB_BUY (${signal.reason})`, price));
        actions.push(`[관찰:${item.market}매수] ${item.ticker} ${item.ticker_name} ${qty}주 @${price} (실주문 없음)`);
        return;
      }
      const res = isKR
        ? await buyKR(kisConfig, token, item.ticker, qty)
        : await buyUS(kisConfig, token, item.ticker, qty, exCode);
      await saveOrder(env.DB, { order_no: res.order_no, ticker: item.ticker, ticker_name: item.ticker_name, market: item.market, order_type: 'BUY', price, qty, status: res.success ? 'FILLED' : 'FAILED', reason: 'BB_BUY', raw_response: JSON.stringify(res.raw) });
      if (res.success) {
        if (isKR) cash.kr -= need; else cash.us -= need;
        actions.push(`[${item.market}매수] ${item.ticker} ${item.ticker_name} ${qty}주 @${price}`);
      } else {
        await logTrade(env.DB, blankLog(item, 'BUY_FAIL', `[BUY_FAIL] ${res.message}`, price));   // ⑥ 주문 실패 DB 기록
        errors.push(`[${item.market}매수실패] ${item.ticker}: ${res.message}`);
      }
      return;
    }

    // ── 매도 (원본: 상단돌파 후 하락) ────────────────────────
    if (signal.action === 'SELL' && holdRow && holdRow.qty > 0) {
      // ── 관찰 전용: 실주문 경계에서 차단 (sellKR/sellUS 미호출) ──
      // 보유 삭제·실현손익·체결주문을 만들지 않는다. 시뮬레이션 액션만 기록.
      if (observeOnly) {
        await logTrade(env.DB, blankLog(item, 'OBSERVE_ONLY_SELL',
          `[OBSERVE_ONLY_SELL] ${item.market} ${item.ticker} signal=SELL qty=${holdRow.qty} price=${signal.current.close} reason=BB_SELL_UPPER_BREAK (${signal.reason})`, signal.current.close));
        actions.push(`[관찰:${item.market}매도] ${item.ticker} ${holdRow.qty}주 @${signal.current.close} (실주문 없음)`);
        return;
      }
      const res = isKR
        ? await sellKR(kisConfig, token, item.ticker, holdRow.qty)
        : await sellUS(kisConfig, token, item.ticker, holdRow.qty, toExchangeCode(holdRow.exchange || item.exchange));
      const ordId = await saveOrder(env.DB, { order_no: res.order_no, ticker: item.ticker, ticker_name: item.ticker_name, market: item.market, order_type: 'SELL', price: signal.current.close, qty: holdRow.qty, status: res.success ? 'FILLED' : 'FAILED', reason: 'BB_SELL_UPPER_BREAK', raw_response: JSON.stringify(res.raw) });
      if (res.success) {
        const pl  = (signal.current.close - holdRow.avg_price) * holdRow.qty;
        const ret = holdRow.avg_price > 0 ? (signal.current.close - holdRow.avg_price) / holdRow.avg_price * 100 : 0;
        await env.DB.prepare(
          `INSERT INTO realized_profits (ticker,ticker_name,market,sell_order_id,buy_price,sell_price,qty,profit_loss,return_rate,sell_reason)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(item.ticker, item.ticker_name, item.market, ordId, holdRow.avg_price, signal.current.close, holdRow.qty, parseFloat(pl.toFixed(2)), parseFloat(ret.toFixed(4)), 'BB_SELL_UPPER_BREAK').run();
        await env.DB.prepare('DELETE FROM holdings WHERE ticker=?').bind(item.ticker).run();
        actions.push(`[${item.market}매도] ${item.ticker} ${holdRow.qty}주 @${signal.current.close} 손익:${pl.toFixed(isKR ? 0 : 2)}`);
      } else {
        await logTrade(env.DB, blankLog(item, 'SELL_FAIL', `[SELL_FAIL] ${res.message}`, signal.current.close));   // ⑥ 주문 실패 DB 기록
        errors.push(`[${item.market}매도실패] ${item.ticker}: ${res.message}`);
      }
    }
  }

  // ── ① 우선 스캔셋: 보유종목 + 활성 감시종목 (매 사이클) ──────
  // 게이트는 순수 함수(selectPriorityScanItems)에서 보유/감시를 분리 적용:
  //   • 보유: 개장 + trade_enabled          (scan_*_enabled 무관 → 매도 관리 유지)
  //   • 감시: 개장 + trade_enabled + scan_*_enabled  (스캔 꺼지면 매수 후보 제외)
  const [holdingItems, watchItems] = await Promise.all([
    buildHoldingScanItems(env.DB),
    buildWatchScanItems(env.DB),
  ]);
  const priorityItems = selectPriorityScanItems(holdingItems, watchItems, {
    krOpen, usOpen,
    krTradeEnabled, usTradeEnabled,
    krScanEnabled, usScanEnabled,
  });
  let priorityScanned = 0;
  for (const item of priorityItems) {
    priorityScanned++;
    try { await processSymbol(item); }
    catch (e) {
      errors.push(`[우선:${item.ticker}] ${e}`);
      await logTrade(env.DB, blankLog(item, 'API_ERROR', `[API_ERROR] ${e}`));
    }
    await sleep(50);
  }
  if (priorityScanned) batchInfoParts.push(`우선셋[${priorityScanned}]`);

  // ── ② 유니버스 배치 스캔 (기존 유지) ────────────────────────
  if (krTradeEnabled && krScanEnabled && krOpen) {
    const batch = await getNextBatch(env.DB, BATCH_SIZE, 'KR');
    batchInfoParts.push(`KR[${batch.offset}/${batch.total}]`);
    for (const it of batch.items) {
      try { await processSymbol({ ticker: it.ticker, ticker_name: it.ticker_name, market: 'KR', exchange: it.exchange, source: 'UNIVERSE' }); }
      catch (e) {
        errors.push(`[KR:${it.ticker}] 처리오류: ${e}`);
        await updateUniverseScanResult(env.DB, it.ticker, it.exchange, 'ERROR', String(e));
      }
      await sleep(50);
    }
  }

  if (usTradeEnabled && usScanEnabled && usOpen) {
    const batch = await getNextBatch(env.DB, BATCH_SIZE, 'US');
    batchInfoParts.push(`US[${batch.offset}/${batch.total}]`);
    for (const it of batch.items) {
      try { await processSymbol({ ticker: it.ticker, ticker_name: it.ticker_name, market: 'US', exchange: it.exchange, source: 'UNIVERSE' }); }
      catch (e) {
        errors.push(`[US:${it.ticker}] 처리오류: ${e}`);
        await updateUniverseScanResult(env.DB, it.ticker, it.exchange, 'ERROR', String(e));
      }
      await sleep(50);
    }
  }

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

// ─── 보유 종목 스캔셋 (매 스캔 매도 신호 확인) ────────────────
async function buildHoldingScanItems(db: D1Database): Promise<ScanItem[]> {
  const items: ScanItem[] = [];
  const seen = new Set<string>();

  const holdings = await db.prepare(
    'SELECT ticker,ticker_name,market,exchange FROM holdings WHERE qty > 0'
  ).all<{ ticker: string; ticker_name: string; market: string; exchange: string }>();
  for (const h of holdings.results || []) {
    if (seen.has(h.ticker)) continue;
    seen.add(h.ticker);
    items.push({
      ticker: h.ticker, ticker_name: h.ticker_name,
      market: h.market === 'US' ? 'US' : 'KR',
      exchange: (h.exchange as ExchangeName) || (h.market === 'US' ? 'NASD' : 'KOSPI'),
      source: 'HOLDING',
    });
  }
  return items;
}

// ─── 활성 감시 종목 스캔셋 (매 스캔 매수 후보 확인) ────────────
async function buildWatchScanItems(db: D1Database): Promise<ScanItem[]> {
  const items: ScanItem[] = [];
  const seen = new Set<string>();

  // exchange 는 유니버스에서 조회
  const watch = await db.prepare(
    'SELECT ticker,ticker_name,market FROM watch_list WHERE is_active = 1'
  ).all<{ ticker: string; ticker_name: string; market: string }>();
  for (const w of watch.results || []) {
    if (seen.has(w.ticker)) continue;
    seen.add(w.ticker);
    const mkt = w.market === 'US' ? 'US' : 'KR';
    let exchange: ExchangeName = mkt === 'US' ? 'NASD' : 'KOSPI';
    const uni = await db.prepare(
      'SELECT exchange FROM stock_universe WHERE ticker = ? LIMIT 1'
    ).bind(w.ticker).first<{ exchange: string }>();
    if (uni?.exchange) exchange = uni.exchange as ExchangeName;
    items.push({
      ticker: w.ticker, ticker_name: w.ticker_name, market: mkt,
      exchange, source: 'WATCH',
    });
  }
  return items;
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

// NO_DATA/ERROR/주문실패 로그용 빈 밴드 로그 생성
function blankLog(item: ScanItem, action: string, message: string, price = 0) {
  return {
    ticker: item.ticker, ticker_name: item.ticker_name, market: item.market, action,
    current_price: price, bb_upper: 0, bb_middle: 0, bb_lower: 0,
    prev_close: 0, prev_bb_lower: 0, above_upper: 0, message,
  };
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

// ⑥ 시스템 수준 오류(토큰/잔고/동기화)를 DB에 기록
async function logSystemError(db: D1Database, action: string, message: string): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO trade_logs (ticker,ticker_name,market,action,current_price,bb_upper,bb_middle,bb_lower,prev_close,prev_bb_lower,above_upper,message)
       VALUES ('SYSTEM','SYSTEM','SYS',?,0,0,0,0,0,0,0,?)`
    ).bind(action, message).run();
  } catch (_) { /* 로깅 실패는 무시 */ }
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

// ⑦ 지표 스냅샷 저장 (관찰/저장 전용) — (market,symbol,candle_ts) UPSERT.
// 반복 스캔은 갱신, 다른 봉 시각은 새 행으로 이력 보존. 매매 로직과 무관.
async function saveIndicatorSnapshot(
  db: D1Database, symbol: string, market: 'KR' | 'US', snap: IndicatorSnapshot,
): Promise<void> {
  const row = snapshotToRow(symbol, market, snap);
  await db.prepare(INDICATOR_UPSERT_SQL).bind(...rowToBindings(row)).run();
}

// 지표 스냅샷 스로틀용 — 동일 완결봉 스냅샷의 history_count 조회 (없으면 null).
// "충분히 누적된" 스냅샷만 스로틀하기 위해 존재 여부가 아니라 누적 캔들 수를 본다.
async function getSnapshotHistoryCount(
  db: D1Database, market: string, symbol: string, candleTs: string,
): Promise<number | null> {
  const row = await db.prepare(
    `SELECT history_count AS hc FROM indicator_snapshots WHERE market=? AND symbol=? AND candle_ts=? LIMIT 1`
  ).bind(market, symbol, candleTs).first<{ hc: number }>();
  return row ? Number(row.hc) : null;
}

// 확정 캔들 이력 UPSERT (관찰 전용) — 형성봉은 호출 측이 이미 제거함. timeframe 명시.
async function upsertCandleHistory(
  db: D1Database, market: string, symbol: string, candles: readonly IndicatorCandle[], timeframe = '15m',
): Promise<void> {
  if (!candles.length) return;
  const stmt = db.prepare(CANDLE_HISTORY_UPSERT_SQL);
  await db.batch(candles.map(c => stmt.bind(...candleHistoryBindings(market, symbol, timeframe, c))));
}

// 확정 캔들 이력에서 최근 limit 개를 oldest→newest 로 읽는다 (timeframe 필터).
async function readCandleHistory(
  db: D1Database, market: string, symbol: string, limit: number, timeframe = '15m',
): Promise<IndicatorCandle[]> {
  const rows = await db.prepare(
    `SELECT candle_ts, open, high, low, close, volume FROM candle_history
     WHERE market=? AND symbol=? AND timeframe=? ORDER BY candle_ts DESC LIMIT ?`
  ).bind(market, symbol, timeframe, limit).all<{
    candle_ts: string; open: number; high: number; low: number; close: number; volume: number;
  }>();
  // DESC 로 읽은 최근 N개를 oldest→newest 로 재정렬
  return (rows.results || [])
    .map(r => ({ datetime: r.candle_ts, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }))
    .reverse();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
