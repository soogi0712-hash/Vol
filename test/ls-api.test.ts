import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getLSAccessToken, getLSKRBalance, getLSUSBalance,
  getLSKRPrice, getLSUSPrice, getLSKR15Min, getLSUS15Min, getLSUS15MinPaged,
  getLSUSTicks, getLSUSTicksPaged, lsOverseasChartRaw,
  placeLSUSBuyOrder, queryLSUSOrderExec, classifyOrderExec, getLSUSDeposit, getLSUSHoldings, cancelLSUSOrder, LS_CANCEL_TR_CONFIRMED, isUSOrderSuccess,
  decideUSCashPayment, usCashOnlyUsdCap, usOrderableQty, formatCashOrderableLine,
  evaluateCrossWon, formatCrossWonCheck, formatCrossWonLiveCand, formatUSLiveGate, maskLSResponse, CROSS_WON_ADOPTED_FIELD, LS_US_CROSS_WON_TR_CONFIRMED, type LSUSDeposit,
  placeLSKRBuyOrder, queryLSKROrderExec, cancelLSKRBuyOrder, krIsuNo, isKROrderSuccess, getLSKRStockMaster,
  getLSUSStockMasterPage,
  toLSOverseasExchcd, LSApiError, configureLSRateLimiter, classifyChart,
  LS_G3203_MAX_QRYCNT_UNCOMPRESSED,
} from '../src/lib/ls-api';

// global fetch 스텁 — LS 엔드포인트별 응답 제어 (status/statusText/headers/text/json)
let calls: Array<{ url: string; init: any }>;
function stubFetch(handler: (url: string, init: any) => { status?: number; statusText?: string; headers?: Record<string, string>; json?: any; text?: string }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    const r = handler(url, init);
    const status = r.status ?? 200;
    const hmap = new Map(Object.entries(r.headers ?? { 'content-type': 'application/json; charset=UTF-8' }).map(([k, v]) => [k.toLowerCase(), v]));
    const text = r.text !== undefined ? r.text : (r.json !== undefined ? JSON.stringify(r.json) : '');
    return {
      ok: status < 400,
      status,
      statusText: r.statusText ?? (status < 400 ? 'OK' : 'ERR'),
      headers: { get: (k: string) => hmap.get(k.toLowerCase()) ?? null },
      json: async () => r.json,
      text: async () => text,
    } as any;
  }));
}
// 테스트 무지연화 — 공용 limiter 의 최소간격/재시도 대기를 즉시 처리
let sleeps: number[] = [];
beforeEach(() => {
  calls = [];
  sleeps = [];
  configureLSRateLimiter({ minIntervalMs: 0, backoffMs: [1500, 3000], maxRetries: 2, sleep: async (ms) => { sleeps.push(ms); } });
});
afterEach(() => { vi.unstubAllGlobals(); });

const cfg = { appKey: 'APPKEY', appSecret: 'APPSECRET' };

describe('getLSAccessToken', () => {
  it('form-urlencoded 로 appsecretkey·scope=oob·client_credentials 전송, access_token 파싱', async () => {
    stubFetch((url) => {
      expect(url).toBe('https://openapi.ls-sec.co.kr:8080/oauth2/token');
      return { json: { access_token: 'TOK123', token_type: 'Bearer', expires_in: 3600, scope: 'oob' } };
    });
    const tok = await getLSAccessToken(cfg);   // kv 없음 → mem 캐시
    expect(tok).toBe('TOK123');
    const { init } = calls[0];
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toContain('grant_type=client_credentials');
    expect(init.body).toContain('appsecretkey=APPSECRET');
    expect(init.body).toContain('appkey=APPKEY');
    expect(init.body).toContain('scope=oob');
  });
});

describe('getLSKRBalance (CSPAQ12200)', () => {
  it('rsp_cd=00000 정상 + OutBlock2 금액 파싱', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('https://openapi.ls-sec.co.kr:8080/stock/accno');
      expect(init.headers['tr_cd']).toBe('CSPAQ12200');
      expect(init.headers['authorization']).toBe('Bearer T');
      expect(JSON.parse(init.body)).toEqual({ CSPAQ12200InBlock1: { BalCreTp: '1' } });
      return { json: {
        rsp_cd: '00000', rsp_msg: '정상',
        CSPAQ12200OutBlock1: { AcntNo: '55512345678' },
        CSPAQ12200OutBlock2: { MnyOrdAbleAmt: '1000000', DpsastTotamt: '1234567', BalEvalAmt: '234567', Dps: '1000000' },
      } };
    });
    const b = await getLSKRBalance(cfg, 'T');
    expect(b.orderableCash).toBe(1000000);
    expect(b.totalEval).toBe(1234567);
    expect(b.balEval).toBe(234567);
    expect(b.deposit).toBe(1000000);
    expect(b.accountNo).toBe('55512345678');
    expect(b.rspCd).toBe('00000');
    expect(b.raw.OutBlock2.MnyOrdAbleAmt).toBe('1000000');   // 진단용 원문 노출
  });

  it('rsp_cd=00136 "조회가 완료되었습니다"도 성공 처리 + 금액 파싱', async () => {
    stubFetch(() => ({ json: {
      rsp_cd: '00136', rsp_msg: '조회가 완료되었습니다.',
      CSPAQ12200OutBlock1: { AcntNo: '55512345678' },
      CSPAQ12200OutBlock2: { MnyOrdAbleAmt: '1000000', DpsastTotamt: '1000000', BalEvalAmt: '0', Dps: '1000000' },
    } }));
    const b = await getLSKRBalance(cfg, 'T');
    expect(b.rspCd).toBe('00136');
    expect(b.orderableCash).toBe(1000000);
    expect(b.totalEval).toBe(1000000);
  });

  it('허용목록에 없는 실제 오류코드는 throw', async () => {
    stubFetch(() => ({ json: { rsp_cd: 'IZAA001', rsp_msg: '조회 오류' } }));
    await expect(getLSKRBalance(cfg, 'T')).rejects.toThrow(/CSPAQ12200 rsp_cd=IZAA001/);
  });
});

describe('getLSUSBalance (COSOQ00201)', () => {
  it('rsp_cd=00000 정상 — 원화환산 총평가 파싱', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('https://openapi.ls-sec.co.kr:8080/overseas-stock/accno');
      expect(init.headers['tr_cd']).toBe('COSOQ00201');
      const body = JSON.parse(init.body).COSOQ00201InBlock1;
      expect(body.CrcyCode).toBe('ALL');
      expect(body.AstkBalTpCode).toBe('00');
      expect(body.BaseDt).toBe('20260806');
      return { json: {
        rsp_cd: '00000',
        COSOQ00201OutBlock1: { AcntNo: '55512345678' },
        COSOQ00201OutBlock2: { WonEvalSumAmt: '5000000', WonDpsBalAmt: '2000000' },
      } };
    });
    const b = await getLSUSBalance(cfg, 'T', '20260806');
    expect(b.totalEvalKRW).toBe(5000000);
    expect(b.wonDeposit).toBe(2000000);
    expect(b.empty).toBe(false);
  });

  it('rsp_cd=02679 "조회내역이 없습니다" → 성공, 평가금액 0(빈 잔고)', async () => {
    stubFetch(() => ({ json: { rsp_cd: '02679', rsp_msg: '조회내역이 없습니다.' } }));
    const b = await getLSUSBalance(cfg, 'T', '20260806');
    expect(b.rspCd).toBe('02679');
    expect(b.empty).toBe(true);
    expect(b.totalEvalKRW).toBe(0);
    expect(b.wonDeposit).toBe(0);
  });

  it('허용목록에 없는 실제 오류코드는 throw', async () => {
    stubFetch(() => ({ json: { rsp_cd: 'IGW00001', rsp_msg: '권한 오류' } }));
    await expect(getLSUSBalance(cfg, 'T', '20260806')).rejects.toThrow(/COSOQ00201 rsp_cd=IGW00001/);
  });
});

// ─── Phase 2: 시세 / 15분봉 / 거래소코드 / 오류분류 ───────────
describe('거래소코드 매핑 (확인분만)', () => {
  it('NASDAQ→82, NYSE→81 (공식 확인), 미확인은 null', () => {
    expect(toLSOverseasExchcd('NASDAQ')).toBe('82');
    expect(toLSOverseasExchcd('NASD')).toBe('82');
    expect(toLSOverseasExchcd('NYSE')).toBe('81');
    expect(toLSOverseasExchcd('AMEX')).toBe('81');   // 공식 GSH 예제 81SOXL 로 확인
    expect(toLSOverseasExchcd('XYZ')).toBeNull();
  });
});

