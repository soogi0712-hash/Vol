// 미국(NASDAQ+NYSE+AMEX) 유니버스 로드 + eligibility 필터 + LIVE 후보 선정 (P0-23).
// LS 공식 해외 종목마스터(g3190)로 전 종목을 페이징 로드하고, 아래 기준으로 실거래 후보(eligible)를 선별한다.
//   기본 제외: 거래정지(suspend=Y), 정리매매/매도전용(sellonly≠0), 전일종가 0, 상폐예정(expire_date≠00000000).
//   ETF/ETN 은 옵션(includeEtf) — ⚠️ g3190 마스터에 ETF 확정 플래그가 없어(추측 금지) 심볼 휴리스틱만 적용.
//   우선주/유닛/워런트/권리(공식 구분): LS 심볼 접미(U=unit, W=warrant, R=right, P=preferred) 로 best-effort 제외.
import { getLSUSStockMasterPage, type LSConfig, type LSUSMasterRow } from '../src/lib/ls-api';

export interface USUniverseOpts { includeEtf?: boolean; excludeDerivedSymbols?: boolean; }
export interface USEligibility { eligible: boolean; reasons: string[]; }

// 유닛/워런트/권리/우선주 심볼 접미(공식 심볼 규칙). AAPL(정상)=false, AACBU(unit)=true 등.
export function isDerivedUSSymbol(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  if (s.includes('.') || s.includes('-') || s.includes('/')) return true;   // BRK.A, 우선주 표기 등
  return /(U|W|R|P)$/.test(s) && s.length >= 4;   // 접미 U/W/R/P (unit/warrant/right/preferred) — 4자 이상만
}

export function classifyUSSymbol(row: LSUSMasterRow, opts: USUniverseOpts = {}): USEligibility {
  const reasons: string[] = [];
  if (row.market !== 'NASDAQ' && row.market !== 'NYSE_AMEX') reasons.push('NON_US_EXCH');
  if (row.suspend) reasons.push('SUSPENDED');
  if (row.sellOnly) reasons.push('SELL_ONLY');       // 정리매매/매도전용
  if (row.delisting) reasons.push('DELISTING');       // 상폐예정(expire_date)
  if (!(row.prevClose > 0)) reasons.push('NO_PRICE'); // 가격 0
  if (opts.excludeDerivedSymbols !== false && isDerivedUSSymbol(row.symbol)) reasons.push('DERIVED');
  return { eligible: reasons.length === 0, reasons };
}

export interface USUniverse {
  ok: boolean;
  complete?: boolean;   // 모든 exgubun 이 공식 헤더 종료(tr_cont≠'Y')로 완료됐는가. continuation 오류/상한이면 false.
  total: number;
  eligible: LSUSMasterRow[];
  excluded: number;
  excludedByReason: Record<string, number>;
  perExchange: { NASDAQ: number; NYSE_AMEX: number; ETC: number };
  eligiblePerExchange: { NASDAQ: number; NYSE_AMEX: number; ETC: number };
  note: string;
}

// 마스터 행 배열 → 필터링된 유니버스(순수 함수, 테스트용).
export function buildUSUniverse(rows: LSUSMasterRow[], opts: USUniverseOpts = {}, ok = true, note = ''): USUniverse {
  const eligible: LSUSMasterRow[] = [];
  const excludedByReason: Record<string, number> = {};
  const perExchange = { NASDAQ: 0, NYSE_AMEX: 0, ETC: 0 };
  const eligiblePerExchange = { NASDAQ: 0, NYSE_AMEX: 0, ETC: 0 };
  for (const row of rows) {
    perExchange[row.market]++;
    const c = classifyUSSymbol(row, opts);
    if (c.eligible) { eligible.push(row); eligiblePerExchange[row.market]++; }
    else for (const reason of c.reasons) excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
  }
  return { ok, total: rows.length, eligible, excluded: rows.length - eligible.length, excludedByReason, perExchange, eligiblePerExchange, note };
}

