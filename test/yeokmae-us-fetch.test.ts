import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeDailyRows } from '../src/lib/yeokmae';
import { US_DAILY_TR } from '../local-runner/yeokmae/daily-tr-config';

// P0-32D probe 실측 샘플행(AAPL g3204 OutBlock1)
const US_SAMPLE = { date: '20240814', open: 220, high: 223, low: 219, close: 221, volume: 40000000, amount: 8840000, jongchk: 0, prtt_rate: '0.00', pricechk: 0, ratevalue: 0, sign: '2' };

describe('P0-32D US field map — 실측 샘플 정규화', () => {
  it('g3204 실측행 → OHLCV + rawTurnover(amount)', () => {
    const r = normalizeDailyRows([US_SAMPLE], US_DAILY_TR.fieldMap);
    expect(r.ok).toBe(true);
    const c = r.candles[0];
    expect(c.date).toBe('2024-08-14');
    expect(c.open).toBe(220); expect(c.high).toBe(223); expect(c.low).toBe(219); expect(c.close).toBe(221);
    expect(c.volume).toBe(40000000);   // volume
    expect(c.turnover).toBe(8840000);  // amount(raw, 통화/단위 미단정)
  });
});

const calls: any[] = [];
vi.mock('../src/lib/ls-api', () => ({
  lsOverseasChartRaw: vi.fn(async (_t: string, trCd: string, inBlock: any) => {
    calls.push({ trCd, inBlock });
    const edate: string = inBlock.g3204InBlock.edate;
    const mk = (d: string, c: number) => ({ date: d, open: c, high: c + 2, low: c - 2, close: c, volume: 1000, amount: c * 1000 });
    if (edate >= '20260810') return { rspCd: '00000', rspMsg: '조회완료', out1: [mk('20260810', 100), mk('20260811', 101), mk('20260812', 102)], outBlock: {}, diag: { trCont: 'N', trContKey: '' } };
    if (edate >= '20260809') return { rspCd: '00000', rspMsg: '조회완료', out1: [mk('20260808', 98), mk('20260809', 99), mk('20260810', 100)], outBlock: {}, diag: { trCont: 'N', trContKey: '' } };
    return { rspCd: '00000', rspMsg: '조회완료', out1: [], outBlock: {}, diag: { trCont: 'N', trContKey: '' } };
  }),
}));

import { fetchUSDaily } from '../local-runner/yeokmae/us-daily';
beforeEach(() => { calls.length = 0; });

describe('P0-32D fetchUSDaily — DATE_WINDOW 페이징 + 진행봉 분리', () => {
  it('여러 창 누적/dedup, 진전 없으면 중단, plain symbol 사용', async () => {
    const nowMs = Date.UTC(2026, 7, 12, 21, 0, 0);   // 17:00 ET (16:30 이후 종료)
    const res = await fetchUSDaily('tok', { symbol: 'AAPL', exchcd: '82', delaygb: 'R' }, { nowMs, targetBars: 6, windowDays: 5, maxPages: 5 });
    expect(res.ok).toBe(true);
    expect(res.sourceTR).toBe('g3204');
    expect(res.adjustment).toBe('UNKNOWN');
    expect(res.bars.map(b => b.date)).toEqual(['2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12']);
    expect(res.uniqueBars).toBe(5);
    expect(calls[0].inBlock.g3204InBlock.symbol).toBe('AAPL');       // plain
    expect(calls[0].inBlock.g3204InBlock.keysymbol).toBe('82AAPL');  // keysymbol prefixed
    // 종료 후이므로 전부 confirmed
    expect(res.confirmed).toBe(5); expect(res.provisional).toBe(0);
  });
  it('장중이면 오늘봉만 provisional + rawTurnover(amount) 보존/turnoverKRW=null', async () => {
    const nowMs = Date.UTC(2026, 7, 12, 14, 0, 0);   // 10:00 ET (장중)
    const res = await fetchUSDaily('tok', { symbol: 'AAPL', exchcd: '82', delaygb: 'R' }, { nowMs, targetBars: 6, windowDays: 5, maxPages: 5 });
    expect(res.provisional).toBe(1);
    expect(res.bars.find(b => b.date === '2026-08-12')?.confirmed).toBe(false);
    expect(res.bars[0].turnoverKRW).toBeNull();
    expect(res.bars[0].rawTurnover).not.toBeNull();
  });
});