describe('getLSKRPrice / getLSUSPrice', () => {
  it('t1102 현재가 파싱', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('https://openapi.ls-sec.co.kr:8080/stock/market-data');
      expect(init.headers['tr_cd']).toBe('t1102');
      expect(JSON.parse(init.body)).toEqual({ t1102InBlock: { shcode: '005930' } });
      return { json: { rsp_cd: '00000', t1102OutBlock: { price: '75000', open: '74000', high: '75500', low: '73800', volume: '1234567' } } };
    });
    const p = await getLSKRPrice(cfg, 'T', '005930');
    expect(p.price).toBe(75000); expect(p.open).toBe(74000); expect(p.volume).toBe(1234567);
  });
  it('g3101 해외 현재가 파싱 + keysymbol=exchcd+symbol', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('https://openapi.ls-sec.co.kr:8080/overseas-stock/market-data');
      const b = JSON.parse(init.body).g3101InBlock;
      expect(b.exchcd).toBe('82'); expect(b.symbol).toBe('TSLA'); expect(b.keysymbol).toBe('82TSLA');
      return { json: { rsp_cd: '00000', g3101OutBlock: { price: '283.8200', open: '285.09', high: '285.31', low: '281.84', volume: 414175 } } };
    });
    const p = await getLSUSPrice(cfg, 'T', 'TSLA', '82', 'R');
    expect(p.price).toBeCloseTo(283.82); expect(p.volume).toBe(414175);
  });
});

describe('getLSKR15Min (t8412) / getLSUS15Min (g3203)', () => {
  it('국내: ncnt=15 전송, OutBlock1 파싱 + 형성봉 제외 + 오름차순', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('https://openapi.ls-sec.co.kr:8080/stock/chart');
      expect(init.headers['tr_cd']).toBe('t8412');
      expect(JSON.parse(init.body).t8412InBlock.ncnt).toBe(15);
      // 일부러 뒤섞인 순서로 3개 제공 → 정렬 후 마지막(가장 최근=형성봉) 제외 → 2개
      return { json: { rsp_cd: '00000', t8412OutBlock1: [
        { date: '20260806', time: '093000', open: 10, high: 11, low: 9, close: 10, jdiff_vol: 100 },
        { date: '20260806', time: '091500', open: 12, high: 13, low: 11, close: 12, jdiff_vol: 120 },
        { date: '20260806', time: '090000', open: 20, high: 21, low: 19, close: 20, jdiff_vol: 200 },
      ] } };
    });
    const r = await getLSKR15Min(cfg, 'T', '005930', 60);
    expect(r.candles.map(c => c.datetime)).toEqual(['20260806090000', '20260806091500']);  // 093000(최근) 제외
    expect(r.candles[0].close).toBe(20); expect(r.candles[0].volume).toBe(200);
    expect(r.rawCount).toBe(3);
  });
  it('해외: ncnt=15 전송, exevol→volume, 형성봉 제외', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('https://openapi.ls-sec.co.kr:8080/overseas-stock/chart');
      expect(init.headers['tr_cd']).toBe('g3203');
      expect(JSON.parse(init.body).g3203InBlock.ncnt).toBe(15);
      return { json: { rsp_cd: '00000', g3203OutBlock1: [
        { date: '20260805', loctime: '011000', open: '1', high: '2', low: '0.5', close: '1.5', exevol: 8016 },
        { date: '20260805', loctime: '012000', open: '1.5', high: '2.5', low: '1', close: '2', exevol: 13514 },
      ] } };
    });
    const r = await getLSUS15Min(cfg, 'T', 'TSLA', '82', 'R', { sdate: '20260726' });
    expect(r.candles).toHaveLength(1);                // 2개 중 형성봉 1개 제외
    expect(r.candles[0].datetime).toBe('20260805011000');
    expect(r.candles[0].close).toBe(1.5); expect(r.candles[0].volume).toBe(8016);
  });
  it('빈 OutBlock1 → candles 빈 배열', async () => {
    stubFetch(() => ({ json: { rsp_cd: '00000' } }));
    expect((await getLSKR15Min(cfg, 'T', '005930')).candles).toEqual([]);
  });
});

describe('AAPL 빈 응답 진단 (g3203)', () => {
  it('빈 OutBlock1 시 rsp_cd/msg/OutBlock(연속조회)/개수/요청body 를 노출', async () => {
    stubFetch((url, init) => {
      const b = JSON.parse(init.body).g3203InBlock;
      expect(b.exchcd).toBe('82'); expect(b.keysymbol).toBe('82AAPL'); expect(b.ncnt).toBe(15);
      expect(b.comp_yn).toBe('N'); expect(b.edate).toBe('');
      return { json: {
        rsp_cd: '00000', rsp_msg: '조회완료',
        g3203OutBlock: { keysymbol: '82AAPL', cts_date: '20260806', cts_time: '093000', rec_count: 0 },
        // g3203OutBlock1 없음(빈 응답)
      } };
    });
    const r = await getLSUS15Min(cfg, 'T', 'AAPL', '82', 'R', { sdate: '20260727' });
    expect(r.candles).toEqual([]);
    expect(r.rawCount).toBe(0);
    expect(r.rspCd).toBe('00000');
    expect(r.ctsDate).toBe('20260806');    // 연속조회 위치 노출
    expect(r.ctsTime).toBe('093000');
    expect((r.reqBody as any).g3203InBlock.symbol).toBe('AAPL');   // 요청 body 진단
  });
});

// ── g3203 공식 제한(비압축 qrycnt≤5) + 연속조회 ────────────────
describe('g3203 공식 제한 준수 (Phase A: comp_yn=N, qrycnt=5)', () => {
  it('qrycnt=5 · comp_yn=N 전송, rsp_cd=00000·rec_count=5·OutBlock1 5개 수신', async () => {
    stubFetch((url, init) => {
      const b = JSON.parse(init.body).g3203InBlock;
      expect(b.comp_yn).toBe('N');
      expect(b.qrycnt).toBe(5);          // 공식 비압축 상한
      expect(b.ncnt).toBe(15);
      const rows = Array.from({ length: 5 }, (_, i) => ({
        date: '20260805', loctime: String(10 + i).padStart(2, '0') + '1000',
        open: '1', high: '2', low: '0.5', close: String(1 + i), exevol: 100 + i,
      }));
      return { json: { rsp_cd: '00000', rsp_msg: '조회완료', g3203OutBlock: { rec_count: 5, cts_date: '20260805', cts_time: '090000' }, g3203OutBlock1: rows } };
    });
    const r = await getLSUS15Min(cfg, 'T', 'AAPL', '82', 'R', { qrycnt: 5, sdate: '20260801' });
    expect(r.rspCd).toBe('00000');
    expect(r.recCount).toBe(5);
    expect(r.rawCount).toBe(5);          // OutBlock1.length
    expect(r.rows).toHaveLength(5);
    expect(r.candles).toHaveLength(4);   // 최신 1개(형성봉) 제외
  });

  it('qrycnt 초과 요청(120)은 공식 상한 5 로 clamp 되어 전송된다', async () => {
    let sentQrycnt = -1;
    stubFetch((url, init) => {
      sentQrycnt = JSON.parse(init.body).g3203InBlock.qrycnt;
      return { json: { rsp_cd: '00000', g3203OutBlock1: [] } };
    });
    await getLSUS15Min(cfg, 'T', 'AAPL', '82', 'R', { qrycnt: 120 });
    expect(sentQrycnt).toBe(LS_G3203_MAX_QRYCNT_UNCOMPRESSED);   // 5
  });
});

describe('g3203 연속조회 (Phase B: tr_cont/tr_cont_key 반복)', () => {
  it('tr_cont=Y 로 반복 호출(최대 12회)·중복 timestamp 제거·최신 확정봉 확보', async () => {
    const contKeys: string[] = [];
    let call = 0;
    stubFetch((url, init) => {
      call++;
      contKeys.push(init.headers['tr_cont'] + ':' + (init.headers['tr_cont_key'] || ''));
      // 페이지마다 5봉, 시간 역순(page1=최신). 페이지 경계에 1봉 겹치게 해 중복제거 검증.
      // 전역 분(minute) 인덱스: page p 의 k번째 = base - ((p-1)*4 + k)  (stride4/width5 → 1겹침)
      const base = 20000;
      const rows = Array.from({ length: 5 }, (_, k) => {
        const idx = (call - 1) * 4 + k;               // 0,1,2,3,4 | 4,5,6,7,8 | ...
        const m = base - idx;                          // 분 인덱스(감소)
        const hh = String(Math.floor(m / 60) % 24).padStart(2, '0');
        const mm = String(m % 60).padStart(2, '0');
        return { date: '20260805', loctime: `${hh}${mm}00`, open: '1', high: '2', low: '0.5', close: String(m), exevol: 10 };
      });
      const more = call < 20 ? 'Y' : 'N';              // 항상 연속 있음(호출수 상한으로 멈춤 검증)
      return {
        headers: { 'content-type': 'application/json; charset=UTF-8', 'tr_cont': more, 'tr_cont_key': 'KEY' + call },
        json: { rsp_cd: '00000', g3203OutBlock: { rec_count: 5 }, g3203OutBlock1: rows },
      };
    });
    const r = await getLSUS15MinPaged(cfg, 'T', 'AAPL', '82', 'R', { target: 60, maxCalls: 12, sdate: '20260801' });
    expect(r.calls).toBe(12);                          // maxCalls 상한에서 멈춤
    // 첫 호출은 tr_cont=N, 이후는 Y + 직전 응답 tr_cont_key
    expect(contKeys[0]).toBe('N:');
    expect(contKeys[1]).toBe('Y:KEY1');
    expect(contKeys[2]).toBe('Y:KEY2');
    // 중복 timestamp 제거됨
    const dts = r.candles.map(c => c.datetime);
    expect(new Set(dts).size).toBe(dts.length);
    // 오름차순 정렬
    expect([...dts].sort()).toEqual(dts);
    // stride4/width5 → 12페이지 고유 = 4*12+1=49, 형성봉 1 제외 = 48
    expect(r.candles.length).toBe(48);
  });

  it('응답 tr_cont=N 이면 즉시 연속조회 중단', async () => {
    let call = 0;
    stubFetch(() => {
      call++;
      return {
        headers: { 'content-type': 'application/json; charset=UTF-8', 'tr_cont': 'N', 'tr_cont_key': '' },
        json: { rsp_cd: '00000', g3203OutBlock: { rec_count: 2 }, g3203OutBlock1: [
          { date: '20260805', loctime: '093000', open: '1', high: '1', low: '1', close: '1', exevol: 1 },
          { date: '20260805', loctime: '094500', open: '1', high: '1', low: '1', close: '1', exevol: 1 },
        ] },
      };
    });
    const r = await getLSUS15MinPaged(cfg, 'T', 'AAPL', '82', 'R', { target: 60, maxCalls: 12 });
    expect(r.calls).toBe(1);            // tr_cont=N → 1회로 종료
    expect(call).toBe(1);
    expect(r.candles).toHaveLength(1);  // 2개 중 형성봉 1 제외
  });
});

