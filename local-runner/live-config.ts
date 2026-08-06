// Phase 3A 실전 설정 — 환경변수에서 읽는다. 오늘 실전 제한을 코드로 강제한다.
//   대상 1종목(NASDAQ:AAPL), 최대 1주, 지정가만, 하루 매수/매도 각 1회.
// ⚠️ 실주문은 armed + LS_LIVE_TRADING=true + LS_CANCEL_TR_CONFIRMED=true 전부일 때만(3중 차단).
import { toLSOverseasExchcd } from '../src/lib/ls-api';

export interface LiveConfig {
  liveSymbol: string;          // 'AAPL'
  liveExchange: string;        // 'NASDAQ'
  liveExchcd: string;          // '82'
  maxQty: number;              // 1 (상한 강제)
  dailyMaxBuys: number;        // 1
  dailyMaxSells: number;       // 1
  armed: boolean;              // LS_TRADING_ARMED
  liveTrading: boolean;        // LS_LIVE_TRADING
  cancelConfirmed: boolean;    // LS_CANCEL_TR_CONFIRMED (공식 취소 필드 확인 시에만 true)
  pendingTimeoutSec: number;   // 미체결 취소까지 대기 시간(초)
}

const intEnv = (name: string, def: number, min: number, max: number): number => {
  const n = parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
};

// LS_US_LIVE_SYMBOL="NASDAQ:AAPL" 파싱. 거래소 미확인이면 예외(추측 금지).
export function loadLiveConfig(): LiveConfig {
  const raw = (process.env.LS_US_LIVE_SYMBOL || 'NASDAQ:AAPL').trim();
  const [exRaw, symRaw] = raw.includes(':') ? raw.split(':') : ['NASDAQ', raw];
  const liveExchange = (exRaw || 'NASDAQ').trim().toUpperCase();
  const liveSymbol = (symRaw || '').trim().toUpperCase();
  const liveExchcd = toLSOverseasExchcd(liveExchange) ?? '';
  if (!liveSymbol || !liveExchcd) throw new Error(`LS_US_LIVE_SYMBOL 파싱 실패/거래소 미확인: '${raw}'`);
  return {
    liveSymbol, liveExchange, liveExchcd,
    maxQty: intEnv('LS_US_MAX_QTY', 1, 1, 1),               // 오늘은 상한 1주로 하드 제한
    dailyMaxBuys: intEnv('LS_US_DAILY_MAX_BUYS', 1, 0, 1),  // 오늘은 최대 1
    dailyMaxSells: intEnv('LS_US_DAILY_MAX_SELLS', 1, 0, 1),
    armed: process.env.LS_TRADING_ARMED === 'true',
    liveTrading: process.env.LS_LIVE_TRADING === 'true',
    cancelConfirmed: process.env.LS_CANCEL_TR_CONFIRMED === 'true',
    pendingTimeoutSec: intEnv('LS_US_PENDING_TIMEOUT_SEC', 60, 5, 600),
  };
}

// 이 종목이 오늘 실전 대상인가(1종목만 허용).
export function isLiveSymbol(cfg: LiveConfig, symbol: string): boolean {
  return symbol.toUpperCase() === cfg.liveSymbol;
}
