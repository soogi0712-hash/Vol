// P0-35 — 무인 supervisor 코어 + 단일 인스턴스 락 + 로그 로테이션 회귀. 실 프로세스 없음(주입식 mock).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Supervisor, computeBackoffMs, autoEnabled, type ChildName, type ChildHandle, type Timer } from '../local-runner/yeokmae/supervisor-core';
import { acquireLock, readLock, releaseLock } from '../local-runner/single-instance';
import { RotatingLog } from '../local-runner/log-rotate';

// ── 주입식 harness: 가짜 spawn/timer/clock ──
function harness(children: ChildName[] = ['KR', 'US'], opt: any = {}) {
  let nowMs = 1_000_000; let pidSeq = 100;
  const spawned: { name: ChildName; pid: number; killed: string | null }[] = [];
  const timers: { ms: number; cb: () => void; cancelled: boolean }[] = [];
  const spawn = (name: ChildName): ChildHandle => { const rec = { name, pid: ++pidSeq, killed: null as string | null }; spawned.push(rec); return { pid: rec.pid, kill: (s?: string) => { rec.killed = s ?? 'SIGINT'; } }; };
  const setTimer = (ms: number, cb: () => void): Timer => { const t = { ms, cb, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true; } }; };
  const sup = new Supervisor({ spawn, now: () => nowMs, setTimer, log: () => {} }, { children, backoffBaseMs: 3000, backoffMaxMs: 60000, crashLoopWindowMs: 100000, crashLoopMaxRestarts: 3, ...opt });
  return {
    sup, spawned, timers,
    countOf: (n: ChildName) => spawned.filter(s => s.name === n).length,
    fireLast: () => { const t = timers.filter(x => !x.cancelled).at(-1); if (t) t.cb(); },
    advance: (ms: number) => { nowMs += ms; },
  };
}

describe('P0-35 computeBackoffMs — 지수 backoff + 캡', () => {
  it('base·2^(n-1), max 캡', () => {
    expect(computeBackoffMs(1, 3000, 60000)).toBe(3000);
    expect(computeBackoffMs(2, 3000, 60000)).toBe(6000);
    expect(computeBackoffMs(3, 3000, 60000)).toBe(12000);
    expect(computeBackoffMs(10, 3000, 60000)).toBe(60000);   // 캡
    expect(computeBackoffMs(0, 3000, 60000)).toBe(0);
  });
});

describe('P0-35 autoEnabled — kill switch', () => {
  it('YEOKMAE_AUTO_ENABLED=true 만 활성', () => {
    expect(autoEnabled({ YEOKMAE_AUTO_ENABLED: 'true' } as any)).toBe(true);
    expect(autoEnabled({ YEOKMAE_AUTO_ENABLED: 'false' } as any)).toBe(false);
    expect(autoEnabled({} as any)).toBe(false);
  });
});

