import { describe, it, expect } from 'vitest';
import { classifyUSSymbol, isDerivedUSSymbol, buildUSUniverse, loadUSUniverse, selectUSLiveCandidate, probeUSMasterExgubun, exgubunWithNyseAmex } from '../local-runner/us-universe';
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

  it('P0-23 continuation: 공식 헤더(tr_cont/tr_cont_key)로 페이징 + tr_cont≠Y 에서 정상 종료', async () => {
    const conts: string[] = []; const keys: string[] = []; const stops: (string | null)[] = [];
    let call = 0;
    const page = async (_c: any, _t: string, p: { exgubun: string; trCont?: string; trContKey?: string }) => {
      call++; conts.push(p.trCont ?? ''); keys.push(p.trContKey ?? '');
      if (call === 1) return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 2, ctsValue: '', resTrCont: 'Y', resTrContKey: 'KEY1', rows: [row({ keysymbol: '82AAPL', symbol: 'AAPL' }), row({ keysymbol: '82MSFT', symbol: 'MSFT' })] };
      return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 1, ctsValue: '', resTrCont: 'N', resTrContKey: '', rows: [row({ keysymbol: '81BA', symbol: 'BA', exchcd: '81', market: 'NYSE_AMEX' })] };
    };
    const u = await loadUSUniverse({} as any, 'T', ['2'], page as any, { readcnt: 2, onPage: (i) => stops.push(i.stop) });
    expect(conts).toEqual(['N', 'Y']);        // page2 는 헤더 tr_cont='Y'
    expect(keys).toEqual(['', 'KEY1']);       // page2 는 이전 응답 tr_cont_key
    expect(stops[1]).toBe('DONE(tr_cont≠Y)'); // 공식 종료 신호
    expect(u.total).toBe(3);
    expect(u.ok).toBe(true); expect(u.complete).toBe(true);
  });
  it('P0-23 실계정 버그 재현: tr_cont_key 가 상수 "0" 이어도 newRows>0 면 계속 페이징(STUCK 오판 금지)', async () => {
    let call = 0; const news: number[] = [];
    const constKey = async (_c: any, _t: string, p: { exgubun: string; trContKey?: string }) => {
      call++;
      if (call <= 3) return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 2, ctsValue: '', resTrCont: 'Y', resTrContKey: '0', rows: [row({ keysymbol: '82A' + call, symbol: 'A' + call }), row({ keysymbol: '82B' + call, symbol: 'B' + call })] };
      return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 0, ctsValue: '', resTrCont: 'N', resTrContKey: '0', rows: [] };
    };
    const u = await loadUSUniverse({} as any, 'T', ['2'], constKey as any, { readcnt: 2, onPage: (i) => news.push(i.newRows) });
    expect(call).toBe(4);                 // ★ tr_cont_key='0' 고정이지만 newRows>0 이라 page2,3 진행 → page4 에서 tr_cont=N 종료
    expect(news.slice(0, 3)).toEqual([2, 2, 2]);
    expect(u.total).toBe(6);              // 3페이지 × 2 신규
    expect(u.ok).toBe(true); expect(u.complete).toBe(true);
  });
  it('P0-25 중복 exgubun: page1 전부 중복(newRows=0) → REDUNDANT_EXGUBUN 정상종료, complete 유지', async () => {
    // exgubun '2' 가 먼저 AAPL/MSFT 로드 → exgubun '4' 는 같은 종목만 반환(전부 중복) → 미완료로 처리하면 안 됨
    const page = async (_c: any, _t: string, p: { exgubun: string }) => {
      if (p.exgubun === '2') return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 1, ctsValue: '', resTrCont: 'N', resTrContKey: '', rows: [row({ keysymbol: '82AAPL', symbol: 'AAPL', exchcd: '82', market: 'NASDAQ' })] };
      if (p.exgubun === '1') return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 1, ctsValue: '', resTrCont: 'N', resTrContKey: '', rows: [row({ keysymbol: '81BA', symbol: 'BA', exchcd: '81', market: 'NYSE_AMEX' })] };
      return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 1, ctsValue: '', resTrCont: 'Y', resTrContKey: '0', rows: [row({ keysymbol: '82AAPL', symbol: 'AAPL', exchcd: '82', market: 'NASDAQ' })] };   // exgubun '4' = 중복
    };
    const stops: (string | null)[] = [];
    const u = await loadUSUniverse({} as any, 'T', ['2', '1', '4'], page as any, { readcnt: 1, onPage: (i) => stops.push(i.stop) });
    expect(u.total).toBe(2);                                  // AAPL, BA (4의 AAPL 은 중복)
    expect(u.eligiblePerExchange.NASDAQ).toBe(1);
    expect(u.eligiblePerExchange.NYSE_AMEX).toBe(1);
    expect(stops.at(-1)).toBe('REDUNDANT_EXGUBUN(newRows=0)');
    expect(u.complete).toBe(true);                           // ★ 중복 exgubun 이 정상완료를 무효화하지 않음(요구 4)
  });
  it('P0-25 실측 반영: 2(NASDAQ)+1(NYSE)+3(NYSE) 각각 공식 DONE → complete=true, 두 시장 다 존재', async () => {
    const page = async (_c: any, _t: string, p: { exgubun: string }) => {
      const map: Record<string, LSUSMasterRow[]> = {
        '2': [row({ keysymbol: '82AAPL', symbol: 'AAPL', exchcd: '82', market: 'NASDAQ' })],
        '1': [row({ keysymbol: '81BA', symbol: 'BA', exchcd: '81', market: 'NYSE_AMEX' })],
        '3': [row({ keysymbol: '81GE', symbol: 'GE', exchcd: '81', market: 'NYSE_AMEX' })],
      };
      return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 1, ctsValue: '', resTrCont: 'N', resTrContKey: '', rows: map[p.exgubun] ?? [] };
    };
    const u = await loadUSUniverse({} as any, 'T', ['2', '1', '3'], page as any, {});
    expect(u.total).toBe(3);
    expect(u.eligiblePerExchange.NASDAQ).toBe(1);
    expect(u.eligiblePerExchange.NYSE_AMEX).toBe(2);
    expect(u.complete).toBe(true);
  });
  it('P0-23 anti-hang: maxPages 상한 → complete=false (미완료로 표기)', async () => {
    let call = 0;
    const infinite = async () => { call++; return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 2, ctsValue: '', resTrCont: 'Y', resTrContKey: 'K' + call, rows: [row({ keysymbol: '82S' + call, symbol: 'S' + call }), row({ keysymbol: '82T' + call, symbol: 'T' + call })] }; };
    const u = await loadUSUniverse({} as any, 'T', ['2'], infinite as any, { readcnt: 2, maxPages: 5 });
    expect(call).toBe(5);
    expect(u.complete).toBe(false);   // 상한 = 전체 못 읽음
  });
  it('P0-23 anti-hang: 요청 실패(타임아웃) → ok=false + complete=false + 조회실패 note', async () => {
    const boom = async () => { throw new Error('타임아웃(10000ms 초과)'); };
    const u = await loadUSUniverse({} as any, 'T', ['2'], boom as any, {});
    expect(u.ok).toBe(false); expect(u.complete).toBe(false);
    expect(u.note).toMatch(/조회실패/);
  });
  it('P0-23 다시장: exgubun 여러 값 로드 시 NASDAQ+NYSE_AMEX 병합', async () => {
    const page = async (_c: any, _t: string, p: { exgubun: string }) => {
      if (p.exgubun === '2') return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 1, ctsValue: '', resTrCont: 'N', resTrContKey: '', rows: [row({ keysymbol: '82AAPL', symbol: 'AAPL', exchcd: '82', market: 'NASDAQ' })] };
      return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 1, ctsValue: '', resTrCont: 'N', resTrContKey: '', rows: [row({ keysymbol: '81BA', symbol: 'BA', exchcd: '81', market: 'NYSE_AMEX' })] };
    };
    const u = await loadUSUniverse({} as any, 'T', ['2', '3'], page as any, {});
    expect(u.eligiblePerExchange.NASDAQ).toBe(1);
    expect(u.eligiblePerExchange.NYSE_AMEX).toBe(1);
    expect(u.complete).toBe(true);
  });
});

