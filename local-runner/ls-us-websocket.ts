// LS 해외주식 실시간 시세 (WebSocket GSC/GSH) — 로컬 프로세스 전용, 관찰 전용.
// 출처(공식 카탈로그 확인):
//   - WS URL: wss://openapi.ls-sec.co.kr:9443/websocket
//   - 등록:   { header:{ token, tr_type:"3" }, body:{ tr_cd:"GSC"|"GSH", tr_key } }
//   - tr_key: exchcd+symbol 을 총 18자리 오른쪽 공백 패딩 (공식 예: "81SOXL            ")
//   - GSC body: price/trdq/totq/ovsdate/trdtm/open/high/low ... (해외주식 체결)
//   - GSH body: offerho1/bidho1/offerrem1/bidrem1 ... (해외주식 호가)
//   - exchcd: 82=NASDAQ, 81=NYSE/AMEX
// ※ 주문/전략 판단 로직은 여기서 다루지 않는다. LS_LIVE_TRADING 과 무관하게 시세 수신만.

export const LS_WS_URL = 'wss://openapi.ls-sec.co.kr:9443/websocket';
const TR_KEY_LEN = 18;

const toNum = (v: unknown): number => {
  const n = parseFloat(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
};

// ── 키 형식 (REST 와 WS 를 절대 섞지 않는다, req 5) ──────────────
/** REST 용 keysymbol: exchcd+symbol, 공백 패딩 없음. */
export function buildRestKeysymbol(exchcd: string, symbol: string): string {
  return `${exchcd}${symbol}`;
}
/** WS 용 tr_key: exchcd+symbol 을 총 18자리로 오른쪽 공백 패딩. */
export function buildWsTrKey(exchcd: string, symbol: string): string {
  return `${exchcd}${symbol}`.padEnd(TR_KEY_LEN, ' ');
}

/** 실시간 등록/해제 메시지. tr_type: "3"=등록, "4"=해제. */
export function buildRegisterMessage(token: string, trCd: 'GSC' | 'GSH', trKey: string, trType: '3' | '4' = '3') {
  return { header: { token, tr_type: trType }, body: { tr_cd: trCd, tr_key: trKey } };
}

// ── 파서 ────────────────────────────────────────────────────────
export interface GSCTick { symbol: string; lastPrice: number; tradeQty: number; cumulativeVolume: number; localTs: string; }
/** GSC(체결): price/trdq/totq/ovsdate+trdtm. localTs = YYYYMMDDHHMMSS(현지). */
export function parseGSC(body: any): GSCTick {
  const ovsdate = String(body?.ovsdate ?? '');
  const trdtm = String(body?.trdtm ?? '').padStart(6, '0');
  return {
    symbol: String(body?.symbol ?? ''),
    lastPrice: toNum(body?.price),
    tradeQty: toNum(body?.trdq),
    cumulativeVolume: toNum(body?.totq),
    localTs: ovsdate + trdtm,
  };
}

export interface GSHQuote { symbol: string; bestAsk: number; bestBid: number; askRem: number; bidRem: number; }
/** GSH(호가): offerho1(최우선 매도호가)/bidho1(최우선 매수호가)/offerrem1/bidrem1. */
export function parseGSH(body: any): GSHQuote {
  return {
    symbol: String(body?.symbol ?? ''),
    bestAsk: toNum(body?.offerho1),
    bestBid: toNum(body?.bidho1),
    askRem: toNum(body?.offerrem1),
    bidRem: toNum(body?.bidrem1),
  };
}

// ── 실시간 15분봉 집계 (GSC 체결 → OHLCV) ───────────────────────
export interface RTCandle { datetime: string; open: number; high: number; low: number; close: number; volume: number; }
/** localTs(YYYYMMDDHHMMSS) → 15분 버킷 시작(YYYYMMDDHHmm00). */
export function bucket15(localTs: string): string {
  const date = localTs.slice(0, 8);
  const hh = localTs.slice(8, 10);
  const mm = parseInt(localTs.slice(10, 12) || '0', 10);
  const bmm = Math.floor(mm / 15) * 15;
  return `${date}${hh}${String(bmm).padStart(2, '0')}00`;
}

export class RealtimeCandleBuilder {
  private map = new Map<string, RTCandle>();
  private latest = '';   // 최신(형성 중) 버킷 키

  /** 저장된 확정봉 + REST g3203 확정봉으로 초기 시드. datetime 키로 병합/중복제거(req 5). */
  seed(candles: RTCandle[]): void {
    for (const c of candles) {
      this.map.set(c.datetime, { ...c });     // 같은 datetime 은 덮어써 중복 제거
      if (c.datetime > this.latest) this.latest = c.datetime;
    }
  }
  /**
   * 체결 1건 반영. 버킷이 새로 바뀌면 **직전(확정된)** 봉을 반환한다(req 3 — 확정 즉시 저장용).
   * 같은 버킷 내 체결은 OHLCV 갱신만 하고 null 을 반환한다.
   */
  addTrade(price: number, qty: number, localTs: string): RTCandle | null {
    if (!(price > 0) || localTs.length < 12) return null;
    const bk = bucket15(localTs);
    let confirmed: RTCandle | null = null;
    // 더 나중 버킷의 첫 체결 → 직전 최신 버킷은 이제 확정봉
    if (this.latest && bk > this.latest && this.map.has(this.latest)) {
      confirmed = { ...this.map.get(this.latest)! };
    }
    const cur = this.map.get(bk);
    if (!cur) {
      this.map.set(bk, { datetime: bk, open: price, high: price, low: price, close: price, volume: Math.max(0, qty) });
    } else {
      cur.high = Math.max(cur.high, price);
      cur.low = Math.min(cur.low, price);
      cur.close = price;
      cur.volume += Math.max(0, qty);
    }
    if (bk > this.latest) this.latest = bk;
    return confirmed;
  }
  /** 오름차순 정렬된 봉. dropForming=true 면 마지막(형성 중) 봉 제외. */
  candles(dropForming = false): RTCandle[] {
    const arr = [...this.map.values()].sort((a, b) => a.datetime.localeCompare(b.datetime));
    return dropForming && arr.length > 1 ? arr.slice(0, -1) : arr;
  }
  /** 현재 형성 중(최신 버킷) 봉 — 정상 종료 시 저장용(req 7). */
  formingCandle(): RTCandle | null {
    return this.latest && this.map.has(this.latest) ? { ...this.map.get(this.latest)! } : null;
  }
  get size(): number { return this.map.size; }
}

// ── readiness gate (req 6) ──────────────────────────────────────
export interface ReadinessState { lastGSCatMs: number | null; lastPrice: number; candleCount: number; }
export interface Readiness { ready: boolean; stale: boolean; allowNewBuy: boolean; allowSellExisting: boolean; reasons: string[]; }
export const GSC_STALE_MS = 30_000;      // GSC 최근 수신 30초 이내
export const MIN_RT_CANDLES = 20;        // 15분봉 최소 20개

export function evaluateReadiness(s: ReadinessState, nowMs: number): Readiness {
  const reasons: string[] = [];
  const fresh = s.lastGSCatMs != null && (nowMs - s.lastGSCatMs) <= GSC_STALE_MS;
  if (!fresh) reasons.push(`GSC stale(마지막 수신 ${s.lastGSCatMs == null ? '없음' : Math.round((nowMs - s.lastGSCatMs) / 1000) + 's'})`);
  if (!(s.lastPrice > 0)) reasons.push('lastPrice<=0');
  if (s.candleCount < MIN_RT_CANDLES) reasons.push(`15분봉 부족(${s.candleCount}<${MIN_RT_CANDLES})`);
  const stale = !fresh;
  const ready = fresh && s.lastPrice > 0 && s.candleCount >= MIN_RT_CANDLES;
  return {
    ready,
    stale,
    allowNewBuy: ready && !stale,               // stale 이면 신규 매수 금지
    allowSellExisting: true,                    // 보유 매도는 허용(마지막 유효가 + stale 로그)
    reasons,
  };
}

// ── WebSocket 클라이언트 (재연결/heartbeat/자동 재등록) ──────────
export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  onclose: ((ev?: any) => void) | null;
  onerror: ((ev?: any) => void) | null;
}
export type WsFactory = (url: string) => WsLike;
export interface SymbolSub { exchcd: string; symbol: string; }
export interface ClientHooks {
  onGSC?: (t: GSCTick) => void;
  onGSH?: (q: GSHQuote) => void;
  onStatus?: (msg: string) => void;
}
export interface ClientOpts {
  url?: string;
  wsFactory?: WsFactory;
  staleTimeoutMs?: number;      // 무수신 시 재연결 (기본 45s)
  backoffMs?: number[];         // 재연결 백오프 (기본 1s,2s,4s,8s,16s)
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function defaultWsFactory(url: string): WsLike {
  const G: any = (globalThis as any).WebSocket;
  if (!G) throw new Error('전역 WebSocket 없음 — Node 21+ 필요(또는 ws 패키지). tsx 로 실행하세요.');
  return new G(url) as WsLike;
}

export class LSUSRealtimeClient {
  private ws: WsLike | null = null;
  private subs: SymbolSub[] = [];
  private closedByUser = false;
  private lastMsgAt = 0;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private readonly url: string;
  private readonly factory: WsFactory;
  private readonly staleTimeoutMs: number;
  private readonly backoff: number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private token: string, private hooks: ClientHooks = {}, opts: ClientOpts = {}) {
    this.url = opts.url ?? LS_WS_URL;
    this.factory = opts.wsFactory ?? defaultWsFactory;
    this.staleTimeoutMs = opts.staleTimeoutMs ?? 45_000;
    this.backoff = opts.backoffMs ?? [1000, 2000, 4000, 8000, 16000];
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
  }

