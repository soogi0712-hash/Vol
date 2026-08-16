// 역매공파 무인 supervisor 상태확인 (P0-35) — 실행: npm run yeokmae:auto-status
//   터미널이 없어도 나중에 상태 확인: 락(홀더 pid 생존여부) + health 스냅샷 + 로그 경로 출력.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createLogger } from './logger';
import { readLock, defaultIsAlive } from './single-instance';

const ROOT = process.cwd();
const DATA = resolve(ROOT, 'local-runner', 'data');
const LOGS = resolve(ROOT, 'local-runner', 'logs');
const LOCK = join(DATA, 'yeokmae-auto.lock');
const HEALTH = join(DATA, 'yeokmae-auto-health.json');

function main() {
  const log = createLogger('yeokmae-auto-status');
  log.info('===== [YEOKMAE-AUTO-STATUS] 무인 supervisor 상태 =====');

  const holder = readLock(LOCK);
  if (!holder) { log.info('[YEOKMAE-AUTO-STATUS] supervisor 미실행(락 없음). 시작: npm run yeokmae:auto'); }
  else {
    const alive = defaultIsAlive(holder.pid);
    log.info(`[YEOKMAE-AUTO-STATUS] supervisor pid=${holder.pid} alive=${alive} startedAt=${holder.startedAt ? new Date(holder.startedAt).toISOString() : '-'}${alive ? '' : ' (stale 락 — 다음 실행이 인수)'}`);
  }

  if (existsSync(HEALTH)) {
    try {
      const h = JSON.parse(readFileSync(HEALTH, 'utf8'));
      const age = h.updatedAt ? Math.round((Date.now() - h.updatedAt) / 1000) : null;
      log.info(`[YEOKMAE-AUTO-STATUS] health updatedAt=${h.updatedAt ? new Date(h.updatedAt).toISOString() : '-'}${age != null ? `(${age}s 전)` : ''} uptime=${h.startedAt ? Math.round((Date.now() - h.startedAt) / 1000) + 's' : '-'}`);
      for (const c of (h.children ?? [])) log.info(`   ${c.name}: status=${c.status} pid=${c.pid ?? '-'} session=${h.sessions?.[c.name] ?? c.session ?? '?'} restarts=${c.restartCount}`);
      log.info(`[YEOKMAE-AUTO-STATUS] lastBuySell=${h.lastBuySellAt ? new Date(h.lastBuySellAt).toISOString() : '-'}`);
    } catch { log.warn('[YEOKMAE-AUTO-STATUS] health 파일 파싱 실패(손상).'); }
  } else { log.info('[YEOKMAE-AUTO-STATUS] health 스냅샷 없음(아직 미기동 또는 첫 health 이전).'); }

  log.info(`[YEOKMAE-AUTO-STATUS] 로그: ${join(LOGS, 'auto-supervisor.log')} · ${join(LOGS, 'kr-live.log')} · ${join(LOGS, 'us-live.log')}`);
}
main();
