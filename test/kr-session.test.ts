// P0-35 — KR 장세션 판정(Asia/Seoul, DST 없음). REGULAR 09:00–15:30 만 주문 가능. 고정 KST 하드코딩 아님(Intl).
import { describe, it, expect } from 'vitest';
import { krSession } from '../src/lib/ls-api';

// 2026-08-17 = 월요일. Seoul = UTC+9.
describe('P0-35 krSession — KRX 정규장 경계', () => {
  it('평일 10:00 KST → REGULAR', () => {
    expect(krSession(new Date('2026-08-17T01:00:00Z')).session).toBe('REGULAR');   // 10:00 KST
  });
  it('평일 14:00 KST → REGULAR', () => {
    expect(krSession(new Date('2026-08-17T05:00:00Z')).session).toBe('REGULAR');   // 14:00 KST
  });
  it('평일 08:59 KST → CLOSED(개장 전)', () => {
    expect(krSession(new Date('2026-08-16T23:59:00Z')).session).toBe('CLOSED');    // 08:59 KST Mon
  });
  it('평일 15:30 KST → CLOSED(마감)', () => {
    expect(krSession(new Date('2026-08-17T06:30:00Z')).session).toBe('CLOSED');    // 15:30 KST
  });
  it('일요일 → CLOSED_WEEKEND', () => {
    expect(krSession(new Date('2026-08-16T05:00:00Z')).session).toBe('CLOSED_WEEKEND');
  });
});
