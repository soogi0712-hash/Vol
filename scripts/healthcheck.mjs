// Docker healthcheck (P0-36) — plain Node (no tsx). Exit 0 if the market daemon heartbeat is fresh.
//   Usage: node scripts/healthcheck.mjs KR|US [maxAgeSeconds]
//   Heartbeat is written by the daemon each loop cycle to local-runner/data/<market>-live.heartbeat.
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const market = String(process.argv[2] || '').toUpperCase();
const maxAgeSec = Number(process.argv[3] || 180) || 180;   // 기본 180s (SELL cycle 7s 대비 넉넉)
if (market !== 'KR' && market !== 'US') { console.error('usage: healthcheck.mjs KR|US [maxAgeSeconds]'); process.exit(2); }

const file = join(resolve(process.cwd(), 'local-runner', 'data'), `${market.toLowerCase()}-live.heartbeat`);
try {
  const d = JSON.parse(readFileSync(file, 'utf8'));
  const ageMs = Date.now() - Number(d.ts);
  if (!(Number(d.ts) > 0) || ageMs > maxAgeSec * 1000) {
    console.error(`[healthcheck] ${market} stale heartbeat age=${Math.round(ageMs / 1000)}s > ${maxAgeSec}s`);
    process.exit(1);
  }
  console.log(`[healthcheck] ${market} ok age=${Math.round(ageMs / 1000)}s cycle=${d.cycle ?? '?'} session=${d.session ?? '?'}`);
  process.exit(0);
} catch (e) {
  console.error(`[healthcheck] ${market} no/invalid heartbeat: ${String(e)}`);
  process.exit(1);
}