describe('호출제한(IGW00201) 재시도', () => {
  it('IGW00201 2회 → 3번째 성공, 대기 [1500,3000]', async () => {
    let n = 0;
    stubFetch(() => {
      n++;
      if (n <= 2) return { json: { rsp_cd: 'IGW00201', rsp_msg: '초당 호출 거래건수를 초과하였습니다.' } };
      return { json: { rsp_cd: '00000', t1102OutBlock: { price: '75000', open: '0', high: '0', low: '0', volume: '0' } } };
    });
    const p = await getLSKRPrice(cfg, 'T', '005930');
    expect(p.price).toBe(75000);
    expect(n).toBe(3);                 // 2회 재시도 후 성공
    expect(sleeps).toEqual([1500, 3000]);
  });
  it('IGW00201 가 재시도 후에도 지속되면 RATE_LIMIT 로 throw', async () => {
    stubFetch(() => ({ json: { rsp_cd: 'IGW00201', rsp_msg: '초과' } }));
    await expect(getLSKRPrice(cfg, 'T', '005930')).rejects.toMatchObject({ kind: 'RATE_LIMIT', rspCd: 'IGW00201' });
  });
});

describe('오류 분류 (LSApiError.kind)', () => {
  it('HTTP 429 → RATE_LIMIT', async () => {
    stubFetch(() => ({ status: 429, json: {} }));
    await expect(getLSKRPrice(cfg, 'T', '005930')).rejects.toMatchObject({ kind: 'RATE_LIMIT' });
  });
  it('허용목록 밖 rsp_cd → API', async () => {
    stubFetch(() => ({ json: { rsp_cd: 'IGW00001', rsp_msg: '권한 오류' } }));
    await expect(getLSKRPrice(cfg, 'T', '005930')).rejects.toMatchObject({ kind: 'API', rspCd: 'IGW00001' });
  });
  it('네트워크 예외 → NETWORK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    await expect(getLSKRPrice(cfg, 'T', '005930')).rejects.toMatchObject({ kind: 'NETWORK' });
  });
});

// ─── req 10: 해외 응답 유효성 회귀 ────────────────────────────
describe('해외 응답 유효성 (INVALID_RESPONSE / EMPTY / 정상)', () => {
  it('HTTP 200 + 빈 본문 → INVALID_RESPONSE', async () => {
    stubFetch(() => ({ status: 200, text: '' }));
    await expect(getLSUSPrice(cfg, 'T', 'AAPL', '82', 'R')).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });
  it('HTTP 200 + price=0 + OutBlock 없음 → 성공 처리 금지(EMPTY/INVALID)', async () => {
    // rsp_cd 공백 + OutBlock 없음 → INVALID_RESPONSE
    stubFetch(() => ({ json: {} }));
    await expect(getLSUSPrice(cfg, 'T', 'AAPL', '82', 'R')).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });
  it('HTTP 200 + OutBlock 있으나 price=0 → EMPTY', async () => {
    stubFetch(() => ({ json: { rsp_cd: '00000', g3101OutBlock: { price: '0', open: '0', high: '0', low: '0', volume: 0 } } }));
    await expect(getLSUSPrice(cfg, 'T', 'AAPL', '82', 'R')).rejects.toMatchObject({ kind: 'EMPTY' });
  });
  it('정상 g3101 price>0 → 성공 + diag 포함', async () => {
    stubFetch(() => ({ json: { rsp_cd: '00000', g3101OutBlock: { price: '283.82', open: '285', high: '286', low: '281', volume: 100 } } }));
    const p = await getLSUSPrice(cfg, 'T', 'TSLA', '82', 'R');
    expect(p.price).toBeCloseTo(283.82);
    expect(p.diag.status).toBe(200);
    expect(p.diag.reqHeaders.tr_cd).toBe('g3101');
  });
  it('g3203 rsp_cd 공백 + OutBlock 없음 + 0개 → classifyChart=INVALID_RESPONSE', async () => {
    stubFetch(() => ({ json: {} }));   // rsp_cd 없음, OutBlock 없음
    const r = await getLSUS15Min(cfg, 'T', 'AAPL', '82', 'R', { sdate: '20260727' });
    expect(r.candles).toEqual([]);
    expect(classifyChart(r)).toBe('INVALID_RESPONSE');
    expect(r.diag.status).toBe(200);   // 원문 진단 확보
  });
  it('정상 g3203 OutBlock1 45개(형성봉 제외 44) → classifyChart=OK, 40개 이상', async () => {
    const rows = Array.from({ length: 45 }, (_, i) => {
      const t = 9 * 60 + i * 15; const hh = Math.floor(t / 60), mm = t % 60;
      return { date: '20260805', loctime: `${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}00`, open: '1', high: '2', low: '0.5', close: String(1 + i * 0.01), exevol: 100 };
    });
    stubFetch(() => ({ json: { rsp_cd: '00000', g3203OutBlock: { rec_count: 45 }, g3203OutBlock1: rows } }));
    const r = await getLSUS15Min(cfg, 'T', 'TSLA', '82', 'R', { sdate: '20260726' });
    expect(classifyChart(r)).toBe('OK');
    expect(r.candles.length).toBeGreaterThanOrEqual(40);   // 44 확정봉
  });
});

describe('g3202 NTICK 과거 틱 (15분 재집계 fallback)', () => {
  it('comp_yn=N·qrycnt 상한 5 전송, date+loctime→datetime, exevol→volume, cts_seq 노출', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('https://openapi.ls-sec.co.kr:8080/overseas-stock/chart');
      const b = JSON.parse(init.body).g3202InBlock;
      expect(init.headers['tr_cd']).toBe('g3202');
      expect(b.comp_yn).toBe('N');
      expect(b.qrycnt).toBe(5);   // 120 요청해도 상한 5
      return { json: { rsp_cd: '00000', g3202OutBlock: { rec_count: 2, cts_seq: 20250428014650000 }, g3202OutBlock1: [
        { date: '20260805', loctime: '014721', open: '283.16', high: '283.16', low: '283.10', close: '283.10', exevol: 25 },
        { date: '20260805', loctime: '014730', open: '283.10', high: '283.12', low: '283.02', close: '283.12', exevol: 111 },
      ] } };
    });
    const r = await getLSUSTicks(cfg, 'T', 'AAPL', '82', 'R', { qrycnt: 120, sdate: '20260801' });
    expect(r.ticks).toHaveLength(2);
    expect(r.ticks[0].datetime).toBe('20260805014721');
    expect(r.ticks[1].volume).toBe(111);
    expect(r.ctsSeq).toBe('20250428014650000');
    expect(r.rawCount).toBe(2);
  });

  it('연속조회: tr_cont=Y 로 틱 누적(같은 시각 중복 유지), 버킷 target 도달 시 종료', async () => {
    let call = 0;
    stubFetch(() => {
      call++;
      // 각 호출 5틱, 15분 간격으로 새 버킷 하나씩 생성 → 버킷 수 = 호출 수
      const base = 9 * 60 + (call - 1) * 15;   // 분(09:00 부터 15분씩)
      const hh = String(Math.floor(base / 60)).padStart(2, '0');
      const mm = String(base % 60).padStart(2, '0');
      const rows = Array.from({ length: 5 }, (_, i) => ({
        date: '20260805', loctime: `${hh}${mm}${String(10 + i).padStart(2, '0')}`,   // 같은 버킷 내 여러 틱(일부 같은 시각)
        open: '1', high: '2', low: '0.5', close: '1.5', exevol: 10,
      }));
      return {
        headers: { 'content-type': 'application/json; charset=UTF-8', 'tr_cont': 'Y', 'tr_cont_key': 'K' + call },
        json: { rsp_cd: '00000', g3202OutBlock: { rec_count: 5 }, g3202OutBlock1: rows },
      };
    });
    const r = await getLSUSTicksPaged(cfg, 'T', 'AAPL', '82', 'R', { target: 21, maxCalls: 40, sdate: '20260801' });
    expect(r.calls).toBe(21);                  // 버킷 21개(=호출 21회) 도달 시 종료
    expect(r.ticks.length).toBe(21 * 5);       // 틱은 dedup 안 함
  });

  it('tr_cont=N 이면 1회로 종료', async () => {
    stubFetch(() => ({
      headers: { 'content-type': 'application/json; charset=UTF-8', 'tr_cont': 'N', 'tr_cont_key': '' },
      json: { rsp_cd: '00000', g3202OutBlock: { rec_count: 1 }, g3202OutBlock1: [
        { date: '20260805', loctime: '093012', open: '1', high: '1', low: '1', close: '1', exevol: 1 },
      ] },
    }));
    const r = await getLSUSTicksPaged(cfg, 'T', 'AAPL', '82', 'R', { target: 21, maxCalls: 40 });
    expect(r.calls).toBe(1);
  });
});

