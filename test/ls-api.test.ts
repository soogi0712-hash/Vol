import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getLSAccessToken, getLSKRBalance, getLSUSBalance,
  getLSKRPrice, getLSUSPrice, getLSKR15Min, getLSUS15Min, getLSUS15MinPaged,
  getLSUSTicks, getLSUSTicksPaged, lsOverseasChartRaw,
  placeLSUSBuyOrder, queryLSUSOrderExec, getLSUSDeposit, getLSUSHoldings, cancelLSUSOrder, LS_CANCEL_TR_CONFIRMED,
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
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ ordNo: '141', symbol: 'TSLA', ordQty: 10, execQty: 4, unfilledQty: 6, ordPtnCode: '02' });
  });

  it('COSOQ02701 USD 예수금 조회 — USD 행의 PrsmptFcurrDps1', async () => {
    stubFetch((url, init) => {
      expect(init.headers['tr_cd']).toBe('COSOQ02701');
      return { json: { rsp_cd: '00000', COSOQ02701OutBlock2: [
        { CrcyCode: 'JPY', PrsmptFcurrDps1: '0.0000' },
        { CrcyCode: 'USD', PrsmptFcurrDps1: '3300.5000' },
      ] } };
    });
    const r = await getLSUSDeposit(cfg, 'T');
    expect(r.found).toBe(true);
    expect(r.usdDeposit).toBeCloseTo(3300.5);
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