describe('P0-25 exgubun 실측 탐색(추측 금지)', () => {
  const rowE = (exchcd: string, symbol: string): LSUSMasterRow => row({ exchcd, symbol, keysymbol: exchcd + symbol, market: exchcd === '82' ? 'NASDAQ' : 'NYSE_AMEX' });
  it('후보 exgubun 별 첫 페이지 1회 조회 → exchcd81/82 분포 집계', async () => {
    const calls: string[] = [];
    const page = async (_c: any, _t: string, p: { exgubun: string; trCont?: string }) => {
      calls.push(`${p.exgubun}:${p.trCont}`);
      if (p.exgubun === '2') return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 2, ctsValue: '', resTrCont: 'Y', resTrContKey: '0', rows: [rowE('82', 'AAPL'), rowE('82', 'MSFT')] };
      if (p.exgubun === '3') return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 2, ctsValue: '', resTrCont: 'Y', resTrContKey: '0', rows: [rowE('81', 'BA'), rowE('81', 'GE')] };
      return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 0, ctsValue: '', resTrCont: 'N', resTrContKey: '', rows: [] };
    };
    const probes = await probeUSMasterExgubun({} as any, 'T', ['2', '3', '4'], page as any, { readcnt: 100 });
    expect(calls).toEqual(['2:N', '3:N', '4:N']);   // 각 후보 첫 페이지 1회(trCont='N')
    expect(probes[0]).toMatchObject({ exgubun: '2', exchcd82: 2, exchcd81: 0 });
    expect(probes[1]).toMatchObject({ exgubun: '3', exchcd81: 2, exchcd82: 0 });
    expect(probes[0].sampleSymbols).toContain('AAPL(82)');
    // exchcd81(NYSE/AMEX) 반환 값 = '3'
    expect(exgubunWithNyseAmex(probes)).toEqual(['3']);
  });
  it('조회 실패 후보는 error 기록(다음 후보 계속)', async () => {
    const page = async (_c: any, _t: string, p: { exgubun: string }) => {
      if (p.exgubun === '1') throw new Error('타임아웃');
      return { rspCd: '00000', rspMsg: '', diag: {} as any, recCount: 1, ctsValue: '', resTrCont: 'N', resTrContKey: '', rows: [rowE('82', 'AAPL')] };
    };
    const probes = await probeUSMasterExgubun({} as any, 'T', ['1', '2'], page as any, {});
    expect(probes[0].error).toMatch(/타임아웃/);
    expect(probes[1].exchcd82).toBe(1);
  });
});

