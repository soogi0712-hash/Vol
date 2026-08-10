import { describe, it, expect, vi } from 'vitest';
import {
  buildRestKeysymbol, buildWsTrKey, buildRegisterMessage,
  parseGSC, parseGSH, bucket15, RealtimeCandleBuilder,
  evaluateReadiness, LSUSRealtimeClient, type WsLike,
} from '../local-runner/ls-us-websocket';
import { toLSOverseasExchcd } from '../src/lib/ls-api';

describe('키 형식 분리 (REST vs WS, req5)', () => {
  it('REST keysymbol = exchcd+symbol, 공백 없음', () => {
    expect(buildRestKeysymbol('82', 'AAPL')).toBe('82AAPL');
    expect(buildRestKeysymbol('82', 'AAPL')).not.toMatch(/ /);
  });
  it('WS tr_key = 총 18자리 오른쪽 공백 패딩 (AAPL exchcd 82)', () => {
    const k = buildWsTrKey('82', 'AAPL');
    expect(k.length).toBe(18);
    expect(k).toBe('82AAPL' + ' '.repeat(12));
    expect(k.startsWith('82AAPL')).toBe(true);
  });
  it('SOXL: 공식 예제와 동일 (거래소 81) → "81SOXL"+패딩, 18자리', () => {
    // 공식 GSH reqExample: "81SOXL            "
    expect(toLSOverseasExchcd('AMEX')).toBe('81');   // 종목마스터상 SOXL(NYSE Arca)=81
    const k = buildWsTrKey('81', 'SOXL');
    expect(k).toBe('81SOXL            ');
    expect(k.length).toBe(18);
  });
  it('JSON 직렬화 후에도 tr_key trailing spaces 보존 (trKeyLength=18)', () => {
    const trKey = buildWsTrKey('82', 'AAPL');
    const msg = buildRegisterMessage('TOK', 'GSC', trKey);
    const serialized = JSON.stringify(msg);
    const parsed = JSON.parse(serialized);
    expect(parsed.body.tr_key).toBe(trKey);
    expect(parsed.body.tr_key.length).toBe(18);          // 직렬화/역직렬화 후에도 18
    expect(parsed.header.tr_type).toBe('3');
    expect(parsed.body.tr_cd).toBe('GSC');
  });
});

describe('GSC/GSH 파서 (공식 필드)', () => {
  it('GSC: price/trdq/totq/ovsdate+trdtm', () => {
    const t = parseGSC({ symbol: 'AAPL', price: '283.82', trdq: '10', totq: '414175', ovsdate: '20260805', trdtm: '093015' });
    expect(t.lastPrice).toBeCloseTo(283.82);
    expect(t.tradeQty).toBe(10);
    expect(t.cumulativeVolume).toBe(414175);
    expect(t.localTs).toBe('20260805093015');
  });
  it('GSH: offerho1/bidho1/offerrem1/bidrem1 (공식 SOXL 예제값)', () => {
    const q = parseGSH({ symbol: 'SOXL', offerho1: '12.2100', bidho1: '12.2000', offerrem1: '8418', bidrem1: '12760' });
    expect(q.bestAsk).toBeCloseTo(12.21);
    expect(q.bestBid).toBeCloseTo(12.20);
    expect(q.askRem).toBe(8418);
    expect(q.bidRem).toBe(12760);
  });
});

