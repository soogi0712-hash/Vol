// 국내(KOSPI+KOSDAQ) 유니버스 로드 + eligibility 필터 (P0-22).
// LS 공식 종목마스터(t8436)로 전 종목을 로드하고, 아래 기준으로 실거래 후보(eligible)를 선별한다.
//   기본 제외: ETF/ETN, SPAC, 우선주, (전일종가 0 = 신규/거래정지 성격).
//   ETF/ETN 은 옵션(includeEtf)으로 활성화 가능.
// ⚠️ 거래정지/관리/정리매매/상폐예정 은 t8436 마스터에 확정 필드가 없다(추측 금지). 마스터 단계에서는
//    전일종가<=0 만 걸러내고, 실제 정지/관리 종목은 스캔 시점에 15분봉(t8412) 데이터가 없거나 거래량 0 이면
//    자연히 건너뛴다(런타임 liveness). README 참고.
import { getLSKRStockMaster, type LSConfig, type LSKRMasterRow, LS_KR_MASTER_KOSPI, LS_KR_MASTER_KOSDAQ } from '../src/lib/ls-api';

export interface KRUniverseOpts { includeEtf?: boolean; }
export interface EligibilityResult { eligible: boolean; reasons: string[]; }

// 우선주 판별(휴리스틱): 종목명 접미('우','우B','우C','(전환)') 또는 종목코드 끝자리 non-0.
//   보통주 shcode 는 6번째 자리(체크숫자)가 '0'. 우선주/신주 는 5/7/K 등. 이름 접미가 더 신뢰도 높음.
export function isPreferredStock(row: { shcode: string; hname: string }): boolean {
  const nm = row.hname.trim();
  if (/(우|우B|우C|우\(전환\)|\(전환\))$/.test(nm)) return true;   // 종목명 접미
  const last = row.shcode.trim().slice(-1);
  return last !== '0' && /[0-9A-Z]/.test(last);   // 보조: 끝자리 non-0 (우선주/신주인수권)
}

// 종목 하나의 실거래 후보 자격 판정. eligible=false 면 reasons 에 제외사유.
export function classifyKRSymbol(row: LSKRMasterRow, opts: KRUniverseOpts = {}): EligibilityResult {
  const reasons: string[] = [];
  if (row.market !== 'KOSPI' && row.market !== 'KOSDAQ') reasons.push('NON_KRX');
  if (row.etf && !opts.includeEtf) reasons.push('ETF_ETN');
  if (row.spac || /스팩/.test(row.hname)) reasons.push('SPAC');
  if (isPreferredStock(row)) reasons.push('PREFERRED');
  if (!(row.prevClose > 0)) reasons.push('NO_PREV_CLOSE');   // 신규/거래정지 성격(마스터 단계 liveness)
  return { eligible: reasons.length === 0, reasons };
}

export interface KRUniverse {
  ok: boolean;
  total: number;                 // 마스터 전체 종목수
  eligible: LSKRMasterRow[];     // 선별된 실거래 후보
  excluded: number;              // 제외 종목수
  excludedByReason: Record<string, number>;
  perMarket: { KOSPI: number; KOSDAQ: number; ETC: number };
  rspNote: string;
}

// KOSPI(gubun=1)+KOSDAQ(gubun=2) 마스터를 로드·병합(shcode dedup)하고 eligibility 필터를 적용한다.
export async function loadKRUniverse(
  cfg: LSConfig, token: string,
  fetchMaster: typeof getLSKRStockMaster = getLSKRStockMaster,
  opts: KRUniverseOpts = {},
): Promise<KRUniverse> {
  const seen = new Map<string, LSKRMasterRow>();
  const notes: string[] = [];
  let ok = true;
  for (const gubun of [LS_KR_MASTER_KOSPI, LS_KR_MASTER_KOSDAQ]) {
    try {
      const r = await fetchMaster(cfg, token, gubun);
      notes.push(`gubun=${gubun} rows=${r.rows.length} rsp_cd=${r.rspCd}`);
      for (const row of r.rows) if (row.shcode && !seen.has(row.shcode)) seen.set(row.shcode, row);
    } catch (e) {
      ok = false;
      notes.push(`gubun=${gubun} 조회실패:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return buildUniverse([...seen.values()], opts, ok, notes.join(' · '));
}

// 로드된 마스터 행 배열 → 필터링된 유니버스(순수 함수, 테스트용).
export function buildUniverse(rows: LSKRMasterRow[], opts: KRUniverseOpts, ok = true, rspNote = ''): KRUniverse {
  const eligible: LSKRMasterRow[] = [];
  const excludedByReason: Record<string, number> = {};
  const perMarket = { KOSPI: 0, KOSDAQ: 0, ETC: 0 };
  for (const row of rows) {
    perMarket[row.market]++;
    const c = classifyKRSymbol(row, opts);
    if (c.eligible) eligible.push(row);
    else for (const reason of c.reasons) excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
  }
  return { ok, total: rows.length, eligible, excluded: rows.length - eligible.length, excludedByReason, perMarket, rspNote };
}
