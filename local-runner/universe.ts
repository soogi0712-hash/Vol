// Phase 2 관찰용 종목 소스 — .env.local 에서 심볼을 읽는다(로컬 프로세스는 D1 미접근).
// 전체 유니버스 연결은 Phase 3. 여기서는 소수 종목으로 파이프라인을 검증한다.
//   LS_KR_SYMBOLS = "005930,000660"
//   LS_US_SYMBOLS = "NASDAQ:AAPL,NYSE:BA"   (거래소:심볼, 거래소 생략 시 NASDAQ)
import { toLSOverseasExchcd } from '../src/lib/ls-api';

export interface KRSym { shcode: string; }
export interface USSym { symbol: string; exchange: string; exchcd: string; }

export function loadKRSymbols(): KRSym[] {
  const raw = (process.env.LS_KR_SYMBOLS || '005930').split(',').map(s => s.trim()).filter(Boolean);
  return raw.map(shcode => ({ shcode }));
}

export interface USUniverse { ok: USSym[]; unsupported: Array<{ token: string; exchange: string }>; }

export function loadUSSymbols(): USUniverse {
  const raw = (process.env.LS_US_SYMBOLS || 'NASDAQ:AAPL,NASDAQ:TSLA').split(',').map(s => s.trim()).filter(Boolean);
  const ok: USSym[] = [];
  const unsupported: Array<{ token: string; exchange: string }> = [];
  for (const tok of raw) {
    const [a, b] = tok.includes(':') ? tok.split(':') : ['NASDAQ', tok];
    const exchange = a.trim().toUpperCase();
    const symbol = (b || '').trim().toUpperCase();
    if (!symbol) continue;
    const exchcd = toLSOverseasExchcd(exchange);
    if (!exchcd) { unsupported.push({ token: tok, exchange }); continue; }   // 미확인 거래소 → 추측 금지, 스킵
    ok.push({ symbol, exchange, exchcd });
  }
  return { ok, unsupported };
}