describe('해외 주문/체결/예수금 (공식 필드)', () => {
  it('COSAT00301 지정가 매수 — 공식 InBlock 필드 전송(OrdPtnCode=02, OrdprcPtnCode=00)', async () => {
    let sent: any = null;
    stubFetch((url, init) => {
      expect(url).toBe('https://openapi.ls-sec.co.kr:8080/overseas-stock/order');
      expect(init.headers['tr_cd']).toBe('COSAT00301');
      sent = JSON.parse(init.body).COSAT00301InBlock1;
      return { json: { rsp_cd: '00000', rsp_msg: '정상', COSAT00301OutBlock1: { OrdNo: 141 } } };
    });
    const r = await placeLSUSBuyOrder(cfg, 'T', { exchcd: '82', symbol: 'AAPL', qty: 1, price: 190.5 });
    expect(sent).toMatchObject({ RecCnt: 1, OrdPtnCode: '02', OrdMktCode: '82', IsuNo: 'AAPL', OrdQty: 1, OvrsOrdPrc: 190.5, OrdprcPtnCode: '00', BrkTpCode: '' });
    expect(r.rspCd).toBe('00000');
    expect(r.ordNo).toBe('141');
  });

  it('isUSOrderSuccess — 00000 또는 OrdNo 존재 시 성공(코드 오탐 방지)', () => {
    expect(isUSOrderSuccess('00000', null)).toBe(true);
    expect(isUSOrderSuccess('99999', '141')).toBe(true);     // 코드 몰라도 OrdNo 있으면 성공
    expect(isUSOrderSuccess('40510', null)).toBe(false);     // 거부
    expect(isUSOrderSuccess('99999', '(unknown)')).toBe(false);
  });
  it('COSAQ00102 체결/미체결 조회 — OutBlock3 파싱(OrdNo/ExecQty/UnercQty)', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('https://openapi.ls-sec.co.kr:8080/overseas-stock/accno');
      expect(init.headers['tr_cd']).toBe('COSAQ00102');
      const b = JSON.parse(init.body).COSAQ00102InBlock1;
      expect(b.ExecYn).toBe('0'); expect(b.OrdMktCode).toBe('82');
      return { json: { rsp_cd: '00000', COSAQ00102OutBlock3: [
        { OrdNo: 141, OrgOrdNo: 0, ShtnIsuNo: 'TSLA', OrdQty: 10, ExecQty: 4, UnercQty: 6, OvrsOrdPrc: '200.00', OrdPtnCode: '02', OrdTrxPtnNm: '접수' },
      ] } };
    });
    const r = await queryLSUSOrderExec(cfg, 'T', { exchcd: '82', symbol: 'TSLA', ordDate: '20260706' });
    expect(r.queryOk).toBe(true);
    expect(r.classification).toBe('SUCCESS');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ ordNo: '141', symbol: 'TSLA', ordQty: 10, execQty: 4, unfilledQty: 6, ordPtnCode: '02' });
  });
  it('P0-27a: 00000 + rows0 → SUCCESS(queryOk=true)', async () => {
    stubFetch(() => ({ status: 200, json: { rsp_cd: '00000', rsp_msg: '정상', COSAQ00102OutBlock3: [] } }));
    const r = await queryLSUSOrderExec(cfg, 'T', { exchcd: '82', symbol: 'AAPL', ordDate: '20260810' });
    expect(r.classification).toBe('SUCCESS'); expect(r.queryOk).toBe(true); expect(r.rows).toEqual([]);
  });
  it('P0-27a: 실측 확인된 empty code + rows0 → EMPTY(queryOk=true) — emptyCodes 주입 시에만', async () => {
    stubFetch(() => ({ status: 200, json: { rsp_cd: '00600', rsp_msg: '조회할 자료가 없습니다.' } }));
    const r = await queryLSUSOrderExec(cfg, 'T', { exchcd: '82', symbol: 'AAPL', ordDate: '20260810' }, { emptyCodes: ['00600'] });
    expect(r.classification).toBe('EMPTY'); expect(r.queryOk).toBe(true); expect(r.rows).toEqual([]);
  });
  it('P0-27a: 임의 unknown non-00000 + HTTP200 JSON → BUSINESS_ERROR 차단(fail-closed, 미등록)', async () => {
    stubFetch(() => ({ status: 200, json: { rsp_cd: '00600', rsp_msg: '조회할 자료가 없습니다.' } }));
    const r = await queryLSUSOrderExec(cfg, 'T', { exchcd: '82', symbol: 'AAPL', ordDate: '20260810' });   // emptyCodes 미주입
    expect(r.classification).toBe('BUSINESS_ERROR'); expect(r.queryOk).toBe(false); expect(r.rows).toEqual([]);
  });
  it('P0-27a: malformed(빈 본문) → TRANSPORT_ERROR 차단', async () => {
    stubFetch(() => ({ status: 200, text: '' }));
    const r = await queryLSUSOrderExec(cfg, 'T', { exchcd: '82', symbol: 'AAPL', ordDate: '20260810' });
    expect(r.classification).toBe('TRANSPORT_ERROR'); expect(r.queryOk).toBe(false); expect(r.kind).toBe('INVALID_RESPONSE');
  });
  it('P0-27a: network/HTTP 500 → TRANSPORT_ERROR 차단', async () => {
    stubFetch(() => ({ status: 500, statusText: 'ERR', json: { rsp_cd: 'IGW00099', rsp_msg: '서버오류' } }));
    const r = await queryLSUSOrderExec(cfg, 'T', { exchcd: '82', symbol: 'AAPL', ordDate: '20260810' });
    expect(r.classification).toBe('TRANSPORT_ERROR'); expect(r.queryOk).toBe(false);
  });
  it('P0-27a: classifyOrderExec 순수함수 — 4분류 fail-closed', () => {
    const sc = ['00000']; const ec = ['00600'];
    expect(classifyOrderExec({ rspCd: '00000', successCodes: sc, emptyCodes: ec })).toBe('SUCCESS');
    expect(classifyOrderExec({ rspCd: '00600', successCodes: sc, emptyCodes: ec })).toBe('EMPTY');
    expect(classifyOrderExec({ rspCd: '99999', successCodes: sc, emptyCodes: ec })).toBe('BUSINESS_ERROR');   // unknown → 차단
    expect(classifyOrderExec({ rspCd: '00600', successCodes: sc, emptyCodes: [] })).toBe('BUSINESS_ERROR');   // 미등록 → 차단
    expect(classifyOrderExec({ transportError: true, rspCd: '00000', successCodes: sc, emptyCodes: ec })).toBe('TRANSPORT_ERROR');
  });

  // COSOQ02701 공식 응답 모의(OutBlock3 통화별 + OutBlock4 원화요약). USD현금/선환전/환율/원화현금/미수 지정.
  function depBody(over: { rspCd?: string; usdCash?: string; usdOrdable?: string; prexchUsd?: string; rate?: string;
                          wonCash?: number; wonOutable?: number; wonPrexch?: number; ovrsMgn?: number;
                          noOb3?: boolean; noUsd?: boolean; noUsdCash?: boolean; noOb4?: boolean } = {}) {
    const usd: any = {
      CrcyCode: 'USD', FcurrDps: over.usdCash ?? '0.0000', FcurrOrdAbleAmt: over.usdOrdable ?? '0.0000',
      PrexchOrdAbleAmt: over.prexchUsd ?? '9245.8800', BaseXchrat: over.rate ?? '1434.6000',
    };
    if (over.noUsdCash) delete usd.FcurrDps;
    const ob4: any = {
      RecCnt: 1, WonDpsBalAmt: over.wonCash ?? 13927349, MnyoutAbleAmt: over.wonOutable ?? (over.wonCash ?? 13927349),
      WonPrexchAbleAmt: over.wonPrexch ?? (over.wonCash ?? 13927349), OvrsMgn: over.ovrsMgn ?? 0,
    };
    const json: any = { rsp_cd: over.rspCd ?? '00136', rsp_msg: '조회가 완료되었습니다.' };
    if (!over.noOb3) json.COSOQ02701OutBlock3 = over.noUsd ? [{ CrcyCode: 'HKD', FcurrDps: '0.0000' }] : [usd];
    if (!over.noOb4) json.COSOQ02701OutBlock4 = ob4;
    return json;
  }

  it('COSOQ02701 해외예수금(rsp_cd=00000) — OutBlock3 USD현금/선환전 + OutBlock4 원화현금 파싱', async () => {
    stubFetch((url, init) => {
      expect(init.headers['tr_cd']).toBe('COSOQ02701');
      return { json: depBody({ rspCd: '00000', usdCash: '3300.5000', prexchUsd: '9245.8800', rate: '1434.6000', wonCash: 13927349 }) };
    });
    const r = await getLSUSDeposit(cfg, 'T');
    expect(r.ok).toBe(true);
    expect(r.found).toBe(true);
    expect(r.usdCash).toBeCloseTo(3300.5);
    expect(r.usdDeposit).toBeCloseTo(3300.5);      // 하위호환 = usdCash
    expect(r.usdPrexchOrderable).toBeCloseTo(9245.88);
    expect(r.baseXchRate).toBeCloseTo(1434.6);
    expect(r.krwCash).toBe(13927349);
    expect(r.overseasMargin).toBe(0);
  });
  it('P0-14: rsp_cd=00136(조회 완료) + 정상 블록 → ok=true (실계정 사고 수정)', async () => {
    stubFetch(() => ({ json: depBody({ rspCd: '00136', usdCash: '5234.1500' }) }));
    const r = await getLSUSDeposit(cfg, 'T');
    expect(r.ok).toBe(true);                 // 00136 도 정상(allow-list)
    expect(r.rspCd).toBe('00136');
    expect(r.usdCash).toBeCloseTo(5234.15);
  });
  it('P0-15: USD현금=0 이어도 OutBlock3/OutBlock4 정상이면 ok=true (원화현금 경로 조회 가능)', async () => {
    stubFetch(() => ({ json: depBody({ usdCash: '0.0000', wonCash: 13927349 }) }));
    const r = await getLSUSDeposit(cfg, 'T');
    expect(r.ok).toBe(true);
    expect(r.usdCash).toBe(0);
    expect(r.krwCash).toBe(13927349);
  });
  it('P0-14/15: rsp_cd=00136 + OutBlock 없음 → ok=false(차단)', async () => {
    stubFetch(() => ({ json: { rsp_cd: '00136', rsp_msg: '조회가 완료되었습니다.' } }));
    const r = await getLSUSDeposit(cfg, 'T');
    expect(r.ok).toBe(false);                // 블록 없음 → 차단
    expect(r.usdCash).toBe(0);
  });
  it('P0-15: OutBlock3 있으나 USD현금 필드 없음 → ok=false', async () => {
    stubFetch(() => ({ json: depBody({ noUsdCash: true }) }));
    const r = await getLSUSDeposit(cfg, 'T');
    expect(r.ok).toBe(false);
  });
  it('P0-15: OutBlock4(원화요약) 없음 → ok=false(원화현금 판정 불가 → 차단)', async () => {
    stubFetch(() => ({ json: depBody({ noOb4: true }) }));
    const r = await getLSUSDeposit(cfg, 'T');
    expect(r.ok).toBe(false);
  });
  it('P0-14: 기타 코드(성공목록 아님) → lsPost throw → failure', async () => {
    stubFetch(() => ({ json: depBody({ rspCd: 'IZAA999' }) }));
    await expect(getLSUSDeposit(cfg, 'T')).rejects.toThrow();
  });

  // ── P0-16 재검토: 확정 경로(거래국가 통화=USD현금)만 LIVE 허용. 타통화+원화(통합증거금/선환전)는 실측확인 전 하드차단 ──
  // usdOrderable = FcurrOrdAbleAmt(거래국가 통화, USD현금) / usdPrexchOrderable = PrexchOrdAbleAmt(타통화+원화, 미확정·참고)
  // LS_US_CROSS_WON_TR_CONFIRMED(코드상수)=false 이므로 opts.crossWonVerified 를 줘도 타통화+원화 경로는 봉인됨.
  function dep(over: Partial<LSUSDeposit> = {}): LSUSDeposit {
    return {
      ok: true, rspCd: '00136', rspMsg: '', found: true, diag: {} as any,
      usdCash: 0, usdOrderable: 0, usdPrexchOrderable: 97.29, baseXchRate: 1434.6,
      krwCash: 13927349, krwWithdrawable: 13927349, krwPrexchable: 13927349, overseasMargin: 0,
      t4FcurrDps: 0, fcurrOrdAmt: 0, fcurrMxchgAbleAmt: 0, fcurrPldgAmt: 0, loanAmt: 0,
      usdDeposit: 0, rawMasked: {}, ...over,
    };
  }
  it('P0-16 실계정 재현(AAPL≈311, PrexchOrdAbleAmt=97.29) → 가능수량 0, 하드차단', () => {
    // 97.29 / 311 ≈ 0.31 → 정수주 0. 거래국가통화(USD현금)=0. 타통화+원화 경로는 미확인이라 허용 안 함.
    const d = decideUSCashPayment(dep({ usdOrderable: 0, usdPrexchOrderable: 97.29 }), 311, 1);
    expect(d.qtyCountry).toBe(0);
    expect(d.qtyCrossWon).toBe(0);   // 참고값도 0
    expect(d.orderAllowed).toBe(false);
    expect(d.reason).toBe('ORDERABLE_QTY_INSUFFICIENT');
  });
  it('P0-16: 타통화+원화 참고수량이 있어도(선환전 충분) 실측확인 전 → 차단(CROSS_WON_UNVERIFIED)', () => {
    // 선환전 참고수량은 충분(9245.88/200=46)하지만 거래국가통화(USD현금)=0 이고 crossWon 미확인 → 하드차단
    const d = decideUSCashPayment(dep({ usdOrderable: 0, usdPrexchOrderable: 9245.88 }), 200, 1);
    expect(d.qtyCrossWon).toBe(Math.floor(9245.88 / 200));
    expect(d.crossWonVerified).toBe(false);
    expect(d.orderAllowed).toBe(false);
    expect(d.reason).toBe('CROSS_WON_UNVERIFIED');
  });
  it('P0-20: 코드상수 확정(LS_US_CROSS_WON_TR_CONFIRMED=true) → crossWonVerified 경로 활성', () => {
    expect(LS_US_CROSS_WON_TR_CONFIRMED).toBe(true);
    const d = decideUSCashPayment(dep({ usdOrderable: 0, usdPrexchOrderable: 9245.88 }), 200, 1, { crossWonVerified: true });
    expect(d.crossWonVerified).toBe(true);    // 코드상수 확정 → 경로 활성
    expect(d.orderAllowed).toBe(true);        // qtyCrossWon=46 ≥ 1
    expect(d.reason).toBe('CROSS_WON_PREXCH_VERIFIED');
  });
  it('P0-16: 거래국가 통화(USD현금)로 충분 → paymentMode=USD (확정 경로만 허용)', () => {
    const d = decideUSCashPayment(dep({ usdOrderable: 700, usdCash: 700 }), 311, 1);
    expect(d.qtyCountry).toBe(2);   // 700/311
    expect(d.paymentMode).toBe('USD');
    expect(d.orderAllowed).toBe(true);
    expect(d.reason).toBe('USD_CASH');
  });
  it('P0-16: OvrsMgn>0(미수/증거금) → 즉시 차단(MARGIN_PRESENT), 가능수량 0', () => {
    const d = decideUSCashPayment(dep({ overseasMargin: 100000 }), 311, 1);
    expect(d.orderAllowed).toBe(false);
    expect(d.reason).toBe('MARGIN_PRESENT');
    expect(d.qtyCrossWon).toBe(0);
    expect(usCashOnlyUsdCap(dep({ overseasMargin: 100000 }))).toBe(0);
    expect(usOrderableQty(dep({ overseasMargin: 100000 }), 311)).toEqual({ qtyCountry: 0, qtyCrossWon: 0 });
  });
  it('P0-16: 응답 실패(ok=false) → 차단(INVALID_RESPONSE)', () => {
    const d = decideUSCashPayment(dep({ ok: false }), 311, 1);
    expect(d.orderAllowed).toBe(false);
    expect(d.reason).toBe('INVALID_RESPONSE');
  });
  it('P0-20 cash-only 상한: 기본은 거래국가통화(USD현금)만, verified 면 채택필드(WonCashMin) USD환산 포함', () => {
    // 기본(opts 없음): USD현금(FcurrOrdAbleAmt)만
    expect(usCashOnlyUsdCap(dep({ usdOrderable: 100, usdPrexchOrderable: 9245.88 }))).toBeCloseTo(100);
    // verified: max(USD현금, 채택 WonCashMin/환율). krwCash=krwWithdrawable=13927349 / 1434.6 = 9708
    expect(usCashOnlyUsdCap(dep({ usdOrderable: 100 }), { crossWonVerified: true })).toBeCloseTo(13927349 / 1434.6, 0);
    // 실계정: USD현금 0 이어도 verified 면 원화현금(WonCashMin) 환산치 반영 → trader 게이트 통과 가능
    expect(usCashOnlyUsdCap(dep({ usdOrderable: 0, krwCash: 1000742, krwWithdrawable: 1000742, baseXchRate: 1418.8 }), { crossWonVerified: true })).toBeCloseTo(1000742 / 1418.8, 0);
    // cashOnly 아님(미수>0) → 0
    expect(usCashOnlyUsdCap(dep({ overseasMargin: 5000 }), { crossWonVerified: true })).toBe(0);
  });

  // ── P0-18: 통합증거금(타통화+원화) 실측대조 엔진 ──
  it('P0-18 마스킹: AcntNo/Pwd 등 민감키 재귀 마스킹, 금액 필드는 보존', () => {
    const m = maskLSResponse({ COSOQ02701OutBlock1: { AcntNo: '12345678900', Pwd: 'secret', RecCnt: 1 }, COSOQ02701OutBlock3: [{ CrcyCode: 'USD', PrexchOrdAbleAmt: '97.29' }] });
    expect(m.COSOQ02701OutBlock1.AcntNo).toBe('****');
    expect(m.COSOQ02701OutBlock1.Pwd).toBe('****');
    expect(m.COSOQ02701OutBlock1.RecCnt).toBe(1);
    expect(m.COSOQ02701OutBlock3[0].PrexchOrdAbleAmt).toBe('97.29');
  });
  it('P0-20 채택필드 확정 = WonCashMin, 코드상수 확정 = true', () => {
    expect(CROSS_WON_ADOPTED_FIELD).toBe('WonCashMin');
    expect(LS_US_CROSS_WON_TR_CONFIRMED).toBe(true);
  });
  it('P0-18 후보 수량: 같은 bestAsk 로 각 필드 수량 산출(USD/KRW 기준) + HTS 일치 표시', () => {
    // 실계정: PrexchOrdAbleAmt=97.29, bestAsk=311 → 선환전 qty=0. 원화선환전 1392만/(311*1434.6)=31.
    const e = evaluateCrossWon(dep({ usdOrderable: 0, usdPrexchOrderable: 97.29, krwPrexchable: 13927349, krwCash: 13927349 }), 311, 0);
    const byKey = Object.fromEntries(e.candidates.map(c => [c.key, c]));
    expect(byKey['PrexchOrdAbleAmt'].qty).toBe(0);      // 97.29/311 → 0
    expect(byKey['FcurrOrdAbleAmt'].qty).toBe(0);       // 거래국가통화(USD현금)=0
    expect(byKey['WonPrexchAbleAmt'].qty).toBe(Math.floor(13927349 / (311 * 1434.6)));
    // HTS 실측=0 이면 qty=0 후보들이 일치로 표시
    expect(byKey['PrexchOrdAbleAmt'].match).toBe(true);
    expect(e.matchedKeys).toContain('PrexchOrdAbleAmt');
  });
  it('P0-20 채택 확정 후: HTS 값 제공 시 프로그램과 불일치면 차단(HTS_QTY_MISMATCH)', () => {
    // 채택=WonCashMin, dep 기본 원화현금 1392만 → qty=31. HTS=0 제공 → 불일치 차단.
    const e = evaluateCrossWon(dep({ usdPrexchOrderable: 97.29 }), 311, 0);
    expect(e.adoptedField).toBe('WonCashMin');
    expect(e.programQty).toBe(Math.floor(13927349 / (311 * 1434.6)));   // 31
    expect(e.orderAllowed).toBe(false);
    expect(e.reason).toBe('HTS_QTY_MISMATCH');
  });
  it('P0-18 cash-only: 미수/대출/담보 잔액 있으면 cashOnly=false + 차단필드 보고', () => {
    const e = evaluateCrossWon(dep({ overseasMargin: 5000, loanAmt: 100, fcurrPldgAmt: 3.5 }), 311, 2);
    expect(e.cashOnly).toBe(false);
    expect(e.cashOnlyBlockers).toEqual(['OvrsMgn=5000', 'LoanAmt=100', 'FcurrPldgAmt=3.5']);
  });
  it('P0-18 cash-only: 잔액 전부 0 → cashOnly=true', () => {
    const e = evaluateCrossWon(dep({ overseasMargin: 0, loanAmt: 0, fcurrPldgAmt: 0 }), 311, 0);
    expect(e.cashOnly).toBe(true);
    expect(e.cashOnlyBlockers).toEqual([]);
  });
  it('P0-20 [CROSS-WON-CHECK] 로그 형식(채택 확정 → PROGRAM 수량 표시)', () => {
    const e = evaluateCrossWon(dep({ usdPrexchOrderable: 97.29 }), 311, null);
    const line = formatCrossWonCheck('AAPL', e);
    expect(line).toContain('[CROSS-WON-CHECK AAPL]');
    expect(line).toContain('bestAsk=311.00');
    expect(line).toContain('HTS orderableQty=미입력');
    expect(line).toContain(`PROGRAM orderableQty=${Math.floor(13927349 / (311 * 1434.6))}`);   // 채택필드 수량
    expect(line).toContain('paymentMode=CROSS_WON');
    expect(line).toContain('cashOnly=true');
  });
  it('P0-18 HTS 미입력 → match=N/A, 후보 match=null', () => {
    const e = evaluateCrossWon(dep(), 311, null);
    expect(e.match).toBeNull();
    expect(e.candidates.every(c => c.match === null)).toBe(true);
    expect(formatCrossWonCheck('AAPL', e)).toContain('MATCH=N/A');
  });

  // ── P0-19: 실계정 결정적 매칭 — HTS=2 는 WonDpsBalAmt/MnyoutAbleAmt(원화현금) 와 일치 ──
  const real = () => dep({
    usdOrderable: 0, usdPrexchOrderable: 97.29, baseXchRate: 1418.80,
    krwCash: 1000742, krwWithdrawable: 1000742, krwPrexchable: 144942,
  });
  it('P0-19 실계정: bestAsk=311.65 → WonDpsBalAmt/MnyoutAbleAmt qty=2, 선환전류 qty=0', () => {
    const e = evaluateCrossWon(real(), 311.65, 2);
    const byKey = Object.fromEntries(e.candidates.map(c => [c.key, c]));
    expect(byKey['WonDpsBalAmt'].qty).toBe(2);       // 1000742/(311.65*1418.8)=2.26 → 2
    expect(byKey['MnyoutAbleAmt'].qty).toBe(2);
    expect(byKey['WonCashMin'].qty).toBe(2);          // min(1000742,1000742) → 2
    expect(byKey['WonPrexchAbleAmt'].qty).toBe(0);   // 144942/442169 → 0
    expect(byKey['PrexchOrdAbleAmt'].qty).toBe(0);   // 97.29/311.65 → 0
    expect(byKey['FcurrOrdAbleAmt'].qty).toBe(0);
  });
  it('P0-19 실계정: HTS=2 와 일치하는 후보 자동표시(WonDpsBalAmt/MnyoutAbleAmt/WonCashMin)', () => {
    const e = evaluateCrossWon(real(), 311.65, 2);
    expect(e.matchedKeys).toEqual(expect.arrayContaining(['WonDpsBalAmt', 'MnyoutAbleAmt', 'WonCashMin']));
    expect(e.matchedKeys).not.toContain('PrexchOrdAbleAmt');
    expect(e.matchedKeys).not.toContain('WonPrexchAbleAmt');
  });
  it('P0-20 실계정: 채택 확정(WonCashMin) + HTS=2 일치 + cashOnly → orderAllowed=true', () => {
    const e = evaluateCrossWon(real(), 311.65, 2);
    expect(e.adoptedField).toBe('WonCashMin');
    expect(e.programQty).toBe(2);
    expect(e.match).toBe(true);          // HTS=2 == PROGRAM=2
    expect(e.cashOnly).toBe(true);       // OvrsMgn/Loan/Pldg 전부 0
    expect(e.orderAllowed).toBe(true);
    expect(e.reason).toBe('OK');
  });
  it('P0-20 실계정: HTS 미입력이어도 채택+cashOnly+qty>=1 이면 허용(BUY 게이트)', () => {
    const e = evaluateCrossWon(real(), 311.65, null);   // HTS 값 없이
    expect(e.programQty).toBe(2);
    expect(e.orderAllowed).toBe(true);   // 확정 후엔 qty>=1 && cashOnly 로 허용
    expect(e.reason).toBe('OK');
  });
  it('P0-20 차단: cashOnly=false(미수/대출/담보) → NOT_CASH_ONLY', () => {
    const e = evaluateCrossWon(dep({ ...real(), overseasMargin: 1 } as any), 311.65, 2);
    expect(e.orderAllowed).toBe(false);
    expect(e.reason).toBe('NOT_CASH_ONLY');
  });
  it('P0-20 차단: 가능수량 0(원화현금 부족) → CROSS_WON_INSUFFICIENT', () => {
    // 원화현금 10만 → 1주비용 44만 → qty 0
    const e = evaluateCrossWon(dep({ usdOrderable: 0, krwCash: 100000, krwWithdrawable: 100000, baseXchRate: 1418.8 }), 311.65, null);
    expect(e.programQty).toBe(0);
    expect(e.orderAllowed).toBe(false);
    expect(e.reason).toBe('CROSS_WON_INSUFFICIENT');
  });
  it('P0-19 [CROSS-WON-LIVE-CAND] 형식(요구 필드 포함)', () => {
    const line = formatCrossWonLiveCand('AAPL', evaluateCrossWon(real(), 311.65, 2));
    expect(line).toContain('[CROSS-WON-LIVE-CAND AAPL]');
    expect(line).toContain('bestAsk=311.65');
    expect(line).toContain('BaseXchrat=1418.80');
    expect(line).toContain('WonDpsBalAmt=1000742 → qty=2');
    expect(line).toContain('MnyoutAbleAmt=1000742 → qty=2');
    expect(line).toContain('WonPrexchAbleAmt=144942 → qty=0');
    expect(line).toContain('PrexchOrdAbleAmt=97.29 → qty=0');
    expect(line).toContain('HTS=2');
  });
  it('P0-19 WonCashMin: 두 현금지표가 다르면 작은 값 채택(초과주문 방지)', () => {
    const e = evaluateCrossWon(dep({ krwCash: 1000742, krwWithdrawable: 500000, baseXchRate: 1418.8 }), 311.65, null);
    const byKey = Object.fromEntries(e.candidates.map(c => [c.key, c]));
    expect(byKey['WonCashMin'].amount).toBe(500000);   // min(1000742, 500000)
    expect(byKey['WonCashMin'].qty).toBe(1);           // 500000/442169 → 1
  });

  // ── P0-20 최종 실거래 게이트([US-LIVE-GATE]) ──
  const gateOn = { liveTrading: true, usLiveReady: true, crossWonVerified: true };
  it('P0-20 실거래 허용: HTS=2/PROGRAM=2/cashOnly=true + 게이트 ON → POST_ALLOWED=true', () => {
    const e = evaluateCrossWon(real(), 313.22, 2);
    expect(e.programQty).toBe(2); expect(e.cashOnly).toBe(true); expect(e.orderAllowed).toBe(true);
    const line = formatUSLiveGate('AAPL', { ...gateOn, e });
    expect(line).toContain('[US-LIVE-GATE AAPL]');
    expect(line).toContain('LS_LIVE_TRADING=true');
    expect(line).toContain('US_LIVE_READY=true');
    expect(line).toContain('CROSS_WON_VERIFIED=true');
    expect(line).toContain('HTS_QTY=2');
    expect(line).toContain('PROGRAM_QTY=2');
    expect(line).toContain('cashOnly=true');
    expect(line).toContain('paymentMode=CROSS_WON');
    expect(line).toContain('POST_ALLOWED=true');
  });
  it('P0-20 차단: PROGRAM=0(원화현금 부족) → POST_ALLOWED=false', () => {
    const e = evaluateCrossWon(dep({ usdOrderable: 0, krwCash: 100000, krwWithdrawable: 100000, baseXchRate: 1418.8 }), 313.22, null);
    expect(e.programQty).toBe(0);
    expect(formatUSLiveGate('AAPL', { ...gateOn, e })).toContain('POST_ALLOWED=false');
  });
  it('P0-20 차단: OvrsMgn>0 → POST_ALLOWED=false (NOT_CASH_ONLY)', () => {
    const e = evaluateCrossWon(dep({ ...real(), overseasMargin: 1 } as any), 313.22, 2);
    expect(e.orderAllowed).toBe(false); expect(e.reason).toBe('NOT_CASH_ONLY');
    expect(formatUSLiveGate('AAPL', { ...gateOn, e })).toContain('POST_ALLOWED=false');
  });
  it('P0-20 차단: LoanAmt>0 → POST_ALLOWED=false (NOT_CASH_ONLY)', () => {
    const e = evaluateCrossWon(dep({ ...real(), loanAmt: 1 } as any), 313.22, 2);
    expect(e.orderAllowed).toBe(false); expect(e.reason).toBe('NOT_CASH_ONLY');
    expect(formatUSLiveGate('AAPL', { ...gateOn, e })).toContain('POST_ALLOWED=false');
  });
  it('P0-20 차단: FcurrPldgAmt>0 → POST_ALLOWED=false (NOT_CASH_ONLY)', () => {
    const e = evaluateCrossWon(dep({ ...real(), fcurrPldgAmt: 0.5 } as any), 313.22, 2);
    expect(e.orderAllowed).toBe(false); expect(e.reason).toBe('NOT_CASH_ONLY');
    expect(formatUSLiveGate('AAPL', { ...gateOn, e })).toContain('POST_ALLOWED=false');
  });
  it('P0-20 게이트 OFF: LS_LIVE_TRADING=false → 주문가능해도 POST_ALLOWED=false(GATE_OFF)', () => {
    const e = evaluateCrossWon(real(), 313.22, 2);
    expect(e.orderAllowed).toBe(true);
    const line = formatUSLiveGate('AAPL', { liveTrading: false, usLiveReady: true, crossWonVerified: true, e });
    expect(line).toContain('POST_ALLOWED=false');
    expect(line).toContain('GATE_OFF');
  });

  it('P0-17 cashOrderable 로그: 성공/실패 두 형태만, "미조회" 절대 없음', () => {
    expect(formatCashOrderableLine({ ok: true, cash: 97.29, rspCd: '00136', rspMsg: '' }))
      .toBe('cashOrderable=97.29 USD (rsp_cd=00136)');
    expect(formatCashOrderableLine({ ok: true, cash: 0, rspCd: '00136', rspMsg: '조회 완료' }))
      .toBe('cashOrderable=0.00 USD (rsp_cd=00136)');
    const fail = formatCashOrderableLine({ ok: false, cash: 0, rspCd: 'IZAA999', rspMsg: '오류' });
    expect(fail).toBe('cashOrderable=조회실패 rsp_cd=IZAA999 rsp_msg=오류');
    // "미조회" 는 어떤 경우에도 나오지 않는다
    for (const ok of [true, false]) expect(formatCashOrderableLine({ ok, cash: 5, rspCd: 'X', rspMsg: 'Y' })).not.toContain('미조회');
  });

  it('cancelLSUSOrder — 공식 취소 필드 미확인 → 예외(추측 금지)', async () => {
    expect(LS_CANCEL_TR_CONFIRMED).toBe(false);
    await expect(cancelLSUSOrder(cfg, 'T', { exchcd: '82', symbol: 'AAPL', ordNo: '1', qty: 1 })).rejects.toThrow(/COSAT00311/);
  });

  it('COSOQ00201 OutBlock4 보유수량 — ShtnIsuNo/AstkBalQty/AstkSellAbleQty(매도 전 확인)', async () => {
    stubFetch((url, init) => {
      expect(init.headers['tr_cd']).toBe('COSOQ00201');
      return { json: { rsp_cd: '00000', COSOQ00201OutBlock4: [
        { ShtnIsuNo: 'TSLA', AstkBalQty: '15.000000', AstkSellAbleQty: '15.000000' },
        { ShtnIsuNo: 'AAPL', AstkBalQty: '1.000000', AstkSellAbleQty: '1.000000' },
      ] } };
    });
    const r = await getLSUSHoldings(cfg, 'T', '20260806');
    const aapl = r.holdings.find(h => h.symbol === 'AAPL');
    expect(aapl?.balQty).toBe(1);
    expect(aapl?.sellableQty).toBe(1);
  });
});

