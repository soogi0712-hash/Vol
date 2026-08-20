// P0-36 — 컨테이너 재생성 후 상태복원(managed position/pending/heartbeat) + 시장 격리(KR↔US exchcd). 실 주문 없음.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { YeokmaePositionStore } from '../local-runner/yeokmae-position-store';
import { OrderStore } from '../local-runner/order-store';
import { writeHeartbeat, readHeartbeatAgeMs } from '../local-runner/heartbeat';

let dir: string; let cwd0: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'recover-')); cwd0 = process.cwd(); });
afterEach(() => { process.chdir(cwd0); rmSync(dir, { recursive: true, force: true }); });

describe('P0-36 재시작 복원 — managed position/pending 볼륨 영속 후 새 프로세스 복원', () => {
  it('positions flush → 새 store 인스턴스(=컨테이너 재생성)가 그대로 복원', () => {
    const a = new YeokmaePositionStore(dir); a.load();
    a.applyYeokmaeBuyFill({ symbol: '005930', exchcd: 'KR', entryDate: '2026-08-20', fillQty: 3, fillPrice: 60000 });
    a.applyYeokmaeBuyFill({ symbol: 'PRGO', exchcd: '82', entryDate: '2026-08-20', fillQty: 4, fillPrice: 13 });
    a.flush();
    // 재생성: 같은 data dir 로 새 인스턴스 로드
    const b = new YeokmaePositionStore(dir); b.load();
    expect(b.corrupt).toBe(false);
    expect(b.get('005930')!.qty).toBe(3); expect(b.get('005930')!.entryAvgPrice).toBe(60000);
    expect(b.get('PRGO')!.qty).toBe(4);
  });
  it('시장 격리 — KR 데몬은 exchcd=KR 만, US 데몬은 exchcd≠KR 만 관리(공유 파일이어도 분리)', () => {
    const a = new YeokmaePositionStore(dir); a.load();
    a.applyYeokmaeBuyFill({ symbol: '005930', exchcd: 'KR', entryDate: '2026-08-20', fillQty: 3, fillPrice: 60000 });
    a.applyYeokmaeBuyFill({ symbol: 'PRGO', exchcd: '82', entryDate: '2026-08-20', fillQty: 4, fillPrice: 13 });
    a.flush();
    const s = new YeokmaePositionStore(dir); s.load();
    const kr = s.all().filter(p => p.exchcd === 'KR' && p.qty > 0);
    const us = s.all().filter(p => p.exchcd !== 'KR' && p.qty > 0);
    expect(kr.map(p => p.symbol)).toEqual(['005930']);
    expect(us.map(p => p.symbol)).toEqual(['PRGO']);
  });
  it('pending 주문 → 재생성 후 복원(중복 POST 방지 근거 유지)', () => {
    const o = new OrderStore('YEOKMAE_US_PRGO', dir); o.load();
    o.recordPlaced('buy', '20260819', '20260819', { ordNo: '285', symbol: 'PRGO', qty: 4, price: 13, placedAtMs: 1 });
    o.flush();
    const o2 = new OrderStore('YEOKMAE_US_PRGO', dir); o2.load();
    expect(o2.hasPending()).toBe(true);
    expect(o2.pending.map(p => p.ordNo)).toContain('285');
  });
  it('손상 원장(JSON 깨짐) → corrupt 플래그(자동삭제 금지, fail-closed)', () => {
    writeFileSync(join(dir, 'us-yeokmae-positions.json'), '{ broken');
    const s = new YeokmaePositionStore(dir); s.load();
    expect(s.corrupt).toBe(true);
  });
});

describe('P0-36 heartbeat — Docker healthcheck 신선도', () => {
  it('writeHeartbeat 후 readHeartbeatAgeMs 는 작은 값', () => {
    process.chdir(dir);   // heartbeat 는 cwd/local-runner/data 사용
    writeHeartbeat('KR', { cycle: 1 });
    const age = readHeartbeatAgeMs('KR');
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
    expect(age!).toBeLessThan(5000);
  });
  it('하트비트 없으면 null(→ healthcheck unhealthy)', () => {
    process.chdir(dir);
    expect(readHeartbeatAgeMs('US')).toBeNull();
  });
  it('오래된 하트비트 → 나이가 임계보다 큼(→ unhealthy 판정 근거)', () => {
    process.chdir(dir);
    writeHeartbeat('KR', { cycle: 1 });
    const age = readHeartbeatAgeMs('KR', Date.now() + 200_000);   // 200s 후 관점
    expect(age!).toBeGreaterThan(180_000);
  });
});
