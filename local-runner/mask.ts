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

// APP KEY 지문 — 앞 4자리만 노출(req 5). 예: 'abcd****'. 빈 값은 '(none)'.
export function keyFingerprint(key: string | null | undefined): string {
  if (!key) return '(none)';
  return key.slice(0, 4) + '****';
}

// 진단 로그용: 응답 블록에서 민감 키(계좌번호/비밀번호/앱키/시크릿/토큰)를 재귀 제거.
// 금액 필드(MnyOrdAbleAmt 등)는 남겨 실제 값 유입 여부를 확인할 수 있게 한다.
const SENSITIVE_KEY_RE = /acnt|acct|pwd|pass|secret|token|appkey|app_key/i;
export function sanitizeBlocks<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => sanitizeBlocks(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) { out[k] = '***'; continue; }
      out[k] = sanitizeBlocks(v);
    }
    return out as unknown as T;
  }
  return value;
}
