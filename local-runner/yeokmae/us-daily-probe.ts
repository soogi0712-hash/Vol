// 역매공파 US 일봉 probe 조합 빌더 (P0-32C 재설계) — 근거 있는 후보만, 우선순위 정렬. 순수·테스트용.
//   ⚠️ 임의 gubun 0~9 brute-force 금지. repo/문서에서 '존재가 확인된' overseas-chart InBlock 필드만 값 변형.
//   확정 근거(P0-32D + test/yeokmae-us-fetch.test.ts): g3204(해외주식 일주월년) · gubun='2'(일) · plain symbol
//     (symbol='82AAPL' prefixed 는 rows=0) · keysymbol=exchcd+symbol · date range 지정. → 최우선 후보.
export interface USProbeCombo {
  tr: string;
  label: string;
  priority: number;                 // 1=확정근거 최우선 … 큰수=반증/대체
  inBlock: Record<string, unknown>;
}

// overseas-chart InBlock 공용 필드만 사용(delaygb/keysymbol/exchcd/symbol/gubun/qrycnt/comp_yn/sdate/edate).
export function buildUSProbeCombos(p: {
  exchcd: string; symbol: string; keysymbol: string; delaygb: string; sdate: string; edate: string;
}): USProbeCombo[] {
  const { exchcd, symbol, keysymbol, delaygb, sdate, edate } = p;
  const combos: USProbeCombo[] = [];
  const mk = (tr: string, gubun: string, fmt: 'plain' | 'prefixed', range: boolean, priority: number): USProbeCombo => ({
    tr, priority,
    label: `${tr} gubun=${gubun} ${fmt} ${range ? 'range' : 'norange'}`,
    inBlock: {
      delaygb, keysymbol, exchcd,
      symbol: fmt === 'plain' ? symbol : keysymbol,   // 확정상 plain 이 정답(prefixed=반증용)
      gubun, qrycnt: 700, comp_yn: 'N',
      sdate: range ? sdate : '', edate: range ? edate : '',
    },
  });
  // 1순위 — P0-32D 확정 후보(g3204/gubun='2'/plain/range). rows>0 이면 여기서 즉시 hit.
  combos.push(mk('g3204', '2', 'plain', true, 1));
  // 2순위 — 동일 gubun 다른 TR(g3103 일주월). g3103 은 실측상 소량(30) → 반증/비교용.
  combos.push(mk('g3103', '2', 'plain', true, 2));
  // 3순위 — date range 미지정(TR 이 최근구간 기본 반환하는지 확인).
  combos.push(mk('g3204', '2', 'plain', false, 3));
  combos.push(mk('g3103', '2', 'plain', false, 3));
  // 4순위 — gubun 대체 enum(문서상 존재값 0/1). 근거 있는 소수 enum 만(brute-force 아님).
  combos.push(mk('g3204', '0', 'plain', true, 4));
  combos.push(mk('g3204', '1', 'plain', true, 4));
  combos.push(mk('g3103', '0', 'plain', true, 4));
  combos.push(mk('g3103', '1', 'plain', true, 4));
  // 5순위 — prefixed symbol(=keysymbol). 확정상 rows=0 예상 → 반증(regression)용으로만.
  combos.push(mk('g3204', '2', 'prefixed', true, 5));
  return combos.sort((a, b) => a.priority - b.priority);
}
