// 단일 인스턴스 락 (P0-35) — PC 재부팅/Task Scheduler 중복실행/crash 재기동에도 supervisor 는 1개만.
//   락파일에 {pid, startedAt, role}. 두 번째 실행은 홀더 PID 가 살아있으면 즉시 종료. 홀더가 죽었으면(stale) 인수.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LockInfo { pid: number; startedAt: number; role: string }
export function readLock(path: string): LockInfo | null {
  if (!existsSync(path)) return null;
  try { const d = JSON.parse(readFileSync(path, 'utf8')); if (typeof d?.pid === 'number') return { pid: d.pid, startedAt: Number(d.startedAt) || 0, role: String(d.role ?? '') }; } catch { /* corrupt */ }
  return null;
}
// 기본 liveness: 신호 0 으로 존재확인(권한 없어도 EPERM 이면 살아있음). 테스트는 주입으로 대체.
export function defaultIsAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e && e.code === 'EPERM'; }
}
export interface AcquireResult { acquired: boolean; holder: LockInfo | null }
// 락 획득: 미존재/홀더 사망(stale) → 획득(atomic tmp+rename). 홀더 생존(내 pid 아님) → 실패(holder 반환).
export function acquireLock(path: string, info: LockInfo, isAlive: (pid: number) => boolean = defaultIsAlive): AcquireResult {
  const dir = dirname(path); if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const holder = readLock(path);
  if (holder && holder.pid !== info.pid && isAlive(holder.pid)) return { acquired: false, holder };
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(info), 'utf8'); renameSync(tmp, path);
  return { acquired: true, holder: holder && holder.pid !== info.pid ? holder : null };
}
// 락 해제: 내 pid 소유일 때만 삭제(남의 락 삭제 금지).
export function releaseLock(path: string, myPid: number): void {
  const holder = readLock(path);
  if (holder && holder.pid === myPid) { try { rmSync(path, { force: true }); } catch { /* noop */ } }
}
