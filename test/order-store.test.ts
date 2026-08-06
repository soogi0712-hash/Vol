import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrderStore, MAX_BUY_PER_DAY } from '../local-runner/order-store';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'order-store-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('일일 매수 한도 + 동일봉 중복주문 방지', () => {
  it('하루 매수 1회 제한', () => {
    const s = new OrderStore('AAPL', dir);
    expect(s.canBuyToday('20260706')).toBe(true);
    s.recordPlaced('buy', '20260706093000', '20260706', { ordNo: '1', symbol: 'AAPL', qty: 1, price: 100 });
    expect(s.buyCountToday('20260706')).toBe(MAX_BUY_PER_DAY);
    expect(s.canBuyToday('20260706')).toBe(false);         // 한도 소진
    expect(s.canBuyToday('20260707')).toBe(true);          // 다음날은 초기화
  });
  it('동일 확정봉 중복주문 감지', () => {
    const s = new OrderStore('AAPL', dir);
    expect(s.hasOrderedCandle('20260706093000', 'buy')).toBe(false);
    s.recordPlaced('buy', '20260706093000', '20260706', { ordNo: '1', symbol: 'AAPL', qty: 1, price: 100 });
    expect(s.hasOrderedCandle('20260706093000', 'buy')).toBe(true);
    expect(s.hasOrderedCandle('20260706094500', 'buy')).toBe(false);   // 다른 봉은 허용
  });
});

describe('미체결 추적 + 재시작 중복주문 방지', () => {
  it('pending 추가/해소', () => {
    const s = new OrderStore('AAPL', dir);
    expect(s.hasPending()).toBe(false);
    s.recordPlaced('buy', '20260706093000', '20260706', { ordNo: '141', symbol: 'AAPL', qty: 1, price: 100 });
    expect(s.hasPending()).toBe(true);
    expect(s.pending[0].ordNo).toBe('141');
    s.resolvePending('141');
    expect(s.hasPending()).toBe(false);
  });
  it('flush 후 새 인스턴스 load 시 일일카운트·주문봉·pending 복원(재시작 중복주문 방지)', () => {
    const s1 = new OrderStore('AAPL', dir);
    s1.recordPlaced('buy', '20260706093000', '20260706', { ordNo: '141', symbol: 'AAPL', qty: 1, price: 100 });
    s1.flush();
    const s2 = new OrderStore('AAPL', dir);
    s2.load();
    expect(s2.canBuyToday('20260706')).toBe(false);                    // 오늘 이미 매수함
    expect(s2.hasOrderedCandle('20260706093000', 'buy')).toBe(true);   // 동일봉 재주문 차단
    expect(s2.hasPending()).toBe(true);                                // 미체결 유지
  });
});

describe('저장 안전성 + 손상 처리', () => {
  it('OHLCV 무관 — 앱키/토큰/계좌 미저장, 손상 파일 → corrupt + .corrupt 백업', () => {
    const s = new OrderStore('AAPL', dir);
    writeFileSync(s.file, '{ broken', 'utf8');
    s.load();
    expect(s.corrupt).toBe(true);
    expect(existsSync(s.file + '.corrupt')).toBe(true);
    s.recordPlaced('buy', '20260706093000', '20260706', { ordNo: '1', symbol: 'AAPL', qty: 1, price: 100 });
    s.flush();                        // corrupt 면 저장 안 함
    expect(existsSync(s.file)).toBe(false);
  });
  it('atomic write — .tmp 잔재 없음', () => {
    const s = new OrderStore('AAPL', dir);
    s.recordPlaced('buy', '20260706093000', '20260706', { ordNo: '1', symbol: 'AAPL', qty: 1, price: 100 });
    s.flush();
    expect(existsSync(s.file)).toBe(true);
    expect(existsSync(s.file + '.tmp')).toBe(false);
  });
});
