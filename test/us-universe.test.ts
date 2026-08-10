import { describe, it, expect } from 'vitest';
import { classifyUSSymbol, isDerivedUSSymbol, buildUSUniverse, loadUSUniverse, selectUSLiveCandidate } from '../local-runner/us-universe';
import type { LSUSMasterRow } from '../src/lib/ls-api';

function row(o: Partial<LSUSMasterRow> = {}): LSUSMasterRow {
  return {
    keysymbol: '82AAPL', symbol: 'AAPL', exchcd: '82', market: 'NASDAQ',
    engname: 'APPLE INC', korname: '애플', currency: 'USD',
    prevClose: 230, suspend: false, sellOnly: false, delisting: false, expireDate: '00000000',
    listedDate: '19801212', marketcap: 3500000, ...o,
  };
}

describe('P0-23 US 유니버스 eligibility 필터', () => {
  it('정상 보통주(AAPL) → eligible', () => {
    expect(classifyUSSymbol(row())).toEqual({ eligible: true, reasons: [] });
  });
  it('거래정지(suspend=Y) → 제외', () => {
    expect(classifyUSSymbol(row({ suspend: true })).reasons).toContain('SUSPENDED');
  });
  it('정리매매/매도전용(sellonly≠0) → 제외', () => {
    expect(classifyUSSymbol(row({ sellOnly: true })).reasons).toContain('SELL_ONLY');
  });
  it('상폐예정(expire_date≠00000000) → 제외', () => {
    expect(classifyUSSymbol(row({ delisting: true, expireDate: '20260930' })).reasons).toContain('DELISTING');
  });
  it('가격 0 → 제외', () => {
    expect(classifyUSSymbol(row({ prevClose: 0 })).reasons).toContain('NO_PRICE');
  });
  it('유닛/워런트/우선주 심볼 접미 → DERIVED 제외(기본), 해제 옵션', () => {
    expect(isDerivedUSSymbol('AACBU')).toBe(true);   // unit
    expect(isDerivedUSSymbol('BRK.A')).toBe(true);   // dot
    expect(isDerivedUSSymbol('AAPL')).toBe(false);
    expect(classifyUSSymbol(row({ symbol: 'AACBU' })).reasons).toContain('DERIVED');
    expect(classifyUSSymbol(row({ symbol: 'AACBU' }), { excludeDerivedSymbols: false }).eligible).toBe(true);
  });
  it('NYSE(exchcd 81) 보통주도 eligible', () => {
    expect(classifyUSSymbol(row({ symbol: 'BA', exchcd: '81', market: 'NYSE_AMEX' })).eligible).toBe(true);
  });

  it('buildUSUniverse — total/eligible/제외사유/거래소별 집계', () => {
    const rows = [
      row({ keysymbol: '82AAPL', symbol: 'AAPL' }),
      row({ keysymbol: '81BA', symbol: 'BA', exchcd: '81', market: 'NYSE_AMEX' }),
      row({ keysymbol: '82HALT', symbol: 'HALT', suspend: true }),
      row({ keysymbol: '82AACBU', symbol: 'AACBU' }),          // derived
      row({ keysymbol: '82ZERO', symbol: 'ZERO', prevClose: 0 }),
    ];
    const u = buildUSUniverse(rows, {});
    expect(u.total).toBe(5);
    expect(u.eligible.map(r => r.symbol).sort()).toEqual(['AAPL', 'BA']);
    expect(u.excluded).toBe(3);
    expect(u.excludedByReason.SUSPENDED).toBe(1);
    expect(u.excludedByReason.DERIVED).toBe(1);
    expect(u.perExchange.NASDAQ).toBe(4);
    expect(u.perExchange.NYSE_AMEX).toBe(1);
    expect(u.eligiblePerExchange.NASDAQ).toBe(1);
    expect(u.eligiblePerExchange.NYSE_AMEX).toBe(1);
  });

  it('P0-23 anti-hang: cts_value 안 바뀌면 무한루프 아니라 CTS_UNCHANGED 로 종료', async () => {
    let call = 0; const stops: (string | null)[] = [];
    const stuck = async (_c: any, _t: string, p: { exgubun: string; ctsValue?: string }) => {
      call++;
      return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 2, ctsValue: 'SAME', rows: [row({ keysymbol: '82A' + call, symbol: 'A' + call }), row({ keysymbol: '82B' + call, symbol: 'B' + call })] };
    };
    const u = await loadUSUniverse({} as any, 'T', ['2'], stuck as any, { readcnt: 2, onPage: (i) => stops.push(i.stop) });
    expect(call).toBe(2);                     // ★ page1(cts='')→page2(cts='SAME')→ 같은 cts 반복 감지 종료
    expect(stops[1]).toBe('CTS_UNCHANGED');   // 무한루프 아님
    expect(u.ok).toBe(true);
  });
  it('P0-23 anti-hang: rows<readcnt → LAST_PAGE 로 종료(1페이지)', async () => {
    let call = 0;
    const last = async () => { call++; return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 1, ctsValue: 'X', rows: [row({ keysymbol: '82AAPL', symbol: 'AAPL' })] }; };
    const u = await loadUSUniverse({} as any, 'T', ['2'], last as any, { readcnt: 500 });
    expect(call).toBe(1);
    expect(u.eligible.length).toBe(1);
  });
  it('P0-23 anti-hang: maxPages 상한 도달 시 종료(무한 아님)', async () => {
    let call = 0;
    const infinite = async () => { call++; return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 2, ctsValue: 'C' + call, rows: [row({ keysymbol: '82S' + call, symbol: 'S' + call }), row({ keysymbol: '82T' + call, symbol: 'T' + call })] }; };
    const u = await loadUSUniverse({} as any, 'T', ['2'], infinite as any, { readcnt: 2, maxPages: 5 });
    expect(call).toBe(5);   // ★ cts 매번 달라도 maxPages 에서 종료
    expect(u.ok).toBe(true);
  });
  it('P0-23 anti-hang: 요청 실패(타임아웃 등) → ok=false + 조회실패 note (무한대기 아님)', async () => {
    const boom = async () => { throw new Error('타임아웃(10000ms 초과)'); };
    const u = await loadUSUniverse({} as any, 'T', ['2'], boom as any, {});
    expect(u.ok).toBe(false);
    expect(u.note).toMatch(/조회실패/);
  });

  it('loadUSUniverse — cts_value 페이징 + keysymbol dedup', async () => {
    let call = 0;
    const fakePage = async (_c: any, _t: string, p: { exgubun: string; ctsValue?: string }) => {
      call++;
      if (p.ctsValue === '' || p.ctsValue == null) return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 2, ctsValue: 'PAGE2', rows: [row({ keysymbol: '82AAPL', symbol: 'AAPL' }), row({ keysymbol: '82MSFT', symbol: 'MSFT' })] };
      return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 1, ctsValue: '0000', rows: [row({ keysymbol: '82MSFT', symbol: 'MSFT' }), row({ keysymbol: '81BA', symbol: 'BA', exchcd: '81', market: 'NYSE_AMEX' })] };
    };
    const u = await loadUSUniverse({} as any, 'T', ['2'], fakePage as any, { readcnt: 2 });
    expect(call).toBe(2);                 // page1(cts='',2행)→page2(cts=PAGE2,2행)→cts=0000 종료
    expect(u.total).toBe(3);              // AAPL, MSFT(dedup), BA
    expect(u.eligible.length).toBe(3);
  });
});