// g3190 페이징 로드(cts_value 연속조회) → 전 종목 병합(keysymbol dedup) → 필터.
//   exgubunList: 공식 exgubun 값 목록(값 의미 미기재 → 주입). 각 값을 페이징 로드해 병합.
export interface USUniverseLoadOpts extends USUniverseOpts {
  maxPages?: number;      // exgubun 당 최대 페이지(무한루프 방지). 기본 60
  readcnt?: number;       // 페이지당 요청 행수. 기본 500
  timeoutMs?: number;     // g3190 요청당 타임아웃. 기본 10000
  onPage?: (info: { exgubun: string; page: number; trContIn: string; trContKeyIn: string; resTrCont: string; resTrContKey: string; rows: number; newRows: number; rspCd: string; stop: string | null }) => void;
}
export async function loadUSUniverse(
  cfg: LSConfig, token: string,
  exgubunList: string[],
  fetchPage: typeof getLSUSStockMasterPage = getLSUSStockMasterPage,
  opts: USUniverseLoadOpts = {},
): Promise<USUniverse> {
  const maxPages = opts.maxPages ?? 60;
  const readcnt = opts.readcnt ?? 500;
  const timeoutMs = opts.timeoutMs ?? 10000;
  const seen = new Map<string, LSUSMasterRow>();
  const notes: string[] = [];
  let ok = true;
  let complete = true;   // 공식 종료신호(resTrCont≠'Y') 또는 rows=0 로 끝나야 true. 중복/상한이면 false.
  for (const exgubun of exgubunList) {
    let trCont = 'N'; let trContKey = ''; let cts = '';
    let pages = 0; let rowsForGubun = 0;
    try {
      for (;;) {
        const r = await fetchPage(cfg, token, { exgubun, trCont, trContKey, ctsValue: cts, readcnt, timeoutMs });
        pages++;
        let newRows = 0;
        for (const row of r.rows) if (row.keysymbol && !seen.has(row.keysymbol)) { seen.set(row.keysymbol, row); newRows++; }
        rowsForGubun += r.rows.length;
        const resTrCont = (r.resTrCont ?? '').trim();
        const resTrContKey = (r.resTrContKey ?? '').trim();
        // ── 종료 판정 — tr_cont_key 동일 여부로 판단하지 않는다(값이 '0' 고정이어도 진행 가능). newRows/resTrCont 기준 ──
        //   ⚠️ P0-25: newRows=0(전부 중복)은 "이 exgubun 이 다른 exgubun 과 중복=redundant" 이므로 정상 종료로 본다.
        //     이미 공식 DONE 된 다른 exgubun 의 완료를 무효화하지 않는다(complete=false 아님). 하드 실패는 MAX_PAGES/예외뿐.
        let stop: string | null = null;
        if (r.rows.length === 0) stop = 'ROWS_0';                        // 빈 페이지 → 정상 종료
        else if (resTrCont !== 'Y') stop = 'DONE(tr_cont≠Y)';           // 공식 종료 신호(헤더) → 정상 완료
        else if (newRows === 0) stop = pages === 1 ? 'REDUNDANT_EXGUBUN(newRows=0)' : 'DUP_PAGE(newRows=0)';   // 전부 중복 → 정상 종료(미완료 아님)
        else if (pages >= maxPages) { stop = `MAX_PAGES(${maxPages})`; complete = false; }   // 상한(전체 다 못 읽음) → 진짜 미완료
        // ★ newRows>0 && resTrCont==='Y' 이면 tr_cont_key 가 같아도 다음 페이지 반드시 시도(요구 2·4)
        opts.onPage?.({ exgubun, page: pages, trContIn: trCont, trContKeyIn: trContKey, resTrCont, resTrContKey, rows: r.rows.length, newRows, rspCd: r.rspCd, stop });
        if (stop) break;
        trCont = 'Y'; trContKey = resTrContKey; cts = (r.ctsValue ?? '').trim();   // 공식 헤더 연속조회 계속
      }
      notes.push(`exgubun=${exgubun} pages=${pages} rows=${rowsForGubun}`);
    } catch (e) {
      ok = false; complete = false;
      notes.push(`exgubun=${exgubun} 조회실패:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const u = buildUSUniverse([...seen.values()], opts, ok, notes.join(' · '));
  return { ...u, complete };
}

// ── exgubun 실측 탐색(P0-25) — 추측 금지. 후보 exgubun 값별로 첫 페이지 1회만 조회해 exchcd 분포 확인 ──
//   exgubun=2 는 NASDAQ(82)만 반환됨이 실측 확인. exchcd=81(NYSE/AMEX)을 반환하는 exgubun 값을 찾는다.
export interface ExgubunProbe { exgubun: string; rows: number; exchcd81: number; exchcd82: number; otherExch: number; sampleSymbols: string[]; rspCd: string; error?: string; }
export async function probeUSMasterExgubun(
  cfg: LSConfig, token: string, candidates: string[],
  fetchPage: typeof getLSUSStockMasterPage = getLSUSStockMasterPage,
  opts: { readcnt?: number; timeoutMs?: number } = {},
): Promise<ExgubunProbe[]> {
  const out: ExgubunProbe[] = [];
  for (const exgubun of candidates) {
    try {
      const r = await fetchPage(cfg, token, { exgubun, trCont: 'N', trContKey: '', readcnt: opts.readcnt ?? 100, timeoutMs: opts.timeoutMs ?? 10000 });
      let e81 = 0, e82 = 0, other = 0; const sample: string[] = [];
      for (const row of r.rows) {
        if (row.exchcd === '81') e81++; else if (row.exchcd === '82') e82++; else other++;
        if (sample.length < 8) sample.push(`${row.symbol}(${row.exchcd})`);
      }
      out.push({ exgubun, rows: r.rows.length, exchcd81: e81, exchcd82: e82, otherExch: other, sampleSymbols: sample, rspCd: r.rspCd });
    } catch (e) {
      out.push({ exgubun, rows: 0, exchcd81: 0, exchcd82: 0, otherExch: 0, sampleSymbols: [], rspCd: '', error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
// 실측 결과 → exchcd81(NYSE/AMEX)을 반환한 exgubun 값 목록(중복 제거).
export function exgubunWithNyseAmex(probes: ExgubunProbe[]): string[] {
  return [...new Set(probes.filter(p => p.exchcd81 > 0).map(p => p.exgubun))];
}

// ── LIVE 후보 선정(요구 11) — AAPL 하드코딩 제거. 랭킹 1위부터 준비완료+eligible 후보를 선택 ──
export interface USCandidateReadiness { warmedUp: boolean; hasPending: boolean; dailyExhausted: boolean; }
export interface RankedUSCandidate { symbol: string; exchcd: string; rank: number; score: number; }
// ranked(순위) + 종목별 준비상태 → 실제 LIVE 게이트를 적용할 단일 후보. 없으면 null.
export function selectUSLiveCandidate(
  ranked: RankedUSCandidate[],
  readiness: (symbol: string) => USCandidateReadiness,
): { symbol: string; exchcd: string; rank: number } | null {
  for (const c of ranked) {
    const r = readiness(c.symbol);
    if (r.warmedUp && !r.hasPending && !r.dailyExhausted) return { symbol: c.symbol, exchcd: c.exchcd, rank: c.rank };
  }
  return null;
}
