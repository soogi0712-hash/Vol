/**
 * KIS 호출 rate limiter (앱키 단위 공유 예산)
 * ─────────────────────────────────────────────────────────────
 * 실전 20건/초를 최대치로 쓰지 않고 보수적으로 관리한다.
 *  - 최소 호출 간격(직렬화) 적용
 *  - EGW00215 등 초과 오류 분류
 *  - 제한된 지수 백오프 + 최대 재시도(무한 재시도 금지)
 *  - 재시도 초과 시 예외를 그대로 던져 호출측이 해당 종목을 NO_DATA/ERROR 처리
 *
 * 최종적으로 캔들·보유·잔고·시세 등 같은 앱키를 쓰는 모든 KIS 요청이 하나의
 * 리미터 인스턴스를 공유하도록 설계한다(호출측에서 공유 주입).
 */

/** KIS 초당 호출 제한(및 관련) 오류인지 분류 */
export function isKisRateLimitError(e: unknown): boolean {
  const s = (e instanceof Error ? e.message : String(e)).toUpperCase();
  return s.includes('EGW00215')   // 초당 거래건수 초과
      || s.includes('EGW00201')   // 유량 제한
      || s.includes('429')
      || s.includes('초당')
      || s.includes('유량');
}

export interface RateLimiterOpts {
  minIntervalMs?: number;   // 최소 호출 간격 (기본 120ms ≈ 8.3/s, 20/s 절반 이하)
  maxRetries?: number;      // 제한 오류 재시도 횟수 (기본 3)
  baseBackoffMs?: number;   // 지수 백오프 기준 (기본 300ms)
  maxBackoffMs?: number;    // 백오프 상한 (기본 3000ms)
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
}

type Resolved = Required<RateLimiterOpts>;

export class KisRateLimiter {
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly o: Resolved) {}

  /** fn 을 최소 간격·재시도 정책으로 실행. 호출들은 직렬화된다. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    // 직렬화: 이전 호출이 끝난 뒤 실행 (동시 폭주 방지)
    const result = this.chain.then(() => this.execute(fn));
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async execute<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.o.minIntervalMs - (this.o.nowFn() - this.last);
      if (wait > 0) await this.o.sleepFn(wait);
      this.last = this.o.nowFn();
      try {
        return await fn();
      } catch (e) {
        if (isKisRateLimitError(e) && attempt < this.o.maxRetries) {
          const backoff = Math.min(this.o.baseBackoffMs * 2 ** attempt, this.o.maxBackoffMs);
          await this.o.sleepFn(backoff);
          continue;
        }
        throw e;   // 비-제한 오류 즉시 / 재시도 초과 → 호출측이 실패 처리
      }
    }
  }
}

export function makeKisRateLimiter(opts: RateLimiterOpts = {}): KisRateLimiter {
  return new KisRateLimiter({
    minIntervalMs: opts.minIntervalMs ?? 120,
    maxRetries: opts.maxRetries ?? 3,
    baseBackoffMs: opts.baseBackoffMs ?? 300,
    maxBackoffMs: opts.maxBackoffMs ?? 3000,
    sleepFn: opts.sleepFn ?? ((ms) => new Promise(r => setTimeout(r, ms))),
    nowFn: opts.nowFn ?? (() => Date.now()),
  });
}
