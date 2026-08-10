// LS API 전송한도 준수용 rate limiter (P0-22).
// 초당 reqPerSec 건을 절대 초과하지 않도록 acquire() 가 필요한 만큼 대기한다.
//   - t8412(국내 15분봉) 개인=1/s, 법인=3/s. env LS_KR_SCAN_REQ_PER_SEC 로 주입.
//   - 슬라이딩 1초 윈도우: 최근 1000ms 내 호출이 reqPerSec 이상이면, 가장 오래된 호출+1000ms 까지 sleep.
// now/sleep 주입으로 결정적 테스트 가능.
export class RateLimiter {
  private readonly windowMs = 1000;
  private readonly capacity: number;
  private readonly stamps: number[] = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private totalAcquired = 0;

  constructor(reqPerSec: number, deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.capacity = Math.max(1, Math.floor(reqPerSec));
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get count(): number { return this.totalAcquired; }
  get reqPerSec(): number { return this.capacity; }

  /** 한도 내에서 호출 권한 1건을 얻는다(필요 시 대기). */
  async acquire(): Promise<void> {
    // 윈도우 밖 타임스탬프 제거
    this.prune(this.now());
    while (this.stamps.length >= this.capacity) {
      const oldest = this.stamps[0];
      const waitMs = oldest + this.windowMs - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
      this.prune(this.now());
    }
    this.stamps.push(this.now());
    this.totalAcquired++;
  }

  private prune(t: number): void {
    while (this.stamps.length && this.stamps[0] <= t - this.windowMs) this.stamps.shift();
  }
}

// 유니버스 순환 성능 추정(요구 5·12·보고용). eligible 종목수·rate 로 1회 순환시간·15분 커버 가능여부 계산.
export interface ScanCapacity {
  eligible: number; reqPerSec: number; batchSize: number;
  fullCycleSec: number;          // 전체 eligible 1회 순환 소요(초)
  candlePeriodSec: number;       // 15분봉 주기(900)
  coversWithinCandle: boolean;   // 한 15분봉 주기 안에 전체 1회 평가 가능?
  symbolsPerCandle: number;      // 한 주기에 평가 가능한 최대 종목수
}
export function computeScanCapacity(eligible: number, reqPerSec: number, batchSize: number, candlePeriodSec = 900): ScanCapacity {
  const rps = Math.max(1, reqPerSec);
  const fullCycleSec = eligible > 0 ? Math.ceil(eligible / rps) : 0;
  const symbolsPerCandle = rps * candlePeriodSec;
  return {
    eligible, reqPerSec: rps, batchSize,
    fullCycleSec, candlePeriodSec,
    coversWithinCandle: eligible <= symbolsPerCandle,
    symbolsPerCandle,
  };
}