  connect(subs: SymbolSub[]): void {
    this.subs = subs;
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    this.hooks.onStatus?.(`WS 연결 시도 ${this.url}`);
    const ws = this.factory(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.lastMsgAt = this.now();
      this.hooks.onStatus?.('WS 연결됨 → 종목 등록');
      this.registerAll();
      this.startStaleWatch();
    };
    ws.onmessage = (ev) => { this.lastMsgAt = this.now(); this.handleMessage(ev.data); };
    ws.onerror = () => { this.hooks.onStatus?.('WS 오류'); };
    ws.onclose = () => {
      this.stopStaleWatch();
      if (this.closedByUser) { this.hooks.onStatus?.('WS 종료(사용자)'); return; }
      void this.reconnect();
    };
  }

  private registerAll(): void {
    for (const s of this.subs) {
      const trKey = buildWsTrKey(s.exchcd, s.symbol);
      for (const tr of ['GSC', 'GSH'] as const) {
        this.ws?.send(JSON.stringify(buildRegisterMessage(this.token, tr, trKey)));
      }
    }
  }

  private handleMessage(data: any): void {
    let msg: any;
    try { msg = typeof data === 'string' ? JSON.parse(data) : JSON.parse(String(data)); }
    catch { return; }
    const trCd = msg?.header?.tr_cd;
    if (trCd === 'PINGPONG') { this.ws?.send(JSON.stringify(msg)); return; }   // heartbeat echo
    if (!msg?.body) return;
    if (trCd === 'GSC') this.hooks.onGSC?.(parseGSC(msg.body));
    else if (trCd === 'GSH') this.hooks.onGSH?.(parseGSH(msg.body));
  }

  private startStaleWatch(): void {
    this.stopStaleWatch();
    this.staleTimer = setInterval(() => {
      if (this.now() - this.lastMsgAt > this.staleTimeoutMs) {
        this.hooks.onStatus?.(`WS 무수신 ${Math.round(this.staleTimeoutMs / 1000)}s 초과 → 재연결`);
        try { this.ws?.close(); } catch { /* noop */ }
      }
    }, Math.max(1000, Math.floor(this.staleTimeoutMs / 3)));
  }
  private stopStaleWatch(): void { if (this.staleTimer) { clearInterval(this.staleTimer); this.staleTimer = null; } }

  private async reconnect(): Promise<void> {
    const wait = this.backoff[Math.min(this.attempt, this.backoff.length - 1)];
    this.attempt++;
    this.hooks.onStatus?.(`WS 재연결 대기 ${wait}ms (attempt ${this.attempt})`);
    await this.sleep(wait);
    if (!this.closedByUser) this.open();   // 재연결 후 registerAll 로 자동 재등록
  }

  close(): void {
    this.closedByUser = true;
    this.stopStaleWatch();
    try { this.ws?.close(); } catch { /* noop */ }
  }
}