describe('P0-35 Supervisor — child 생명주기(독립 재시작)', () => {
  it('start → KR/US 각 1회 spawn, 둘 다 running', () => {
    const h = harness(); h.sup.start();
    expect(h.countOf('KR')).toBe(1); expect(h.countOf('US')).toBe(1);
    expect(h.sup.alive('KR')).toBe(true); expect(h.sup.alive('US')).toBe(true);
  });
  it('KR crash → KR 만 재시작(US 무영향)', () => {
    const h = harness(); h.sup.start();
    h.sup.onChildExit('KR', 1, null);                 // KR 비정상 종료
    expect(h.sup.children.get('KR')!.status).toBe('restarting');
    expect(h.sup.alive('US')).toBe(true);             // US 는 그대로
    h.fireLast();                                     // backoff 타이머 발화 → KR 재spawn
    expect(h.countOf('KR')).toBe(2); expect(h.countOf('US')).toBe(1);
    expect(h.sup.children.get('KR')!.restartCount).toBe(1);
  });
  it('US crash → US 만 재시작(KR 무영향)', () => {
    const h = harness(); h.sup.start();
    h.sup.onChildExit('US', null, 'SIGSEGV');
    h.fireLast();
    expect(h.countOf('US')).toBe(2); expect(h.countOf('KR')).toBe(1);
  });
  it('crash-loop → 캡 초과 시 자동재시작 중단(crash-looped)', () => {
    const h = harness(); h.sup.start();
    for (let i = 0; i < 4; i++) { h.sup.onChildExit('KR', 1, null); }   // max=3 → 4번째에 crash-loop
    expect(h.sup.children.get('KR')!.status).toBe('crash-looped');
  });
  it('stop → 모든 child kill + 이후 exit 는 재시작 안 함', () => {
    const h = harness(); h.sup.start();
    const krPid = h.spawned.find(s => s.name === 'KR')!.pid;
    h.sup.stop('SIGINT');
    expect(h.spawned.find(s => s.pid === krPid)!.killed).toBe('SIGINT');
    expect(h.sup.children.get('KR')!.status).toBe('stopped');
    h.sup.onChildExit('KR', 0, 'SIGINT');             // 종료 후 exit 이벤트
    expect(h.countOf('KR')).toBe(1);                  // 재시작 없음
  });
  it('healthSnapshot — child 상태/세션/restartCount', () => {
    const h = harness(); h.sup.start();
    const snap = h.sup.healthSnapshot({ KR: 'REGULAR', US: 'CLOSED' });
    expect(snap.children.map(c => c.name).sort()).toEqual(['KR', 'US']);
    expect(snap.children.find(c => c.name === 'KR')!.session).toBe('REGULAR');
    expect(snap.children.find(c => c.name === 'US')!.status).toBe('running');
  });
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sup-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('P0-35 단일 인스턴스 락 — 중복 supervisor 차단', () => {
  const lock = () => join(dir, 'auto.lock');
  it('빈 상태 → 획득, readLock 반환', () => {
    const r = acquireLock(lock(), { pid: 111, startedAt: 1, role: 'sup' }, () => true);
    expect(r.acquired).toBe(true);
    expect(readLock(lock())!.pid).toBe(111);
  });
  it('홀더 생존 → 두 번째 획득 실패(중복 차단)', () => {
    acquireLock(lock(), { pid: 111, startedAt: 1, role: 'sup' }, () => true);
    const r2 = acquireLock(lock(), { pid: 222, startedAt: 2, role: 'sup' }, () => true);
    expect(r2.acquired).toBe(false); expect(r2.holder!.pid).toBe(111);
  });
  it('홀더 사망(stale) → 두 번째가 인수', () => {
    acquireLock(lock(), { pid: 111, startedAt: 1, role: 'sup' }, () => true);
    const r2 = acquireLock(lock(), { pid: 222, startedAt: 2, role: 'sup' }, (pid) => pid === 222);   // 111 사망
    expect(r2.acquired).toBe(true); expect(readLock(lock())!.pid).toBe(222);
  });
  it('releaseLock 은 내 pid 소유일 때만 삭제', () => {
    acquireLock(lock(), { pid: 111, startedAt: 1, role: 'sup' }, () => true);
    releaseLock(lock(), 999); expect(existsSync(lock())).toBe(true);   // 남의 락 삭제 안 함
    releaseLock(lock(), 111); expect(existsSync(lock())).toBe(false);
  });
});

describe('P0-35 RotatingLog — 크기기반 로테이션', () => {
  it('maxBytes 초과 → rotate(file.1 생성, file 리셋) + maxFiles 보관', () => {
    const f = join(dir, 'x.log');
    const r = new RotatingLog(f, { maxBytes: 200, maxFiles: 3 });
    for (let i = 0; i < 50; i++) r.write(`line-${i} ${'x'.repeat(20)}`);
    expect(existsSync(f)).toBe(true);
    expect(existsSync(f + '.1')).toBe(true);            // rotate 발생
    expect(existsSync(f + '.3')).toBe(false);           // maxFiles=3 → .3 이상 없음(초과분 삭제)
    // 현재 file 은 최근 라인 포함, 크기 작음
    expect(readFileSync(f, 'utf8')).toContain('line-49');
  });
});
