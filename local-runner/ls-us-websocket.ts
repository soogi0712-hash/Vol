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

/**
 * 등록/해제 메시지. tr_type: "1"=계좌등록, "2"=계좌해제, "3"=실시간 시세등록, "4"=시세해제.
 * GSC/GSH 는 "3"(시세), AS0~AS4 는 "1"(계좌) 로 등록한다.
 */
export function buildRegisterMessage(token: string, trCd: string, trKey: string, trType: '1' | '2' | '3' | '4' = '3') {
  return { header: { token, tr_type: trType }, body: { tr_cd: trCd, tr_key: trKey } };
}

// 계좌 주문이벤트 TR (공식): AS0 접수 / AS1 체결 / AS2 정정 / AS3 취소 / AS4 거부.
export const LS_ACCOUNT_EVENT_TRS = ['AS0', 'AS1', 'AS2', 'AS3', 'AS4'] as const;

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

/**
 * GSC 체결 → 15분 OHLCV 집계기.
 * ⚠️ 확정봉(종료된 봉)과 형성봉(현재 열려 있는 봉)을 **명시적으로 분리**한다(req 1).
 *   - confirmed: 버킷 전환이 실제 확인된 뒤에만 승격된, 종료된 봉만.
 *   - forming:   현재 형성 중인 최신 버킷 1개(별도 상태). confirmed 개수/신호 계산에서 제외.
 *   버킷 전환 전(첫 GSC ~ 15분 경과 전)에는 confirmedCount 가 0 이어야 한다.
 */
/**
 * 과거 틱(g3202)을 15분 OHLCV 확정봉으로 재집계한다(fallback).
 *   - date+loctime(미국 현지=America/New_York 벽시계)로 15분 버킷팅(서머타임 자동).
 *   - open=버킷 첫 틱 open, high=max, low=min, close=마지막 틱 close, volume=exevol 합.
 *   - 거래 없는 구간은 임의 봉으로 채우지 않는다(버킷은 틱이 있을 때만 생성).
 *   - 최신(형성 중) 버킷 1개는 제외한다. 틱은 같은 시각 중복이 정상이라 timestamp dedup 하지 않는다.
 */
export function aggregateTicksTo15Min(ticks: RTCandle[]): RTCandle[] {
  const map = new Map<string, RTCandle>();
  const sorted = [...ticks].sort((a, b) => a.datetime.localeCompare(b.datetime));   // 시간순
  for (const t of sorted) {
    if (!(t.close > 0) || t.datetime.length < 12) continue;
    const bk = bucket15(t.datetime);
    const hi = t.high > 0 ? t.high : t.close;
    const lo = t.low > 0 ? t.low : t.close;
    const op = t.open > 0 ? t.open : t.close;
    const cur = map.get(bk);
    if (!cur) {
      map.set(bk, { datetime: bk, open: op, high: hi, low: lo, close: t.close, volume: Math.max(0, t.volume) });
    } else {
      cur.high = Math.max(cur.high, hi);
      cur.low = Math.min(cur.low, lo);
      cur.close = t.close;
      cur.volume += Math.max(0, t.volume);
    }
  }
  const arr = [...map.values()].sort((a, b) => a.datetime.localeCompare(b.datetime));
  return arr.slice(0, -1);   // 최신(형성 중) 버킷은 항상 제외(1개뿐이면 확정봉 0)
}

export class RealtimeCandleBuilder {
  private confirmed = new Map<string, RTCandle>();   // 종료된 봉만
  private forming: RTCandle | null = null;           // 현재 형성 중 봉(별도 상태)

  private static make(bk: string, price: number, qty: number): RTCandle {
    return { datetime: bk, open: price, high: price, low: price, close: price, volume: Math.max(0, qty) };
  }
  private static apply(c: RTCandle, price: number, qty: number): void {
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.close = price;
    c.volume += Math.max(0, qty);
  }

  /** 저장된 **확정봉**으로만 시드(형성봉은 절대 여기 넣지 않는다, req 2). datetime 키로 중복제거(req 5). */
  seed(candles: RTCandle[]): void {
    for (const c of candles) this.confirmed.set(c.datetime, { ...c });
  }