describe('해외 종목마스터 g3190 (P0-23)', () => {
  it('g3190 페이징 파싱 — exchcd/suspend/sellonly/expire_date/clos + cts_value', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('https://openapi.ls-sec.co.kr:8080/overseas-stock/market-data');
      expect(init.headers['tr_cd']).toBe('g3190');
      const b = JSON.parse(init.body).g3190InBlock;
      expect(b.natcode).toBe('US'); expect(b.exgubun).toBe('2'); expect(b.cts_value).toBe('');
      return { json: { rsp_cd: '00000', g3190OutBlock: { cts_value: 'NEXT01', rec_count: 3 }, g3190OutBlock1: [
        { keysymbol: '82AAPL', exchcd: '82', symbol: 'AAPL', engname: 'APPLE INC', currency: 'USD', clos: '230.5', suspend: 'N', sellonly: '0', expire_date: '00000000', listed_date: '19801212', marketcap: 3500000 },
        { keysymbol: '82HALT', exchcd: '82', symbol: 'HALT', clos: '5', suspend: 'Y', sellonly: '0', expire_date: '00000000' },
        { keysymbol: '81BA', exchcd: '81', symbol: 'BA', clos: '180', suspend: 'N', sellonly: '1', expire_date: '20260930' },
      ] } };
    });
    const r = await getLSUSStockMasterPage(cfg, 'T', { exgubun: '2', ctsValue: '' });
    expect(r.ctsValue).toBe('NEXT01');
    expect(r.rows[0]).toMatchObject({ symbol: 'AAPL', exchcd: '82', market: 'NASDAQ', suspend: false, sellOnly: false, delisting: false, prevClose: 230.5 });
    expect(r.rows[1].suspend).toBe(true);
    expect(r.rows[2]).toMatchObject({ symbol: 'BA', market: 'NYSE_AMEX', sellOnly: true, delisting: true });   // expire_date≠0 → 상폐예정
  });
});

