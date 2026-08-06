// 콘솔 + 로컬 파일 로그. 파일은 local-runner/logs/ls-YYYYMMDD.log (일자별).
// ⚠️ 호출측 책임: 비밀값(앱키/시크릿/토큰/전체계좌)은 절대 넘기지 말 것.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const LOG_DIR = resolve(process.cwd(), 'local-runner', 'logs');

function ymd(d: Date): string {
  const k = new Date(d.getTime() + 9 * 3600 * 1000); // KST 파일명
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, '0')}${String(k.getUTCDate()).padStart(2, '0')}`;
}

export function createLogger(tag = 'ls') {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const file = join(LOG_DIR, `${tag}-${ymd(new Date())}.log`);
  const write = (level: string, msg: string) => {
    const line = `${new Date().toISOString()} [${level}] ${msg}`;
    // 콘솔
    (level === 'ERROR' ? console.error : console.log)(line);
    // 파일
    try { appendFileSync(file, line + '\n', 'utf8'); } catch { /* 파일 실패해도 콘솔은 유지 */ }
  };
  return {
    file,
    info: (m: string) => write('INFO', m),
    warn: (m: string) => write('WARN', m),
    error: (m: string) => write('ERROR', m),
  };
}
export type Logger = ReturnType<typeof createLogger>;
