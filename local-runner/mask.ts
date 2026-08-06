// 순수 유틸(Node/브라우저 무관) — 계좌 마스킹 + 민감값 스크럽. 테스트 대상.

/** 계좌번호 끝 4자리만 노출. suffix 있으면 '-suffix' 붙임. 없으면 null. */
export function maskAccount(acc: string | null | undefined, suffix?: string | null): string | null {
  if (!acc) return null;
  const tail = acc.slice(-4);
  const stars = '*'.repeat(Math.max(0, acc.length - 4));
  return stars + tail + (suffix ? '-' + suffix : '');
}

/** 주어진 비밀값들을 '***' 로 치환하는 스크러버 생성 (빈 값 무시, 최대 length 제한). */
export function makeScrubber(secrets: Array<string | null | undefined>, maxLen = 300) {
  const list = secrets.filter((s): s is string => !!s && s.length >= 4);
  return (input: string): string => {
    let out = input;
    for (const s of list) out = out.split(s).join('***');
    return out.length > maxLen ? out.slice(0, maxLen) : out;
  };
}