describe('국내 종목마스터 t8436 (P0-22)', () => {
  it('t8436 파싱 — shcode/hname/market(gubun)/spac/etf/전일종가', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('https://openapi.ls-sec.co.kr:8080/stock/etc');
      expect(init.headers['tr_cd']).toBe('t8436');
      expect(JSON.parse(init.body).t8436InBlock.gubun).toBe('1');
      return { json: { rsp_cd: '00000', t8436OutBlock: [
        { shcode: '005930', hname: '삼성전자', gubun: '1', spac_gubun: 'N', etfgubun: '0', jnilclose: 70000, uplmtprice: 91000, dnlmtprice: 49000, recprice: 70000, memedan: '00001', expcode: 'KR7005930003' },
        { shcode: '069500', hname: 'KODEX 200', gubun: '1', spac_gubun: 'N', etfgubun: '1', jnilclose: 40000 },
      ] } };
    });
    const r = await getLSKRStockMaster(cfg, 'T', '1');
    expect(r.rspCd).toBe('00000');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ shcode: '005930', hname: '삼성전자', market: 'KOSPI', spac: false, etf: false, prevClose: 70000 });
    expect(r.rows[1]).toMatchObject({ shcode: '069500', etf: true, etfgubun: '1' });   // ETF 구분
  });
  it('t8436 gubun=2 → market=KOSDAQ, spac_gubun=Y → spac=true', async () => {
    stubFetch(() => ({ json: { rsp_cd: '00000', t8436OutBlock: [
      { shcode: '247540', hname: '에코프로비엠', gubun: '2', spac_gubun: 'N', etfgubun: '0', jnilclose: 100000 },
      { shcode: '456780', hname: '스팩1호', gubun: '2', spac_gubun: 'Y', etfgubun: '0', jnilclose: 2000 },
    ] } }));
    const r = await getLSKRStockMaster(cfg, 'T', '2');
    expect(r.rows[0].market).toBe('KOSDAQ');
    expect(r.rows[1].spac).toBe(true);
  });
});