describe('실시간 15분봉 집계', () => {
  it('bucket15: 15분 버킷 시작', () => {
    expect(bucket15('20260805093015')).toBe('20260805093000');
    expect(bucket15('20260805094459')).toBe('20260805093000');
    expect(bucket15('20260805094500')).toBe('20260805094500');
  });
  it('체결 → OHLCV, 형성봉 제외 옵션', () => {
    const b = new RealtimeCandleBuilder();
    b.addTrade(10, 5, '20260805093001');   // 09:30 버킷
    b.addTrade(12, 3, '20260805093500');
    b.addTrade(9, 2, '20260805094000');
    b.addTrade(11, 4, '20260805094600');   // 09:45 버킷(형성 중)
    const all = b.candles();
    expect(all.map(c => c.datetime)).toEqual(['20260805093000', '20260805094500']);
    expect(all[0]).toMatchObject({ open: 10, high: 12, low: 9, close: 9, volume: 10 });
    expect(b.candles(true).map(c => c.datetime)).toEqual(['20260805093000']);  // 형성봉 제외
  });
  it('REST 시드 후 실시간 확장', () => {
    const b = new RealtimeCandleBuilder();
    b.seed([{ datetime: '20260805090000', open: 1, high: 2, low: 1, close: 2, volume: 100 }]);
    b.addTrade(3, 1, '20260805091601');   // 09:16 → 09:15 버킷(신규)
    expect(b.size).toBe(2);
    b.addTrade(4, 1, '20260805090500');   // 09:05 → 09:00 버킷(시드 갱신)
    expect(b.size).toBe(2);               // 새 버킷 아님
    expect(b.candles()[0].close).toBe(4); // 시드 버킷 close 갱신됨
  });
});

describe('readiness gate (req6, GSC/GSH 분리)', () => {
  const now = 1_000_000_000_000;
  const base = () => ({
    websocketConnected: true, lastGSCatMs: now - 5000, lastGSHatMs: now - 5000,
    lastPrice: 100, bestBid: 99, bestAsk: 101, confirmedCount: 25, storeCorrupted: false,
  });
  it('모든 조건 충족 → ready, 신규매수 허용', () => {
    const r = evaluateReadiness(base(), now);
    expect(r.ready).toBe(true); expect(r.allowNewBuy).toBe(true); expect(r.stale).toBe(false);
  });
  it('GSH 정상 + GSC 40초 경과 → stale 아님, 신규매수 유지(체결 없는 30초는 장애 아님)', () => {
    const r = evaluateReadiness({ ...base(), lastGSCatMs: now - 40_000 }, now);
    expect(r.stale).toBe(false); expect(r.gscFresh).toBe(true); expect(r.allowNewBuy).toBe(true);
  });
  it('GSC 300초 초과 → 신호계산·신규매수 중단, 보유매도는 허용', () => {
    const r = evaluateReadiness({ ...base(), lastGSCatMs: now - 301_000 }, now);
    expect(r.gscStale).toBe(true); expect(r.allowSignal).toBe(false); expect(r.allowNewBuy).toBe(false);
    expect(r.allowSellExisting).toBe(true);
  });
  it('GSH 31초 경과 → 신규매수 금지', () => {
    const r = evaluateReadiness({ ...base(), lastGSHatMs: now - 31_000 }, now);
    expect(r.gshFresh).toBe(false); expect(r.allowNewBuy).toBe(false);
  });
  it('WS 미연결 → 신규매수 금지', () => {
    const r = evaluateReadiness({ ...base(), websocketConnected: false }, now);
    expect(r.allowNewBuy).toBe(false);
    expect(r.reasons.some(x => x.includes('WS 미연결'))).toBe(true);
  });
  it('확정봉 부족 → not ready(Warm-up)', () => {
    const r = evaluateReadiness({ ...base(), confirmedCount: 5 }, now);
    expect(r.ready).toBe(false);
    expect(r.warmup).toBe(true);
    expect(r.reasons.some(x => x.includes('Warm-up'))).toBe(true);
  });
});

