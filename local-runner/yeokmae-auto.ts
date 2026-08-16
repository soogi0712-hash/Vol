// 역매공파 무인 통합 supervisor (P0-35) — 실행: npm run yeokmae:auto
//   KR/US 두 daemon(yeokmae:kr-live·yeokmae:us-live)을 자식 프로세스로 시작·감시·자동재시작. Ctrl+C 까지 생존.
//   ⚠️ 단일 인스턴스 락(중복 supervisor 즉시 종료) · kill switch(YEOKMAE_AUTO_ENABLED) · child 로그 분리+rotation · graceful shutdown.
//   ⚠️ 전략/금액/손절익절 무변경 — child daemon 이 각자 시장세션·게이트 판단(장외 POST 0, 수동보유 자동 SELL 금지).
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEnvLocal } from './env';
import { createLogger } from './logger';
import { krSession, usEtSession } from '../src/lib/ls-api';
import { acquireLock, releaseLock } from './single-instance';
import { RotatingLog } from './log-rotate';
import { Supervisor, autoEnabled, type ChildName, type ChildHandle } from './yeokmae/supervisor-core';

const ROOT = process.cwd();
const DATA = resolve(ROOT, 'local-runner', 'data');
const LOGS = resolve(ROOT, 'local-runner', 'logs');
const LOCK = join(DATA, 'yeokmae-auto.lock');
const HEALTH = join(DATA, 'yeokmae-auto-health.json');
const HEALTH_MS = Number(process.env.YEOKMAE_AUTO_HEALTH_MS || 30_000) || 30_000;
const CHILD_CMD: Record<ChildName, string> = { KR: 'yeokmae:kr-live', US: 'yeokmae:us-live' };