describe('국내 현물 주문/체결/취소 (공식 필드)', () => {
  it('krIsuNo — 6자리 shcode 에 A 접두', () => {
    expect(krIsuNo('005930')).toBe('A005930');
    expect(krIsuNo('A005930')).toBe('A005930');
  });
  it('CSPAT00601 현물 지정가 매수 — 공식 InBlock(BnsTpCode=2 매수, OrdprcPtnCode=00 지정가)', async () => {
    let sent: any = null;
    stubFetch((url, init) => {
      expect(url).toBe('https://openapi.ls-sec.co.kr:8080/stock/order');
      expect(init.headers['tr_cd']).toBe('CSPAT00601');
      sent = JSON.parse(init.body).CSPAT00601InBlock1;
      return { json: { rsp_cd: '00000', rsp_msg: '정상', CSPAT00601OutBlock2: { OrdNo: 32004, OrdTime: '153257' } } };
    });
    const r = await placeLSKRBuyOrder(cfg, 'T', { shcode: '005930', qty: 1, price: 70000, mbrNo: 'NXT' });
    expect(sent).toMatchObject({ IsuNo: 'A005930', OrdQty: 1, OrdPrc: 70000, BnsTpCode: '2', OrdprcPtnCode: '00', MgntrnCode: '000', LoanDt: '', OrdCndiTpCode: '0', MbrNo: 'NXT' });
    expect(r.rspCd).toBe('00000');
    expect(r.ordNo).toBe('32004');
  });
  it('isKROrderSuccess — 00040(매수 완료) 또는 OrdNo 존재 시 성공(실계정 오탐 방지)', () => {
    expect(isKROrderSuccess('00000', null)).toBe(true);
    expect(isKROrderSuccess('00040', null)).toBe(true);       // 매수 주문이 완료되었습니다.
    expect(isKROrderSuccess('99999', '32004')).toBe(true);    // 코드 몰라도 OrdNo 있으면 성공
    expect(isKROrderSuccess('08085', null)).toBe(false);      // 거부
    expect(isKROrderSuccess('99999', '(unknown)')).toBe(false);
  });
  it('CSPAT00601 rsp_cd=00040 은 lsPost 에서 throw 되지 않고 OrdNo 반환(핵심 버그 수정)', async () => {
    stubFetch(() => ({ json: { rsp_cd: '00040', rsp_msg: '매수 주문이 완료되었습니다.', CSPAT00601OutBlock2: { OrdNo: 32004 } } }));
    const r = await placeLSKRBuyOrder(cfg, 'T', { shcode: '000660', qty: 1, price: 190000 });
    expect(r.rspCd).toBe('00040');
    expect(r.ordNo).toBe('32004');   // 실패로 오판하지 않음
  });
  it('CSPAQ13700 체결조회 — OutBlock2 집계(BuyOrdQty/BuyExecQty)', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('https://openapi.ls-sec.co.kr:8080/stock/accno');
      expect(init.headers['tr_cd']).toBe('CSPAQ13700');
      const b = JSON.parse(init.body).CSPAQ13700InBlock1;
      expect(b.IsuNo).toBe('A005930'); expect(b.OrdDt).toBe('20260807');
      return { json: { rsp_cd: '00000', CSPAQ13700OutBlock2: { BuyOrdQty: 1, BuyExecQty: 1, SellOrdQty: 0, SellExecQty: 0 } } };
    });
    const r = await queryLSKROrderExec(cfg, 'T', { shcode: '005930', ordDate: '20260807', bnsTpCode: '2' });
    expect(r.ok).toBe(true);
    expect(r.buyOrdQty).toBe(1); expect(r.buyExecQty).toBe(1);
  });
  it('CSPAQ13700 조회실패/빈응답 → ok=false, 수량 0 (체결 오판 금지)', async () => {
    stubFetch(() => ({ json: { rsp_cd: 'IZAA100', rsp_msg: '조회오류' } }));
    const r = await queryLSKROrderExec(cfg, 'T', { shcode: '005930', ordDate: '20260807' });
    expect(r.ok).toBe(false);
    expect(r.buyExecQty).toBe(0);
  });
  it('CSPAT00801 현물취소 — 공식 InBlock(OrgOrdNo/IsuNo/OrdQty), rsp_cd 00156 정상', async () => {
    let sent: any = null;
    stubFetch((url, init) => {
      expect(init.headers['tr_cd']).toBe('CSPAT00801');
      sent = JSON.parse(init.body).CSPAT00801InBlock1;
      return { json: { rsp_cd: '00156', rsp_msg: '취소접수', CSPAT00801OutBlock2: { OrdNo: 84006 } } };
    });
    const r = await cancelLSKRBuyOrder(cfg, 'T', { orgOrdNo: '84005', shcode: '005930', qty: 1 });
    expect(sent).toMatchObject({ OrgOrdNo: 84005, IsuNo: 'A005930', OrdQty: 1 });
    expect(r.rspCd).toBe('00156');   // 취소 접수 = 정상(허용목록)
    expect(r.ordNo).toBe('84006');
  });
});

