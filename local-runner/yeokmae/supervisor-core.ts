// 역매공파 무인 supervisor 코어 (P0-35) — 순수·테스트용. KR/US child 생명주기: 자동재시작 + backoff + crash-loop 캡.
//   ⚠️ 실 spawn/clock/timer 는 주입(테스트에서 mock). child 는 각자 독립 — 하나 죽어도 나머지 유지, 죽은 것만 재시작.
export type ChildName = 'KR' | 'US';
export type ChildStatus = 'starting' | 'running' | 'restarting' | 'stopped' | 'crash-looped';

export interface ChildHandle { readonly pid: number | null; kill(signal?: string): void; }
export interface Timer { cancel(): void }
export interface SupervisorDeps {
  spawn: (name: ChildName) => ChildHandle;                       // child process 시작(주입)
  now: () => number;
  setTimer: (ms: number, cb: () => void) => Timer;               // backoff 타이머(주입)
  log: (m: string) => void;
}
export interface SupervisorOptions {
  children: ChildName[];
  backoffBaseMs?: number; backoffMaxMs?: number;                 // 지수 backoff
  crashLoopWindowMs?: number; crashLoopMaxRestarts?: number;     // crash-loop 폭주 방지
}
export interface ChildState {
  name: ChildName; status: ChildStatus; handle: ChildHandle | null;
  restartCount: number; startedAt: number | null; lastExitAt: number | null; lastExitReason: string | null;
  restartWindow: number[];                                        // 최근 재시작 시각들(윈도우 내)
}
// 지수 backoff: base·2^(restartCount-1), max 로 캡. restartCount>=1.
export function computeBackoffMs(restartCount: number, baseMs: number, maxMs: number): number {
  if (restartCount <= 0) return 0;
  const v = baseMs * Math.pow(2, restartCount - 1);
  return Math.min(maxMs, Math.round(v));
}
// kill switch — YEOKMAE_AUTO_ENABLED!=='true' 이면 주문 daemon 시작 안 함(observe-only 종료).
export function autoEnabled(env: NodeJS.ProcessEnv): boolean { return env.YEOKMAE_AUTO_ENABLED === 'true'; }

export class Supervisor {
  private readonly d: SupervisorDeps;
  private readonly opt: Required<SupervisorOptions>;
  readonly children = new Map<ChildName, ChildState>();
  private timers = new Map<ChildName, Timer>();
  private stopping = false;
  startedAt: number | null = null;
  lastBuySellAt: number | null = null;

  constructor(deps: SupervisorDeps, opt: SupervisorOptions) {
    this.d = deps;
    this.opt = {
      children: opt.children,
      backoffBaseMs: opt.backoffBaseMs ?? 3_000,
      backoffMaxMs: opt.backoffMaxMs ?? 60_000,
      crashLoopWindowMs: opt.crashLoopWindowMs ?? 120_000,
      crashLoopMaxRestarts: opt.crashLoopMaxRestarts ?? 5,
    };
    for (const n of opt.children) this.children.set(n, { name: n, status: 'starting', handle: null, restartCount: 0, startedAt: null, lastExitAt: null, lastExitReason: null, restartWindow: [] });
  }

  start(): void {
    this.stopping = false;
    this.startedAt = this.d.now();
    for (const n of this.opt.children) this.spawnChild(n);
  }

  private spawnChild(name: ChildName): void {
    const st = this.children.get(name)!;
    const handle = this.d.spawn(name);
    st.handle = handle; st.status = 'running'; st.startedAt = this.d.now();
    this.d.log(`[YEOKMAE-AUTO] ${name} child 시작 pid=${handle.pid ?? '?'} restartCount=${st.restartCount}`);
  }

  // child 종료 이벤트(러너가 배선) — stopping 이면 stopped. 아니면 crash-loop 판정 후 backoff 재시작.
  onChildExit(name: ChildName, code: number | null, signal: string | null): void {
    const st = this.children.get(name); if (!st) return;
    const now = this.d.now();
    st.handle = null; st.lastExitAt = now; st.lastExitReason = signal ? `signal=${signal}` : `code=${code}`;
    if (this.stopping || st.status === 'stopped') { st.status = 'stopped'; this.d.log(`[YEOKMAE-AUTO] ${name} child 종료(정상 shutdown) ${st.lastExitReason}`); return; }
    // crash-loop 윈도우 갱신
    st.restartWindow = st.restartWindow.filter(t => now - t < this.opt.crashLoopWindowMs);
    st.restartWindow.push(now);
    if (st.restartWindow.length > this.opt.crashLoopMaxRestarts) {
      st.status = 'crash-looped';
      this.d.log(`[YEOKMAE-AUTO] ⚠️ ${name} child crash-loop 감지(${st.restartWindow.length}회/${Math.round(this.opt.crashLoopWindowMs / 1000)}s) → 자동재시작 중단. 원인 점검 필요.`);
      return;
    }
    st.restartCount++; st.status = 'restarting';
    const backoff = computeBackoffMs(st.restartCount, this.opt.backoffBaseMs, this.opt.backoffMaxMs);
    this.d.log(`[YEOKMAE-AUTO] ${name} child 비정상 종료(${st.lastExitReason}) → ${backoff}ms 후 재시작(restartCount=${st.restartCount})`);
    const timer = this.d.setTimer(backoff, () => { this.timers.delete(name); if (!this.stopping) this.spawnChild(name); });
    this.timers.set(name, timer);
  }

  markActivity(): void { this.lastBuySellAt = this.d.now(); }

  stop(signal = 'SIGINT'): void {
    this.stopping = true;
    for (const [, t] of this.timers) t.cancel();
    this.timers.clear();
    for (const st of this.children.values()) {
      if (st.handle) { try { st.handle.kill(signal); } catch { /* noop */ } }
      st.status = 'stopped';
    }
  }

  alive(name: ChildName): boolean { return this.children.get(name)?.status === 'running'; }
  anyRunning(): boolean { return [...this.children.values()].some(s => s.status === 'running' || s.status === 'restarting'); }

  // [YEOKMAE-AUTO-HEALTH] 스냅샷 — child alive/session/heartbeat/restartCount.
  healthSnapshot(sessions: Partial<Record<ChildName, string>> = {}): {
    startedAt: number | null; lastBuySellAt: number | null; children: Array<{ name: ChildName; status: ChildStatus; pid: number | null; restartCount: number; session: string }>;
  } {
    return {
      startedAt: this.startedAt, lastBuySellAt: this.lastBuySellAt,
      children: [...this.children.values()].map(s => ({ name: s.name, status: s.status, pid: s.handle?.pid ?? null, restartCount: s.restartCount, session: sessions[s.name] ?? '?' })),
    };
  }
}
