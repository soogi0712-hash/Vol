import { describe, it, expect, vi, beforeEach } from 'vitest';

// ls-api.lsDomesticChartRaw 를 목킹해 fetchKRDaily 의 DATE_WINDOW 페이징 로직(누적/dedup/진전판정/진행봉분리)만 검증.
// (네트워크/토큰 없이 순수 페이징 제어흐름 검증 — 실계정 호출 아님)
const calls: Array<{ trCd: string; inBlock: any }> = [];
vi.mock('../src/lib/ls-api', () => ({
  lsDomesticChartRaw: vi.fn(async (_token: string, trCd: string, inBlock: any) => {
    calls.push({ trCd, inBlock });
    const ib = inBlock.t8413InBlock;
    const edate: string = ib.edate;
    // edate 에 따라 서로 다른 '창'을 반환: 첫 창은 최근, 이후 창은 과거로. 각 창 3봉(겹침 1봉으로 dedup 확인).
    const mk = (d: string, c: number) => ({ date: d, open: c, high: c + 5, low: c - 5, close: c, jdiff_vol: 1000, value: (c * 1000) / 1_000_000 });
    if (edate >= '20260810') return { rspCd: '00000', rspMsg: '', out1: [mk('20260810', 100), mk('20260811', 101), mk('20260812', 102)], outBlock: {}, diag: { trCont: 'N', trContKey: '' } };
    if (edate >= '20260809') return { rspCd: '00000', rspMsg: '', out1: [mk('20260808', 98), mk('20260809', 99), mk('20260810', 100)], outBlock: {}, diag: { trCont: 'N', trContKey: '' } };
    return { rspCd: '00000', rspMsg: '', out1: [], outBlock: {}, diag: { trCont: 'N', trContKey: '' } };
  }),
}));

import { fetchKRDaily } from '../local-runner/yeokmae/kr-daily';

beforeEach(() => { calls.length = 0; });

describe('P0-32C fetchKRDaily — DATE_WINDOW 페이징 제어흐름', () => {
  it('여러 창을 누적하고 겹침 date 는 dedup, 진전 없으면 중단', async () => {
    // 2026-08-12 17:00 KST (장 종료 후) → 오늘봉도 confirmed 승격
    const nowMs = Date.UTC(2026, 7, 12, 8, 0, 0);
    const res = await fetchKRDaily('tok', '005930', { nowMs, targetBars: 6, windowDays: 5, maxPages: 5 });
    expect(res.ok).toBe(true);
    // 08~12 유니크 5봉(겹친 08-10 제거)
    expect(res.bars.map(b => b.date)).toEqual(['2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12']);
    expect(res.uniqueBars).toBe(5);
    // 세 번째 창은 빈 응답 → 중단(무한루프 없음)
    expect(res.pages.length).toBeLessThanOrEqual(4);
    // 장 종료 후이므로 전부 confirmed
    expect(res.confirmed).toBe(5);
    expect(res.provisional).toBe(0);
    // 정렬/오름차순
    expect(res.firstDate).toBe('2026-08-08');
    expect(res.lastDate).toBe('2026-08-12');
  });

  it('장중이면 오늘봉만 provisional', async () => {
    const nowMs = Date.UTC(2026, 7, 12, 5, 0, 0);   // 14:00 KST (마감 전)
    const res = await fetchKRDaily('tok', '005930', { nowMs, targetBars: 6, windowDays: 5, maxPages: 5 });
    expect(res.provisional).toBe(1);
    expect(res.bars.find(b => b.date === '2026-08-12')?.confirmed).toBe(false);
    expect(res.bars.find(b => b.date === '2026-08-11')?.confirmed).toBe(true);
  });

  it('rawTurnover 보존 + turnoverKRW 미단정(null)', async () => {
    const nowMs = Date.UTC(2026, 7, 12, 8, 0, 0);
    const res = await fetchKRDaily('tok', '005930', { nowMs, targetBars: 6, windowDays: 5, maxPages: 5 });
    const b = res.bars[0];
    expect(b.turnoverKRW).toBeNull();
    expect(b.rawTurnover).not.toBeNull();
    expect(res.sourceTR).toBe('t8413');
    expect(res.adjustment).toBe('ADJUSTED');
  });
});
