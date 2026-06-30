/**
 * 백테스트 엔진 v3 — BB + RSI(14) 전략
 * KIS API 15분봉 데이터로 과거 검증
 */

import type { KISConfig } from './kis-api';
import { getAccessToken, getKR15MinCandles, getUS15MinCandles } from './kis-api';
import { calcBB, calcRSI, runBacktest, type BacktestTrade } from './bollinger';

export interface BacktestRequest {
  ticker:      string;
  ticker_name: string;
  market:      'KR' | 'US';
  buy_amount:  number;   // 1회 매수금액
  days:        number;   // 백테스트 기간 (일)
}

export interface BacktestSummary {
  ticker:        string;
  ticker_name:   string;
  market:        string;
  total_trades:  number;
  win_trades:    number;
  loss_trades:   number;
  win_rate:      number;
  total_profit:  number;
  avg_return:    number;
  max_drawdown:  number;
  trades:        BacktestTrade[];
  strategy:      string;  // 전략 설명
}

/**
 * KIS API에서 15분봉을 최대한 많이 가져와 백테스트 실행
 * (KIS free plan: 최근 30거래일치 15분봉 조회 가능)
 */
export async function runKISBacktest(
  env: { KIS_APP_KEY: string; KIS_APP_SECRET: string; KIS_ACCOUNT_NO: string; KIS_ACCOUNT_SUFFIX: string; KV?: KVNamespace },
  req: BacktestRequest
): Promise<BacktestSummary> {
  const cfg: KISConfig = {
    appKey:        env.KIS_APP_KEY,
    appSecret:     env.KIS_APP_SECRET,
    accountNo:     env.KIS_ACCOUNT_NO,
    accountSuffix: env.KIS_ACCOUNT_SUFFIX || '01',
  };

  const token = await getAccessToken(cfg, env.KV);

  // KIS API 특성상 한 번 호출로 최대 200봉까지 가져옴
  // (15분봉 × 26봉/일 기준 약 7.5 거래일치)
  // days 파라미터를 기반으로 반복 호출하여 더 많은 데이터 수집 시도
  const maxCandles = Math.min(req.days * 26, 400); // 하루 약 26봉 (KR), API 제한 고려

  const candles = req.market === 'KR'
    ? await getKR15MinCandles(cfg, token, req.ticker, maxCandles)
    : await getUS15MinCandles(cfg, token, req.ticker, maxCandles);

  // RSI(14)는 최소 15봉(period+1) 필요, BB(20)는 최소 21봉 필요
  // → 최소 기준: max(21, 15) = 21봉. 여유있게 35봉 이상 권장
  if (candles.length < 22) {
    throw new Error(`데이터 부족 (${candles.length}봉, 최소 22봉 필요)`);
  }

  const closes    = candles.map(c => c.close);
  const datetimes = candles.map(c => c.datetime);
  const bands     = calcBB(closes, datetimes);
  const rsiValues = calcRSI(closes, 14);
  const { trades } = runBacktest(bands, req.buy_amount, 0.00015, rsiValues);

  return buildSummary(req, trades);
}

/**
 * 임의 OHLCV 데이터로 백테스트 (외부 데이터 주입)
 */
export function runCustomBacktest(
  closes:    number[],
  datetimes: string[],
  req: Pick<BacktestRequest, 'ticker' | 'ticker_name' | 'market' | 'buy_amount'>
): BacktestSummary {
  const bands     = calcBB(closes, datetimes);
  const rsiValues = calcRSI(closes, 14);
  const { trades } = runBacktest(bands, req.buy_amount, 0.00015, rsiValues);
  return buildSummary(req, trades);
}

// ─── 요약 계산 ────────────────────────────────────────────────
function buildSummary(
  req: Pick<BacktestRequest, 'ticker' | 'ticker_name' | 'market'>,
  trades: BacktestTrade[]
): BacktestSummary {
  const total  = trades.length;
  const wins   = trades.filter(t => t.profit_loss > 0).length;
  const totalPL  = trades.reduce((s, t) => s + t.profit_loss, 0);
  const avgRet   = total > 0 ? trades.reduce((s, t) => s + t.return_rate, 0) / total : 0;

  // 최대 낙폭 (매수가 기준)
  let peak = 0, maxDD = 0, cum = 0;
  for (const t of trades) {
    cum += t.profit_loss;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    ticker:       req.ticker,
    ticker_name:  req.ticker_name,
    market:       req.market,
    total_trades: total,
    win_trades:   wins,
    loss_trades:  total - wins,
    win_rate:     total > 0 ? parseFloat((wins / total * 100).toFixed(2)) : 0,
    total_profit: parseFloat(totalPL.toFixed(2)),
    avg_return:   parseFloat(avgRet.toFixed(4)),
    max_drawdown: parseFloat(maxDD.toFixed(2)),
    trades,
    strategy: 'BB(20,2) + RSI(14) — 매수: prev<lower AND curr>lower AND RSI≤35 AND RSI상승 / 매도: above_upper→lower',
  };
}
