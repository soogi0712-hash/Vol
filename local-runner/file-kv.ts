// 파일 기반 KV 셰임 — src/lib/ls-api.ts 의 getLSAccessToken(cfg, kv?) 에 주입해
// 로컬 프로세스 재실행 간 LS 토큰을 재사용한다(매 실행 토큰 재발급 방지).
// get/put 시그니처만 KVNamespace 와 호환되면 되므로 as any 로 전달한다.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

const CACHE_DIR = resolve(process.cwd(), 'local-runner', '.cache');

export class FileKV {
  private dir: string;
  constructor(dir = CACHE_DIR) {
    this.dir = dir;
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }
  private path(key: string): string {
    return join(this.dir, key.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.json');
  }
  async get(key: string): Promise<string | null> {
    const p = this.path(key);
    if (!existsSync(p)) return null;
    try {
      const rec = JSON.parse(readFileSync(p, 'utf8')) as { value: string; expires_at: number };
      if (rec.expires_at && rec.expires_at < Date.now()) return null;
      return rec.value;
    } catch { return null; }
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const ttl = opts?.expirationTtl ?? 86400;
    const rec = { value, expires_at: Date.now() + ttl * 1000 };
    writeFileSync(this.path(key), JSON.stringify(rec), 'utf8');
  }
  delete(key: string): void {
    const p = this.path(key);
    if (existsSync(p)) { try { rmSync(p); } catch { /* noop */ } }
  }
}