describe('lsOverseasChartRaw (진단 프로브)', () => {
  it('임의 TR 의 rsp_cd·OutBlock1·OutBlock 원문을 반환(빈 rsp_cd 도 그대로)', async () => {
    stubFetch(() => ({ json: { rsp_cd: '', rsp_msg: '', g3203OutBlock: { rec_count: 0 }, g3203OutBlock1: [] } }));
    const r = await lsOverseasChartRaw('T', 'g3203', { g3203InBlock: { symbol: 'AAPL' } });
    expect(r.rspCd).toBe('');            // 빈 rsp_cd 도 throw 없이 노출
    expect(r.out1).toEqual([]);
    expect(r.outBlock.rec_count).toBe(0);
    expect(r.diag.reqHeaders.tr_cd).toBe('g3203');
  });
});

describe('delaygb 파라미터 (하드코딩 금지, g3101·g3203 동일 적용)', () => {
  it('g3101/g3203 모두 호출측 delaygb 값을 그대로 전송', async () => {
    stubFetch((url, init) => {
      const body = JSON.parse(init.body);
      if (url.includes('/market-data')) {
        expect(body.g3101InBlock.delaygb).toBe('DL');   // 임의 지연코드 예시 — 하드코딩 R 아님
        return { json: { rsp_cd: '00000', g3101OutBlock: { price: '10', open: '10', high: '10', low: '10', volume: 1 } } };
      }
      expect(body.g3203InBlock.delaygb).toBe('DL');
      return { json: { rsp_cd: '00000', g3203OutBlock: { rec_count: 0 }, g3203OutBlock1: [] } };
    });
    await getLSUSPrice(cfg, 'T', 'AAPL', '82', 'DL');
    await getLSUS15Min(cfg, 'T', 'AAPL', '82', 'DL', { sdate: '20260727' });
  });
});
