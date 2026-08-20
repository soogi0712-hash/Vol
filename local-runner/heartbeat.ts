// 데몬 하트비트 (P0-36) — Docker healthcheck 용. 매 loop cycle 마다 <market>-live.heartbeat 에 타임스탬프 기록.
//   ⚠️ 전략/주문과 무관(상태파일만). data 볼륨에 저장 → 컨테이너 healthcheck 가 신선도로 alive 판정.
import { writeFileSync, mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';

const DIR = resolve(process.cwd(), 'local-runner', 'data');
export function heartbeatPath(market: 'KR' | 'US'): string { return join(DIR, `${market.toLowerCase()}-live.heartbeat`); }

export function writeHeartbeat(market: 'KR' | 'US', extra: Record<string, unknown> = {}): void {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    const p = heartbeatPath(market); const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify({ market, ts: Date.now(), pid: process.pid, ...extra }), 'utf8');
    renameSync(tmp, p);
  } catch { /* healthcheck 보조용 — 실패해도 매매엔 영향 없음 */ }
}

// 하트비트 나이(ms). 파일 없거나 손상이면 null.
export function readHeartbeatAgeMs(market: 'KR' | 'US', now = Date.now()): number | null {
  try { const d = JSON.parse(readFileSync(heartbeatPath(market), 'utf8')); return typeof d.ts === 'number' ? now - d.ts : null; }
  catch { return null; }
}
