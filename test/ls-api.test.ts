import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getLSAccessToken, getLSKRBalance, getLSUSBalance,
  getLSKRPrice, getLSUSPrice, getLSKR15Min, getLSUS15Min,
  toLSOverseasExchcd, LSApiError, configureLSRateLimiter, classifyChart,
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
    expect(toLSOverseasExchcd('AMEX')).toBeNull();   // 미확인 → 추측 금지
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
    const r = await getLSUS15Min(cfg, 'T', 'TSLA', '82', 'R', '20260726', 120);
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
    const r = await getLSUS15Min(cfg, 'T', 'AAPL', '82', 'R', '20260727', 120);
    expect(r.candles).toEqual([]);
    expect(r.rawCount).toBe(0);
    expect(r.rspCd).toBe('00000');
    expect(r.outBlock.cts_date).toBe('20260806');    // 연속조회 필드 노출
    expect(r.outBlock.cts_time).toBe('093000');
    expect((r.reqBody as any).g3203InBlock.symbol).toBe('AAPL');   // 요청 body 진단
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
    const r = await getLSUS15Min(cfg, 'T', 'AAPL', '82', 'R', '20260727', 120);
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
    const r = await getLSUS15Min(cfg, 'T', 'TSLA', '82', 'R', '20260726', 120);
    expect(classifyChart(r)).toBe('OK');
    expect(r.candles.length).toBeGreaterThanOrEqual(40);   // 44 확정봉
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
    await getLSUS15Min(cfg, 'T', 'AAPL', '82', 'DL', '20260727', 120);
  });
});

describe('probeLSUSQuote (키 비교용 — throw 없이 rsp_cd 반환)', () => {
  it('빈 응답 {"rsp_cd":"","rsp_msg":""} → rsp_cd="", price=0', async () => {
    const { probeLSUSQuote } = await import('../src/lib/ls-api');
    stubFetch(() => ({ json: { rsp_cd: '', rsp_msg: '' } }));
    const p = await probeLSUSQuote('KRTOKEN', 'AAPL', '82', 'R');
    expect(p.rspCd).toBe('');
    expect(p.price).toBe(0);
    expect(p.diag).not.toBeNull();
  });
  it('정상 rsp_cd="00000" + price>0 → 그대로 반환(throw 안 함)', async () => {
    const { probeLSUSQuote } = await import('../src/lib/ls-api');
    stubFetch(() => ({ json: { rsp_cd: '00000', rsp_msg: '조회완료', g3101OutBlock: { price: '283.82' } } }));
    const p = await probeLSUSQuote('USTOKEN', 'AAPL', '82', 'R');
    expect(p.rspCd).toBe('00000');
    expect(p.price).toBeCloseTo(283.82);
  });
});
