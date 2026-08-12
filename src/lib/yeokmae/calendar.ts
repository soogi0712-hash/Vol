// 역매공파 일봉 확정/진행 구분 (P0-32B) — KR=Asia/Seoul, US=America/New_York. DST 는 Intl 이 자동반영.
// 원칙: 장중에는 '오늘 봉'을 CONFIRMED 로 간주하지 않는다(진행중=PROVISIONAL). 공휴일 달력은 공식소스 없어 미반영.
export type YeokmaeMarket = 'KR' | 'US';

const TZ: Record<YeokmaeMarket, string> = { KR: 'Asia/Seoul', US: 'America/New_York' };

// 시장 현지 오늘 날짜 YYYY-MM-DD.
export function marketToday(nowMs: number, market: YeokmaeMarket): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ[market], year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// 해당 일봉 date 가 '진행중(당일)'인가 — 시장 현지 오늘과 같으면 PROVISIONAL.
export function isProvisionalDate(date: string, nowMs: number, market: YeokmaeMarket): boolean {
  return date === marketToday(nowMs, market);
}

// 캐시 일봉들에서 '마지막 확정 일봉' date — 시장 현지 오늘 이전(< today)의 마지막. (오늘봉은 진행중이라 제외)
export function lastConfirmedDate(dates: readonly string[], nowMs: number, market: YeokmaeMarket): string | null {
  const today = marketToday(nowMs, market);
  let last: string | null = null;
  for (const d of dates) if (d < today && (last === null || d > last)) last = d;
  return last;
}

// candles 를 CONFIRMED(오늘 이전) / PROVISIONAL(오늘) 로 분리.
export function splitConfirmedProvisional<T extends { date: string }>(candles: readonly T[], nowMs: number, market: YeokmaeMarket): { confirmed: T[]; provisional: T | null } {
  const today = marketToday(nowMs, market);
  const confirmed = candles.filter(c => c.date < today);
  const provisional = candles.find(c => c.date === today) ?? null;
  return { confirmed, provisional };
}
