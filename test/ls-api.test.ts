import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLSAccessToken, getLSKRBalance, getLSUSBalance } from '../src/lib/ls-api';

// global fetch 스텁 — LS 엔드포인트별 응답 제어
let calls: Array<{ url: string; init: any }>;
function stubFetch(handler: (url: string, init: any) => { status?: number; json: any }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.json,
      text: async () => JSON.stringify(r.json),
    } as any;
  }));
}
beforeEach(() => { calls = []; });
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
