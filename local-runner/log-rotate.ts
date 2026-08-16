// 크기기반 로그 로테이션 (P0-35) — 무인 지속실행에서 로그가 무한히 커지지 않게. append-only + size rotate.
//   file 이 maxBytes 초과 시: file.(N-1)→file.N … file→file.1 로 밀고 새 file 시작. 최대 maxFiles 보관(초과분 삭제).
import { existsSync, mkdirSync, statSync, renameSync, appendFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RotateOptions { maxBytes?: number; maxFiles?: number }
export class RotatingLog {
  readonly file: string; readonly maxBytes: number; readonly maxFiles: number;
  constructor(file: string, opts: RotateOptions = {}) {
    this.file = file;
    this.maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : 5 * 1024 * 1024;   // 기본 5MB
    this.maxFiles = opts.maxFiles && opts.maxFiles > 0 ? opts.maxFiles : 5;                  // 기본 5개 보관
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(file)) writeFileSync(file, '');
  }
  private sizeOf(f: string): number { try { return statSync(f).size; } catch { return 0; } }
  // 초과 시 rotate. file.(maxFiles-1) 이상은 삭제(초과분 제거).
  rotateIfNeeded(nextWriteBytes = 0): boolean {
    if (this.sizeOf(this.file) + nextWriteBytes <= this.maxBytes) return false;
    // 오래된 것부터 밀기: file.(k) → file.(k+1). file.(maxFiles-1) 초과분은 버림.
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const src = i === 1 ? this.file : `${this.file}.${i - 1}`;
      const dst = `${this.file}.${i}`;
      if (!existsSync(src)) continue;
      if (i === this.maxFiles - 1 && existsSync(`${this.file}.${this.maxFiles - 1}`)) { try { rmSync(`${this.file}.${this.maxFiles - 1}`, { force: true }); } catch { /* noop */ } }
      try { renameSync(src, dst); } catch { /* noop */ }
    }
    writeFileSync(this.file, '');
    return true;
  }
  write(line: string): void {
    const data = line.endsWith('\n') ? line : line + '\n';
    this.rotateIfNeeded(Buffer.byteLength(data));
    try { appendFileSync(this.file, data); } catch { /* noop */ }
  }
}