describe('Warm-up 모드 (확정봉<20)', () => {
  const now = 1_000_000_000_000;
  const base = () => ({
    websocketConnected: true, lastGSCatMs: now - 5000, lastGSHatMs: now - 5000,
    lastPrice: 100, bestBid: 99, bestAsk: 101, storeCorrupted: false,
  });
  it('확정봉 8 → warmup=true, remaining=12, READY=false', () => {
    const r = evaluateReadiness({ ...base(), confirmedCount: 8 }, now);
    expect(r.warmup).toBe(true);
    expect(r.warmupRemaining).toBe(12);
    expect(r.ready).toBe(false);
  });
  it('확정봉 19 → remaining=1', () => {
    expect(evaluateReadiness({ ...base(), confirmedCount: 19 }, now).warmupRemaining).toBe(1);
  });
  it('확정봉 20 되는 순간 → warmup=false, remaining=0, READY=true 자동 전환', () => {
    const r = evaluateReadiness({ ...base(), confirmedCount: 20 }, now);
    expect(r.warmup).toBe(false);
    expect(r.warmupRemaining).toBe(0);
    expect(r.ready).toBe(true);
  });
  it('확정봉 25 → warmup=false, remaining=0', () => {
    const r = evaluateReadiness({ ...base(), confirmedCount: 25 }, now);
    expect(r.warmup).toBe(false);
    expect(r.warmupRemaining).toBe(0);
  });
  it('remaining 은 실제 확정봉 수만 반영(가짜로 채우지 않음)', () => {
    expect(evaluateReadiness({ ...base(), confirmedCount: 0 }, now).warmupRemaining).toBe(20);
    expect(evaluateReadiness({ ...base(), confirmedCount: 13 }, now).warmupRemaining).toBe(7);
  });
});

