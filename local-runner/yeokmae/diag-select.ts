// 역매공파 진단 계산봉 선택 (P0-32E) — 순수 로직(테스트 대상). 캐시 confirmed 플래그 기준, look-ahead 금지.
export interface DiagSelectBar { date: string; confirmed: boolean }

// CONFIRMED: 요청일 이하 AND confirmed=true. 요청일이 확정봉이면 요청일이 마지막 계산봉(무조건 진행봉 취급 금지).
//   요청일 이후 봉은 절대 포함하지 않는다(look-ahead 금지).
export function selectConfirmedBars<T extends DiagSelectBar>(bars: readonly T[], requestDate: string): { bars: T[]; lastDate: string | null } {
  const sel = bars.filter(b => b.date <= requestDate && b.confirmed).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return { bars: sel, lastDate: sel.length ? sel[sel.length - 1].date : null };
}

// PROVISIONAL: 캐시 provisionalDate(진행중 당일봉)가 있을 때만. 진행봉 포함 전체(<= provisionalDate).
//   provisionalDate 가 없으면 빈 집합(요청일을 임의로 진행봉 취급하지 않는다).
export function selectProvisionalBars<T extends DiagSelectBar>(bars: readonly T[], provisionalDate: string | null): { bars: T[]; lastDate: string | null } {
  if (!provisionalDate) return { bars: [], lastDate: null };
  const sel = bars.filter(b => b.date <= provisionalDate).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return { bars: sel, lastDate: sel.length ? sel[sel.length - 1].date : null };
}