describe('P0-23 LIVE 후보 선정(요구 11) — AAPL 하드코딩 제거', () => {
  const ranked = [
    { symbol: 'TSLA', exchcd: '82', rank: 1, score: 999 },
    { symbol: 'NVDA', exchcd: '82', rank: 2, score: 500 },
    { symbol: 'BA', exchcd: '81', rank: 3, score: 100 },
  ];
  it('랭킹 1위가 준비완료+미보유+한도내+예산가능 → 선택', () => {
    const sel = selectUSLiveCandidate(ranked, () => ({ warmedUp: true, hasPending: false, dailyExhausted: false, budgetEligible: true }));
    expect(sel).toEqual({ symbol: 'TSLA', exchcd: '82', rank: 1 });
  });
  it('1위가 warm-up 미완/pending/한도소진이면 다음 순위로', () => {
    const sel = selectUSLiveCandidate(ranked, (s) => s === 'TSLA'
      ? { warmedUp: false, hasPending: false, dailyExhausted: false, budgetEligible: true }   // 1위 warm-up 미완
      : { warmedUp: true, hasPending: false, dailyExhausted: false, budgetEligible: true });
    expect(sel?.symbol).toBe('NVDA');
  });
  it('모두 부적격 → null(AAPL 로 폴백하지 않음)', () => {
    const sel = selectUSLiveCandidate(ranked, () => ({ warmedUp: false, hasPending: false, dailyExhausted: false, budgetEligible: true }));
    expect(sel).toBeNull();
  });
  it('pending 있으면 그 종목은 건너뜀(동일 주문 방지)', () => {
    const sel = selectUSLiveCandidate(ranked, (s) => ({ warmedUp: true, hasPending: s === 'TSLA', dailyExhausted: false, budgetEligible: true }));
    expect(sel?.symbol).toBe('NVDA');
  });
  // ── P0-29B: 예산으로 최소 1주 못 사는 종목(budgetEligible=false) 제외 ──
  it('P0-29B: 1위가 예산부적격(budgetQty=0, 예: AAPL $305/예산$60)이면 다음 BUY 후보 선택', () => {
    const sel = selectUSLiveCandidate(ranked, (s) => s === 'TSLA'
      ? { warmedUp: true, hasPending: false, dailyExhausted: false, budgetEligible: false }   // 1위 예산부적격
      : { warmedUp: true, hasPending: false, dailyExhausted: false, budgetEligible: true });   // 2위 예산가능
    expect(sel?.symbol).toBe('NVDA');
  });
  it('P0-29B: 모든 후보가 예산부적격 → null(강제 주문 안 함)', () => {
    const sel = selectUSLiveCandidate(ranked, () => ({ warmedUp: true, hasPending: false, dailyExhausted: false, budgetEligible: false }));
    expect(sel).toBeNull();
  });
});
