// P0-32C — (1) KR DATE_WINDOW 페이징이 269봉/창 에서 700+봉 누적함을 실증, (2) US probe 근거-우선 조합 검증.
import { describe, it, expect } from 'vitest';
import { windowedDailyFetch, addDaysYmd, type RawChartResp } from '../local-runner/yeokmae/daily-window';
import { KR_DAILY_TR } from '../local-runner/yeokmae/daily-tr-config';
import { buildUSProbeCombos } from '../local-runner/yeokmae/us-daily-probe';

// 실측 재현: t8413 는 한 창당 ~269행(edate 기준 최근구간)만 반환. edate 를 과거로 밀어 누적해야 600/700 도달.
function krPage(edateYmd: string, n = 269): any[] {
  const rows: any[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = addDaysYmd(edateYmd, -i);
    const close = 60000 + (Number(date) % 997);
    rows.push({ date, open: close - 100, high: close + 200, low: close - 200, close, jdiff_vol: 1_000_000 + i, value: 894743 + i });
  }
  return rows;
}
const resp = (out1: any[]): RawChartResp => ({ rspCd: '00000', rspMsg: '', out1, outBlock: {}, diag: { trCont: '', trContKey: '' } });

describe('P0-32C KR windowedDailyFetch — 269봉/창 → 700+ 누적 실증', () => {
  it('269행/창을 edate 후퇴로 누적 → targetBars=700 달성, 중복 제거, 오름차순', async () => {
    let calls = 0;
    const r = await windowedDailyFetch({
      callPage: async (_sdate, edate) => { calls++; return resp(krPage(edate, 269)); },
      fieldMap: KR_DAILY_TR.fieldMap, successCodes: ['00000'],
      startEdateYmd: '20260814', targetBars: 700, windowDays: 1500, maxPages: 10,
    });
    expect(r.ok).toBe(true);
    expect(r.barsRaw.length).toBeGreaterThanOrEqual(700);   // ⚠️ 700+ 확보(269 단일창으로는 불가)
    expect(calls).toBeGreaterThanOrEqual(3);                // 269×3 ≈ 807
    expect(calls).toBeLessThanOrEqual(4);
    // 중복 없음
    const uniq = new Set(r.barsRaw.map(b => b.date));
    expect(uniq.size).toBe(r.barsRaw.length);
    // 오름차순 정렬
    for (let i = 1; i < r.barsRaw.length; i++) expect(r.barsRaw[i].date >= r.barsRaw[i - 1].date).toBe(true);
  });

  it('진전 없음(동일 창 반복) → 무한루프 없이 중단(동일봉 반복=성공 오판 금지)', async () => {
    let calls = 0;
    const fixed = krPage('20260814', 269);   // edate 무시하고 항상 같은 269행
    const r = await windowedDailyFetch({
      callPage: async () => { calls++; return resp(fixed); },
      fieldMap: KR_DAILY_TR.fieldMap, successCodes: ['00000'],
      startEdateYmd: '20260814', targetBars: 700, windowDays: 1500, maxPages: 10,
    });
    expect(r.ok).toBe(true);
    expect(r.barsRaw.length).toBe(269);          // 더 못 늘림
    expect(calls).toBeLessThanOrEqual(2);         // 진전 없음 감지 후 즉시 중단
  });

  it('rsp_cd 비성공 → fail-closed(추측 성공 금지)', async () => {
    const r = await windowedDailyFetch({
      callPage: async () => ({ rspCd: 'IZAA', rspMsg: '오류', out1: [], outBlock: {}, diag: { trCont: '', trContKey: '' } }),
      fieldMap: KR_DAILY_TR.fieldMap, successCodes: ['00000'], startEdateYmd: '20260814', targetBars: 700, windowDays: 1500, maxPages: 5,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('RSP_CD_NOT_SUCCESS');
  });
});

describe('P0-32C US probe 조합 — 근거 우선순위, brute-force 금지', () => {
  const combos = buildUSProbeCombos({ exchcd: '82', symbol: 'AAPL', keysymbol: '82AAPL', delaygb: 'R', sdate: '20220101', edate: '20260814' });

  it('1순위 = 확정후보 g3204/gubun=2/plain/range (symbol=plain, keysymbol prefixed)', () => {
    const first = combos[0];
    expect(first.tr).toBe('g3204');
    expect(first.inBlock.gubun).toBe('2');
    expect(first.inBlock.symbol).toBe('AAPL');       // plain(‑ prefixed 아님)
    expect(first.inBlock.keysymbol).toBe('82AAPL');  // keysymbol 만 prefixed
    expect(first.inBlock.sdate).toBe('20220101');
    expect(first.priority).toBe(1);
  });

  it('gubun 은 문서 존재값 {0,1,2} 만 — 임의 3~9 brute-force 없음', () => {
    const gubuns = new Set(combos.map(c => String(c.inBlock.gubun)));
    for (const g of gubuns) expect(['0', '1', '2']).toContain(g);
  });

  it('TR 은 g3103/g3204 만(overseas-chart 일봉류), 필드는 공용필드만', () => {
    for (const c of combos) {
      expect(['g3103', 'g3204']).toContain(c.tr);
      const keys = Object.keys(c.inBlock).sort();
      expect(keys).toEqual(['comp_yn', 'delaygb', 'edate', 'exchcd', 'gubun', 'keysymbol', 'qrycnt', 'sdate', 'symbol']);
    }
  });

  it('우선순위 오름차순 정렬 + prefixed(반증)는 최하위', () => {
    for (let i = 1; i < combos.length; i++) expect(combos[i].priority >= combos[i - 1].priority).toBe(true);
    const prefixed = combos.find(c => c.inBlock.symbol === '82AAPL');
    expect(prefixed).toBeTruthy();
    expect(prefixed!.priority).toBe(Math.max(...combos.map(c => c.priority)));
  });
});