function saveJsonAtomic(file: string, payload: unknown) { const tmp = file + '.tmp'; writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8'); renameSync(tmp, file); }

async function main() {
  loadEnvLocal();
  const log = createLogger('yeokmae-auto');
  for (const d of [DATA, LOGS]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
  const supLog = new RotatingLog(join(LOGS, 'auto-supervisor.log'), { maxBytes: 5 * 1024 * 1024, maxFiles: 7 });
  const childLog: Record<ChildName, RotatingLog> = {
    KR: new RotatingLog(join(LOGS, 'kr-live.log'), { maxBytes: 5 * 1024 * 1024, maxFiles: 7 }),
    US: new RotatingLog(join(LOGS, 'us-live.log'), { maxBytes: 5 * 1024 * 1024, maxFiles: 7 }),
  };
  const emit = (m: string) => { log.info(m); supLog.write(`${new Date().toISOString()} ${m}`); };

  emit('===== [YEOKMAE-AUTO] 무인 통합 supervisor =====');

  // kill switch — YEOKMAE_AUTO_ENABLED!=='true' → 주문 daemon 시작 안 함(observe-only 종료).
  if (!autoEnabled(process.env)) {
    emit('[YEOKMAE-AUTO] YEOKMAE_AUTO_ENABLED!=true → observe-only. KR/US daemon 을 시작하지 않고 종료. (.env.local 에서 YEOKMAE_AUTO_ENABLED=true 로 활성화)');
    process.exit(0); return;
  }

  // 단일 인스턴스 락 — 두 번째 supervisor 는 즉시 종료(중복 방지).
  const acq = acquireLock(LOCK, { pid: process.pid, startedAt: Date.now(), role: 'yeokmae-auto-supervisor' });
  if (!acq.acquired) {
    emit(`[YEOKMAE-AUTO] 이미 supervisor 실행 중(pid=${acq.holder?.pid}) → 중복 실행 즉시 종료. (상태: npm run yeokmae:auto-status)`);
    process.exit(0); return;
  }
  emit(`[YEOKMAE-AUTO] 락 획득 pid=${process.pid} · children=[KR,US] · health=${HEALTH_MS}ms · logs=${LOGS}`);

  let supervisor: Supervisor;
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const procs = new Map<ChildName, ChildProcess>();

  const spawnDep = (name: ChildName): ChildHandle => {
    // child daemon 시작 — 동일 .env.local/cwd. stdout/stderr 는 child 로그(rotation)로 분리 저장 + BUY/SELL 활동 감지.
    const cp = spawn(npmCmd, ['run', CHILD_CMD[name]], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    procs.set(name, cp);
    const pipe = (stream: NodeJS.ReadableStream | null) => { if (!stream) return; const rl = createInterface({ input: stream }); rl.on('line', (line) => { childLog[name].write(line); if (/-BUY\]|-SELL\]|-FILL\]/.test(line)) supervisor.markActivity(); }); };
    pipe(cp.stdout); pipe(cp.stderr);
    cp.on('exit', (code, signal) => { procs.delete(name); supervisor.onChildExit(name, code, signal); });
    cp.on('error', (e) => { emit(`[YEOKMAE-AUTO] ${name} spawn 오류: ${String(e)}`); });
    return { pid: cp.pid ?? null, kill: (sig?: string) => { try { cp.kill((sig as NodeJS.Signals) || 'SIGINT'); } catch { /* noop */ } } };
  };

  supervisor = new Supervisor(
    { spawn: spawnDep, now: () => Date.now(), setTimer: (ms, cb) => { const t = setTimeout(cb, ms); return { cancel: () => clearTimeout(t) }; }, log: emit },
    { children: ['KR', 'US'], backoffBaseMs: 3_000, backoffMaxMs: 60_000, crashLoopWindowMs: 120_000, crashLoopMaxRestarts: 6 },
  );
  supervisor.start();

  // ── [YEOKMAE-AUTO-HEALTH] 주기 출력 + health 파일 저장(auto-status 용). ──
  const health = () => {
    const sessions = { KR: krSession(new Date()).session, US: usEtSession(new Date()).session };
    const snap = supervisor.healthSnapshot(sessions);
    const line = snap.children.map(c => `${c.name}:${c.status}(pid=${c.pid ?? '-'} session=${c.session} restarts=${c.restartCount})`).join(' ');
    emit(`[YEOKMAE-AUTO-HEALTH] ${line} lastBuySell=${snap.lastBuySellAt ? new Date(snap.lastBuySellAt).toISOString() : '-'} uptime=${snap.startedAt ? Math.round((Date.now() - snap.startedAt) / 1000) + 's' : '-'}`);
    saveJsonAtomic(HEALTH, { ...snap, pid: process.pid, updatedAt: Date.now(), sessions });
  };
  health();
  const healthTimer = setInterval(health, HEALTH_MS);

  // ── graceful shutdown — child 에 종료신호 전달 후 대기, 락 해제. ──
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) { process.exit(130); return; }
    shuttingDown = true;
    emit('[YEOKMAE-AUTO-SHUTDOWN] 종료신호 수신 — child daemon 종료 전달, 락 해제 후 종료…');
    clearInterval(healthTimer);
    supervisor.stop('SIGINT');
    const graceMs = 10_000; const t0 = Date.now();
    const waiter = setInterval(() => {
      if (procs.size === 0 || Date.now() - t0 > graceMs) {
        clearInterval(waiter);
        for (const [, cp] of procs) { try { cp.kill('SIGKILL'); } catch { /* noop */ } }
        try { health(); } catch { /* noop */ }
        releaseLock(LOCK, process.pid);
        emit(`[YEOKMAE-AUTO-SHUTDOWN] 완료 — child ${procs.size === 0 ? '정상 종료' : 'grace 초과 강제종료'} · 락 해제 · supervisor 종료.`);
        process.exit(0);
      }
    }, 250);
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

  emit('[YEOKMAE-AUTO] supervisor 가동 — KR/US daemon 감시 중. Ctrl+C 로 전체 graceful shutdown.');
}
main();