  /**
   * 체결 1건 반영. 버킷이 새로 바뀌면 직전 forming 을 **확정 승격**해 반환한다(req 3 — 확정 즉시 저장용).
   * 같은 버킷 내 체결은 forming OHLCV 갱신만 하고 null 을 반환한다.
   */
  addTrade(price: number, qty: number, localTs: string): RTCandle | null {
    if (!(price > 0) || localTs.length < 12) return null;
    const bk = bucket15(localTs);

    if (this.forming) {
      if (bk === this.forming.datetime) { RealtimeCandleBuilder.apply(this.forming, price, qty); return null; }
      if (bk > this.forming.datetime) {
        // 버킷 전환이 확인됨 → 직전 forming 을 confirmed 로 승격, 새 forming 시작
        const justConfirmed = { ...this.forming };
        this.confirmed.set(justConfirmed.datetime, justConfirmed);
        this.forming = RealtimeCandleBuilder.make(bk, price, qty);
        return { ...justConfirmed };
      }
      // bk < forming.datetime : 이미 지난 버킷의 지연 체결 → 해당 확정봉만 갱신(있으면)
      const past = this.confirmed.get(bk);
      if (past) RealtimeCandleBuilder.apply(past, price, qty);
      return null;
    }

    // 아직 forming 없음(시작 직후 첫 체결)
    const seeded = this.confirmed.get(bk);
    if (seeded) { RealtimeCandleBuilder.apply(seeded, price, qty); return null; }   // 시드된 버킷 갱신
    this.forming = RealtimeCandleBuilder.make(bk, price, qty);   // 첫 형성봉 — confirmed 는 여전히 0
    return null;
  }

  /** 종료된 확정봉만, 오름차순. **형성봉 제외**(BB/RSI/신호 입력용, req 9). */
  confirmedCandles(): RTCandle[] {
    return [...this.confirmed.values()].sort((a, b) => a.datetime.localeCompare(b.datetime));
  }
  get confirmedCount(): number { return this.confirmed.size; }

  /** 현재 형성 중 봉(별도 상태). 정상 종료 시 confirmed:false 로 저장(req 7). */
  formingCandle(): RTCandle | null { return this.forming ? { ...this.forming } : null; }
  get hasForming(): boolean { return this.forming != null; }

  /** 전체(확정 + 형성) 오름차순. dropForming=true 면 확정봉만. (호환용) */
  candles(dropForming = false): RTCandle[] {
    const arr = this.confirmedCandles();
    if (!dropForming && this.forming) arr.push({ ...this.forming });
    return arr.sort((a, b) => a.datetime.localeCompare(b.datetime));
  }
  get size(): number { return this.confirmed.size + (this.forming ? 1 : 0); }
}

// ── readiness gate (req 6, 개선) ────────────────────────────────
// GSC(체결)와 GSH(호가) 의 신선도 기준을 분리한다.
//   - GSH(호가)는 장중 계속 흐르므로 30초 기준.
//   - GSC(체결)는 종목별 체결 간격이 길 수 있으므로 300초 기준(체결 없는 30초는 장애가 아님).
export const GSH_FRESH_MS = 30_000;       // 호가 최근 수신 30초 이내
export const GSC_FRESH_MS = 300_000;      // 체결 최근 수신 300초 이내
export const MIN_RT_CANDLES = 20;         // 확정 15분봉 최소 20개

export interface ReadinessState {
  websocketConnected: boolean;
  lastGSCatMs: number | null;
  lastGSHatMs: number | null;
  lastPrice: number;
  bestBid: number;
  bestAsk: number;
  confirmedCount: number;     // 형성봉 제외 확정봉 개수
  storeCorrupted: boolean;
}
export interface Readiness {
  ready: boolean;             // = allowNewBuy
  allowNewBuy: boolean;
  allowSignal: boolean;       // BB/RSI/신호 계산 허용 (GSC 신선 + 확정봉 충분)
  allowSellExisting: boolean; // 보유 매도(별도 안전정책) — 항상 허용
  stale: boolean;             // GSC 또는 GSH 신선도 문제
  gscFresh: boolean;
  gshFresh: boolean;
  gscStale: boolean;          // GSC 300초 초과 → 신호/신규매수 중단
  gscAgeSec: number | null;
  gshAgeSec: number | null;
  warmup: boolean;            // 확정봉<20 (BB/RSI/Signal 은 계속 계산, 신규매수만 대기)
  warmupRemaining: number;    // READY 까지 남은 확정봉 수(가짜로 채우지 않음)
  reasons: string[];
}