describe('LSUSRealtimeClient (fake socket)', () => {
  function fakeWs() {
    const ws: any = { sent: [] as string[], send(d: string) { ws.sent.push(d); }, close() { ws.onclose?.(); }, onopen: null, onmessage: null, onclose: null, onerror: null };
    return ws as WsLike & { sent: string[] };
  }
  it('연결 시 종목마다 GSC·GSH 등록(tr_type=3, tr_key 18자리)', () => {
    const ws = fakeWs();
    const client = new LSUSRealtimeClient('TOK', {}, { wsFactory: () => ws });
    client.connect([{ exchcd: '82', symbol: 'AAPL' }]);
    ws.onopen?.();
    expect(ws.sent).toHaveLength(2);   // GSC + GSH (계좌이벤트 옵션 off)
    const regs = ws.sent.map((s) => JSON.parse(s));
    expect(regs.map(r => r.body.tr_cd).sort()).toEqual(['GSC', 'GSH']);
    for (const r of regs) {
      expect(r.header.tr_type).toBe('3');
      expect(r.body.tr_key.length).toBe(18);
      expect(r.body.tr_key.startsWith('82AAPL')).toBe(true);
    }
  });
  it('accountEvents=true, deferAccountEvents=false → GSC/GSH(tr_type=3) + AS0~AS4(tr_type=1, tr_key="") 즉시 등록', () => {
    const ws = fakeWs();
    const client = new LSUSRealtimeClient('TOK', {}, { wsFactory: () => ws, accountEvents: true, deferAccountEvents: false });
    client.connect([{ exchcd: '82', symbol: 'AAPL' }]);
    ws.onopen?.();
    const regs = ws.sent.map((s) => JSON.parse(s));
    const acct = regs.filter(r => r.header.tr_type === '1');
    expect(acct.map(r => r.body.tr_cd).sort()).toEqual(['AS0', 'AS1', 'AS2', 'AS3', 'AS4']);
    for (const r of acct) { expect(r.body.tr_key).toBe(''); expect(r.header.tr_type).toBe('1'); }
    // 시세는 여전히 tr_type=3
    expect(regs.filter(r => r.header.tr_type === '3').map(r => r.body.tr_cd).sort()).toEqual(['GSC', 'GSH']);
  });
  it('AS 이벤트 라우팅 + 등록응답(ack) 콜백', () => {
    const ws = fakeWs();
    const events: any[] = []; const acks: any[] = [];
    const client = new LSUSRealtimeClient('TOK', { onAccountEvent: (tr, b) => events.push({ tr, b }), onRegisterAck: (tr, c, m) => acks.push({ tr, c, m }) }, { wsFactory: () => ws, accountEvents: true, deferAccountEvents: false });
    client.connect([{ exchcd: '82', symbol: 'AAPL' }]);
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify({ header: { tr_cd: 'AS0', rsp_cd: '0', rsp_msg: '정상등록' }, body: null }) });   // 등록 ack
    ws.onmessage?.({ data: JSON.stringify({ header: { tr_cd: 'AS1' }, body: { sOrdNo: '141', sExecQty: '1', sUnercQty: '0' } }) });   // 체결 데이터
    expect(acks[0]).toMatchObject({ tr: 'AS0', c: '0' });
    expect(events[0]).toMatchObject({ tr: 'AS1' });
    expect(events[0].b.sOrdNo).toBe('141');
  });
  it('등록응답 tr_cd 가 빈 문자열이어도 FIFO 로 AS0~AS4 귀속(P0-12)', () => {
    const ws = fakeWs();
    const acks: Array<{ tr: string }> = [];
    const client = new LSUSRealtimeClient('TOK', { onRegisterAck: (tr) => acks.push({ tr }) }, { wsFactory: () => ws, accountEvents: true, deferAccountEvents: false });
    client.connect([{ exchcd: '82', symbol: 'AAPL' }]);
    ws.onopen?.();   // 전송 순서: GSC, GSH, AS0, AS1, AS2, AS3, AS4
    // 등록응답 7건 모두 tr_cd 빈 문자열 → FIFO 로 순서대로 귀속
    for (let i = 0; i < 7; i++) ws.onmessage?.({ data: JSON.stringify({ header: { tr_cd: '', rsp_cd: '0', rsp_msg: '정상 처리 되었습니다.' } }) });
    // GSC/GSH 는 onRegisterAck 대상 아님. AS0~AS4 5건만 콜백.
    expect(acks.map(a => a.tr)).toEqual(['AS0', 'AS1', 'AS2', 'AS3', 'AS4']);
  });
  it('재연결 시 GSC/GSH + AS0~AS4 모두 자동 재등록', async () => {
    const sockets: any[] = [];
    const client = new LSUSRealtimeClient('TOK', {}, { wsFactory: () => { const w = fakeWs(); sockets.push(w); return w; }, accountEvents: true, deferAccountEvents: false, backoffMs: [1], sleep: async () => {} });
    client.connect([{ exchcd: '82', symbol: 'AAPL' }]);
    sockets[0].onopen?.();
    expect(sockets[0].sent).toHaveLength(7);   // GSC+GSH+AS0~4
    sockets[0].onclose?.();
    await new Promise(r => setTimeout(r, 5));
    sockets[1].onopen?.();
    expect(sockets[1].sent).toHaveLength(7);   // 재등록
    client.close();
  });
  it('GSC/GSH 메시지 라우팅 + PINGPONG 에코', () => {
    const ws = fakeWs();
    const ticks: any[] = []; const quotes: any[] = [];
    const client = new LSUSRealtimeClient('TOK', { onGSC: t => ticks.push(t), onGSH: q => quotes.push(q) }, { wsFactory: () => ws });
    client.connect([{ exchcd: '82', symbol: 'AAPL' }]);
    ws.onopen?.();
    ws.sent.length = 0;
    ws.onmessage?.({ data: JSON.stringify({ header: { tr_cd: 'GSC' }, body: { symbol: 'AAPL', price: '283.82', trdq: '10', totq: '1', ovsdate: '20260805', trdtm: '093015' } }) });
    ws.onmessage?.({ data: JSON.stringify({ header: { tr_cd: 'GSH' }, body: { symbol: 'AAPL', offerho1: '284', bidho1: '283', offerrem1: '5', bidrem1: '7' } }) });
    ws.onmessage?.({ data: JSON.stringify({ header: { tr_cd: 'PINGPONG' }, body: {} }) });
    expect(ticks[0].lastPrice).toBeCloseTo(283.82);
    expect(quotes[0].bestAsk).toBe(284);
    expect(ws.sent).toHaveLength(1);   // PINGPONG 에코 1건
    expect(JSON.parse(ws.sent[0]).header.tr_cd).toBe('PINGPONG');
  });
  it('예기치 않은 종료 시 백오프 재연결 후 자동 재등록', async () => {
    const sockets: any[] = [];
    const factory = () => { const w = fakeWs(); sockets.push(w); return w; };
    const client = new LSUSRealtimeClient('TOK', {}, { wsFactory: factory, backoffMs: [1], sleep: async () => {} });
    client.connect([{ exchcd: '81', symbol: 'SOXL' }]);
    sockets[0].onopen?.();
    expect(sockets[0].sent).toHaveLength(2);
    sockets[0].onclose?.();               // 비정상 종료 → 재연결
    await new Promise(r => setTimeout(r, 5));
    expect(sockets.length).toBe(2);       // 새 소켓 생성
    sockets[1].onopen?.();
    expect(sockets[1].sent).toHaveLength(2);   // 재등록됨
    client.close();
  });

  // ── P0-21 WebSocket 장애 진단/복구 ──
  function fakeWs2() {
    const ws: any = { sent: [] as string[], send(d: string) { ws.sent.push(d); }, close(ev?: any) { ws.onclose?.(ev); }, onopen: null, onmessage: null, onclose: null, onerror: null };
    return ws as WsLike & { sent: string[] };
  }
  it('P0-21 #1: onclose 시 code/reason/wasClean/lastRegister/connectedDurationMs 캡처', () => {
    let closeInfo: any = null; let now = 1000;
    const ws = fakeWs2();
    const client = new LSUSRealtimeClient('TOK', { onClose: (i) => { closeInfo = i; } },
      { wsFactory: () => ws, backoffMs: [1], sleep: async () => {}, now: () => now });
    client.connect([{ exchcd: '82', symbol: 'AAPL' }]);
    ws.onopen?.();
    now = 1500;   // 500ms 유지
    ws.onclose?.({ code: 1006, reason: 'abnormal', wasClean: false });
    expect(closeInfo).toMatchObject({ code: 1006, reason: 'abnormal', wasClean: false, connectedDurationMs: 500, dataReceived: false });
    expect(closeInfo.lastRegister).toContain('GSC/GSH');
    client.close();
  });
  it('P0-21 #1: onerror 시 실제 error 메시지 전달', () => {
    let err: any = null;
    const ws = fakeWs2();
    const client = new LSUSRealtimeClient('TOK', { onError: (i) => { err = i; } }, { wsFactory: () => ws });
    client.connect([{ exchcd: '82', symbol: 'AAPL' }]);
    ws.onopen?.();
    ws.onerror?.({ message: 'ECONNRESET' });
    expect(err).toEqual({ message: 'ECONNRESET' });
    client.close();
  });
  it('P0-21 #2: socket open 만으로 dataReady=false, 첫 GSC/GSH 수신 시 true + onDataReady', () => {
    let dataReadyFired = 0;
    const ws = fakeWs2();
    const client = new LSUSRealtimeClient('TOK', { onDataReady: () => dataReadyFired++ }, { wsFactory: () => ws });
    client.connect([{ exchcd: '82', symbol: 'AAPL' }]);
    ws.onopen?.();
    expect(client.connected).toBe(true);
    expect(client.dataReady).toBe(false);   // open 만으로는 false
    ws.onmessage?.({ data: JSON.stringify({ header: { tr_cd: 'GSH' }, body: { symbol: 'AAPL', offerho1: '284', bidho1: '283' } }) });
    expect(client.dataReady).toBe(true);
    expect(dataReadyFired).toBe(1);
    client.close();
  });
  it('P0-21 #3: deferAccountEvents=true(기본) → open 시 GSC/GSH 만, 첫 데이터 후 AS 등록', () => {
    const ws = fakeWs2();
    const client = new LSUSRealtimeClient('TOK', {}, { wsFactory: () => ws, accountEvents: true });
    client.connect([{ exchcd: '82', symbol: 'AAPL' }]);
    ws.onopen?.();
    expect(ws.sent).toHaveLength(2);   // GSC/GSH 만(AS 지연)
    ws.onmessage?.({ data: JSON.stringify({ header: { tr_cd: 'GSC' }, body: { symbol: 'AAPL', price: '283', trdq: '1', totq: '1', ovsdate: '20260805', trdtm: '093015' } }) });
    const trs = ws.sent.map(s => JSON.parse(s).body.tr_cd);
    expect(trs).toEqual(['GSC', 'GSH', 'AS0', 'AS1', 'AS2', 'AS3', 'AS4']);   // 데이터 후 AS 등록
    client.close();
  });
  it('P0-21 #5: open 직후 데이터없이 close 반복 → attempt 리셋 안 됨, exponential backoff', async () => {
    const sockets: any[] = []; const waits: number[] = [];
    const client = new LSUSRealtimeClient('TOK', {}, {
      wsFactory: () => { const w = fakeWs2(); sockets.push(w); return w; },
      backoffMs: [1000, 2000, 4000, 8000, 16000, 30000],
      sleep: async (ms) => { waits.push(ms); },   // 실제 대기 없이 backoff 값만 수집
    });
    client.connect([{ exchcd: '82', symbol: 'AAPL' }]);
    // open → 데이터 없이 close 를 4회: attempt 가 매번 리셋되지 않고 증가해야 함
    for (let i = 0; i < 4; i++) { sockets[i].onopen?.(); sockets[i].onclose?.({ code: 1006 }); await Promise.resolve(); await Promise.resolve(); }
    expect(waits.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);   // ★ 1초 고정 storm 아님
    client.close();
  });
  it('P0-21 #4: 재연결 시 이전 소켓 리스너 제거(중복 연결 방지) — 죽은 소켓 onclose 는 재연결 유발 안 함', async () => {
    const sockets: any[] = [];
    const client = new LSUSRealtimeClient('TOK', {}, { wsFactory: () => { const w = fakeWs2(); sockets.push(w); return w; }, backoffMs: [1], sleep: async () => {} });
    client.connect([{ exchcd: '82', symbol: 'AAPL' }]);
    sockets[0].onopen?.();
    sockets[0].onclose?.({ code: 1006 });         // 재연결 트리거
    await new Promise(r => setTimeout(r, 5));
    expect(sockets.length).toBe(2);               // 소켓 1개만 새로 생성
    // 이전(죽은) 소켓의 onclose 는 cleanup 으로 detach 되어 추가 재연결 없음
    expect(sockets[0].onclose).toBeNull();
    client.close();
  });
  it('P0-21 #5: 데이터 수신하며 stableMs 유지되면 attempt 리셋', async () => {
    let now = 0; const statuses: string[] = [];
    const ws = fakeWs2();
    const client = new LSUSRealtimeClient('TOK', { onStatus: (m) => statuses.push(m) },
      { wsFactory: () => ws, backoffMs: [1], sleep: async () => {}, stableMs: 50, now: () => now });
    client.connect([{ exchcd: '82', symbol: 'AAPL' }]);
    // 먼저 한 번 끊겨 attempt 증가
    ws.onopen?.(); ws.onclose?.({ code: 1006 }); await new Promise(r => setTimeout(r, 5));
    expect(client.attemptCount).toBeGreaterThan(0);
    // 재연결 후 데이터 수신 + stableMs 경과
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify({ header: { tr_cd: 'GSH' }, body: { symbol: 'AAPL', offerho1: '1', bidho1: '1' } }) });
    now = 100;
    await new Promise(r => setTimeout(r, 70));   // stableTimer(50ms) 발화
    expect(client.attemptCount).toBe(0);          // ★ 안정 후 리셋
    client.close();
  });
});