describe('P0-23 LIVE 후보 선정(요구 11) — AAPL 하드코딩 제거', () => {
  const ranked = [
    { symbol: 'TSLA', exchcd: '82', rank: 1, score: 999 },
    { symbol: 'NVDA', exchcd: '82', rank: 2, score: 500 },
    { symbol: 'BA', exchcd: '81', rank: 3, score: 100 },
  ];
  it('랭킹 1위가 준비완료+미보유+한도내 → 선택', () => {
    const sel = selectUSLiveCandidate(ranked, () => ({ warmedUp: true, hasPending: false, dailyExhausted: false }));
    expect(sel).toEqual({ symbol: 'TSLA', exchcd: '82', rank: 1 });
  });
  it('1위가 warm-up 미완/pending/한도소진이면 다음 순위로', () => {
    const sel = selectUSLiveCandidate(ranked, (s) => s === 'TSLA'
      ? { warmedUp: false, hasPending: false, dailyExhausted: false }   // 1위 warm-up 미완
      : { warmedUp: true, hasPending: false, dailyExhausted: false });
    expect(sel?.symbol).toBe('NVDA');
  });
  it('모두 부적격 → null(AAPL 로 폴백하지 않음)', () => {
    const sel = selectUSLiveCandidate(ranked, () => ({ warmedUp: false, hasPending: false, dailyExhausted: false }));
    expect(sel).toBeNull();
  });
  it('pending 있으면 그 종목은 건너뜀(동일 주문 방지)', () => {
    const sel = selectUSLiveCandidate(ranked, (s) => ({ warmedUp: true, hasPending: s === 'TSLA', dailyExhausted: false }));
    expect(sel?.symbol).toBe('NVDA');
  });
});