const ageSec = (ageMs: number | null) => (ageMs == null ? '없음' : Math.round(ageMs / 1000) + 's');

export function evaluateReadiness(s: ReadinessState, nowMs: number): Readiness {
  const gscAgeMs = s.lastGSCatMs == null ? null : nowMs - s.lastGSCatMs;
  const gshAgeMs = s.lastGSHatMs == null ? null : nowMs - s.lastGSHatMs;
  const gscFresh = gscAgeMs != null && gscAgeMs <= GSC_FRESH_MS;
  const gshFresh = gshAgeMs != null && gshAgeMs <= GSH_FRESH_MS;
  const enough = s.confirmedCount >= MIN_RT_CANDLES;
  const warmup = !enough;                                        // 확정봉<20 → Warm-up
  const warmupRemaining = Math.max(0, MIN_RT_CANDLES - s.confirmedCount);   // 남은 개수(가짜 없음)

  const reasons: string[] = [];
  if (!s.websocketConnected) reasons.push('WS 미연결');
  if (!(s.bestBid > 0)) reasons.push('bestBid<=0');
  if (!(s.bestAsk > 0)) reasons.push('bestAsk<=0');
  if (!gshFresh) reasons.push(`GSH stale(${ageSec(gshAgeMs)})`);
  if (!(s.lastPrice > 0)) reasons.push('lastPrice<=0');
  if (!gscFresh) reasons.push(`GSC stale(${ageSec(gscAgeMs)})`);
  if (!enough) reasons.push(`Warm-up(확정봉 ${s.confirmedCount}/${MIN_RT_CANDLES}, remaining=${warmupRemaining})`);
  if (s.storeCorrupted) reasons.push('저장손상→신규매수 차단');

  // 신규매수: WS연결 + 양방향 호가>0 + GSH 30초 + lastPrice>0 + GSC 300초 + 확정봉≥20 + 저장정상
  const allowNewBuy = s.websocketConnected && s.bestBid > 0 && s.bestAsk > 0 && gshFresh
    && s.lastPrice > 0 && gscFresh && enough && !s.storeCorrupted;
  // 신호 계산: GSC 신선 + 확정봉 충분 (GSC 300초 초과 시 신호 계산 중단)
  const allowSignal = gscFresh && enough;

  return {
    ready: allowNewBuy,
    allowNewBuy,
    allowSignal,
    allowSellExisting: true,          // 보유 매도는 별도 안전정책으로 유지
    stale: !gscFresh || !gshFresh,
    gscFresh,
    gshFresh,
    gscStale: gscAgeMs != null && gscAgeMs > GSC_FRESH_MS,
    gscAgeSec: gscAgeMs == null ? null : Math.round(gscAgeMs / 1000),
    gshAgeSec: gshAgeMs == null ? null : Math.round(gshAgeMs / 1000),
    warmup,
    warmupRemaining,
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
  onAccountEvent?: (trCd: string, body: any) => void;         // AS0~AS4 주문 이벤트 원문 body
  onRegisterAck?: (trCd: string, rspCd: string, rspMsg: string) => void;   // 등록 성공/실패 응답
  onStatus?: (msg: string) => void;
}
export interface ClientOpts {
  url?: string;
  wsFactory?: WsFactory;
  staleTimeoutMs?: number;      // 무수신 시 재연결 (기본 45s)
  backoffMs?: number[];         // 재연결 백오프 (기본 1s,2s,4s,8s,16s)
  accountEvents?: boolean;      // AS0~AS4 계좌이벤트 등록(tr_type=1). 기본 false.
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
  private isConnected = false;   // onopen~onclose 사이 true (readiness 의 websocketConnected)
  private regQueue: string[] = [];   // 등록 전송 순서(등록응답 FIFO 귀속 — 실계정 tr_cd 빈 문자열 대응)
  private lastMsgAt = 0;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private readonly url: string;
  private readonly factory: WsFactory;
  private readonly staleTimeoutMs: number;
  private readonly backoff: number[];
  private readonly accountEvents: boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private token: string, private hooks: ClientHooks = {}, opts: ClientOpts = {}) {
    this.url = opts.url ?? LS_WS_URL;
    this.factory = opts.wsFactory ?? defaultWsFactory;
    this.staleTimeoutMs = opts.staleTimeoutMs ?? 45_000;
    this.backoff = opts.backoffMs ?? [1000, 2000, 4000, 8000, 16000];
    this.accountEvents = opts.accountEvents ?? false;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
  }

  /** 현재 WS 연결 상태(readiness.websocketConnected 입력용). */
  get connected(): boolean { return this.isConnected; }

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
      this.isConnected = true;
      this.lastMsgAt = this.now();
      this.hooks.onStatus?.('WS 연결됨 → 종목 등록');
      this.registerAll();
      this.startStaleWatch();
    };
    ws.onmessage = (ev) => { this.lastMsgAt = this.now(); this.handleMessage(ev.data); };
    ws.onerror = () => { this.hooks.onStatus?.('WS 오류'); };
    ws.onclose = () => {
      this.isConnected = false;
      this.stopStaleWatch();
      if (this.closedByUser) { this.hooks.onStatus?.('WS 종료(사용자)'); return; }
      void this.reconnect();
    };
  }

  private registerAll(): void {
    this.regQueue = [];   // 재연결 시 초기화 — 등록응답(ack) FIFO 귀속용
    // 시세(GSC/GSH) 등록 — tr_type="3", 종목별 tr_key(18자리 패딩)
    for (const s of this.subs) {
      const trKey = buildWsTrKey(s.exchcd, s.symbol);
      for (const tr of ['GSC', 'GSH'] as const) {
        this.ws?.send(JSON.stringify(buildRegisterMessage(this.token, tr, trKey, '3')));
        this.regQueue.push(tr);
      }
    }
    // 계좌 주문이벤트(AS0~AS4) 등록 — tr_type="1", tr_key="" (재연결 시에도 자동 재등록)
    if (this.accountEvents) {
      for (const tr of LS_ACCOUNT_EVENT_TRS) {
        this.ws?.send(JSON.stringify(buildRegisterMessage(this.token, tr, '', '1')));
        this.regQueue.push(tr);
      }
      this.hooks.onStatus?.(`계좌이벤트 등록요청 전송(tr_type=1): ${LS_ACCOUNT_EVENT_TRS.join(', ')}`);
    }
  }

  private handleMessage(data: any): void {
    let msg: any;
    try { msg = typeof data === 'string' ? JSON.parse(data) : JSON.parse(String(data)); }
    catch { return; }
    const trCd = String(msg?.header?.tr_cd ?? '');
    if (trCd === 'PINGPONG') { this.ws?.send(JSON.stringify(msg)); return; }   // heartbeat echo
    // 등록 성공/실패 응답(헤더에 rsp_cd/rsp_msg) — 데이터가 아닌 ack.
    // ⚠️ 실계정 등록응답은 header.tr_cd 가 빈 문자열인 경우가 있어, 등록 전송 순서(FIFO)로 TR 을 귀속한다.
    if (msg?.header?.rsp_cd !== undefined || msg?.header?.rsp_msg !== undefined) {
      const rspCd = String(msg.header.rsp_cd ?? ''); const rspMsg = String(msg.header.rsp_msg ?? '');
      const shifted = this.regQueue.shift();   // 전송 순서대로 1:1 귀속(등록 1건당 응답 1건 가정)
      const ackTr = trCd || String(msg?.body?.tr_cd ?? '') || shifted || '?';
      this.hooks.onStatus?.(`등록응답 tr_cd=${ackTr} rsp_cd=${rspCd} rsp_msg=${rspMsg}`);
      if ((LS_ACCOUNT_EVENT_TRS as readonly string[]).includes(ackTr)) this.hooks.onRegisterAck?.(ackTr, rspCd, rspMsg);
      return;
    }
    if (!msg?.body) return;
    if (trCd === 'GSC') this.hooks.onGSC?.(parseGSC(msg.body));
    else if (trCd === 'GSH') this.hooks.onGSH?.(parseGSH(msg.body));
    else if ((LS_ACCOUNT_EVENT_TRS as readonly string[]).includes(trCd)) this.hooks.onAccountEvent?.(trCd, msg.body);   // AS0~AS4
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
    this.isConnected = false;
    this.stopStaleWatch();
    try { this.ws?.close(); } catch { /* noop */ }
  }
}
