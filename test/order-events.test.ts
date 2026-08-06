import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAccountEvent, applyOrderEvent, canTransition, isCancelComplete,
  type OrderEvent, type TrackedOrder,
} from '../local-runner/order-events';
import { OrderStore } from '../local-runner/order-store';

// 공식 s-접두 필드 이벤트 바디 헬퍼
const as0 = (o: any) => ({ sOrdNo: '141', sOrgOrdNo: '0', sOrdMktCode: '82', sOrdPtnCode: '02', sShtnIsuNo: 'AAPL', sOrdQty: '2', sOrdPrc: '190', sUnercQty: '2', sOrdTrxPtnCode: '01', sRjtRsn: '', ...o });
const as1 = (o: any) => ({ sOrdNo: '141', sOrgOrdNo: '0', sExecNO: 'E1', sAbrdExecId: 'X1', sExecQty: '1', sExecPrc: '190', sUnercQty: '1', sOrdAvrExecPrc: '190', sExecTime: '093012', sRcptExecTime: '093012', sRjtRsn: '', ...o });
const as2 = (o: any) => ({ sOrdNo: '141', sOrgOrdNo: '0', sMdfyCnfQty: '2', sMdfyCnfPrc: '191', sOrgOrdMdfyQty: '2', sUnercQty: '2', sOrdTrxPtnCode: '03', sRjtRsn: '', ...o });
const as3 = (o: any) => ({ sOrdNo: '999', sOrgOrdNo: '141', sCancCnfQty: '1', sOrgOrdCancQty: '1', sUnercQty: '0', sOrgOrdUnercQty: '0', sOrdTrxPtnCode: '04', sRjtRsn: '', ...o });
const as4 = (o: any) => ({ sOrdNo: '141', sOrgOrdNo: '0', sRjtRsn: '잔고부족', ...o });

const ev = (trCd: string, body: any): OrderEvent => parseAccountEvent(trCd, body)!;
let m: Map<string, TrackedOrder>;
beforeEach(() => { m = new Map(); });

describe('AS 파서 (공식 s-필드)', () => {
  it('AS0/AS1/AS3 필드 매핑', () => {
    const a0 = ev('AS0', as0({}));
    expect(a0).toMatchObject({ kind: 'AS0', ordNo: '141', mktCode: '82', ptnCode: '02', symbol: 'AAPL', ordQty: 2, ordPrc: 190, unfilledQty: 2 });
    const a1 = ev('AS1', as1({ sExecQty: '1', sUnercQty: '1' }));
    expect(a1).toMatchObject({ kind: 'AS1', execNo: 'E1', abrdExecId: 'X1', execQty: 1, unfilledQty: 1, avgExecPrc: 190 });
    const a3 = ev('AS3', as3({}));
    expect(a3).toMatchObject({ kind: 'AS3', ordNo: '999', orgOrdNo: '141', cancCnfQty: 1 });
  });
});

describe('상태 전이 (요구 시나리오)', () => {
  it('AS0 → ACCEPTED', () => {
    const r = applyOrderEvent(m, ev('AS0', as0({})), 1);
    expect(r.transition).toBe('SUBMITTED→ACCEPTED');
    expect(r.order?.status).toBe('ACCEPTED');
  });
  it('AS1 부분체결 → PARTIALLY_FILLED (누적수량/평균가 저장)', () => {
    applyOrderEvent(m, ev('AS0', as0({ sOrdQty: '2' })), 1);
    const r = applyOrderEvent(m, ev('AS1', as1({ sExecQty: '1', sUnercQty: '1', sOrdAvrExecPrc: '190' })), 2);
    expect(r.order?.status).toBe('PARTIALLY_FILLED');
    expect(r.order?.cumExecQty).toBe(1);
    expect(r.order?.avgExecPrc).toBe(190);
  });
  it('AS1 완전체결 → FILLED', () => {
    applyOrderEvent(m, ev('AS0', as0({ sOrdQty: '1' })), 1);
    const r = applyOrderEvent(m, ev('AS1', as1({ sExecQty: '1', sUnercQty: '0' })), 2);
    expect(r.order?.status).toBe('FILLED');
  });
  it('AS2 → MODIFIED', () => {
    applyOrderEvent(m, ev('AS0', as0({})), 1);
    const r = applyOrderEvent(m, ev('AS2', as2({ sMdfyCnfPrc: '191' })), 2);
    expect(r.order?.status).toBe('MODIFIED');
    expect(r.order?.ordPrc).toBe(191);
  });
  it('AS3 미체결 전량취소 → CANCELLED (원주문번호 기준)', () => {
    applyOrderEvent(m, ev('AS0', as0({})), 1);
    const r = applyOrderEvent(m, ev('AS3', as3({ sOrgOrdNo: '141', sCancCnfQty: '2' })), 2);
    expect(r.order?.status).toBe('CANCELLED');
    expect(m.get('141')?.status).toBe('CANCELLED');   // sOrgOrdNo=141 로 원주문 갱신
  });
  it('AS3 부분체결 후 잔량취소 → PARTIALLY_FILLED_CANCELLED', () => {
    applyOrderEvent(m, ev('AS0', as0({ sOrdQty: '2' })), 1);
    applyOrderEvent(m, ev('AS1', as1({ sExecQty: '1', sUnercQty: '1' })), 2);   // 부분체결
    const r = applyOrderEvent(m, ev('AS3', as3({ sOrgOrdNo: '141', sCancCnfQty: '1' })), 3);
    expect(r.order?.status).toBe('PARTIALLY_FILLED_CANCELLED');
  });
  it('AS4 → REJECTED (거부사유 저장)', () => {
    const r = applyOrderEvent(m, ev('AS4', as4({ sRjtRsn: '잔고부족' })), 1);
    expect(r.order?.status).toBe('REJECTED');
    expect(r.order?.rejectReason).toBe('잔고부족');
  });
});

describe('멱등 · 역방향 전이 차단', () => {
  it('동일 sExecNO 중복 체결 이벤트 무시(누적수량 2배 안 됨)', () => {
    applyOrderEvent(m, ev('AS0', as0({ sOrdQty: '2' })), 1);
    applyOrderEvent(m, ev('AS1', as1({ sExecNO: 'E1', sExecQty: '1', sUnercQty: '1' })), 2);
    const dup = applyOrderEvent(m, ev('AS1', as1({ sExecNO: 'E1', sExecQty: '1', sUnercQty: '1' })), 3);
    expect(dup.ignored).toBe(true);
    expect(m.get('141')?.cumExecQty).toBe(1);   // 중복 무시 → 여전히 1
  });
  it('중복 AS3 idempotent 무시', () => {
    applyOrderEvent(m, ev('AS0', as0({})), 1);
    applyOrderEvent(m, ev('AS3', as3({ sOrgOrdNo: '141', sCancCnfQty: '2' })), 2);
    const dup = applyOrderEvent(m, ev('AS3', as3({ sOrgOrdNo: '141', sCancCnfQty: '2' })), 3);
    expect(dup.ignored).toBe(true);
    expect(m.get('141')?.status).toBe('CANCELLED');
  });
  it('FILLED 이후 역방향(AS0 ACCEPTED) 차단', () => {
    applyOrderEvent(m, ev('AS0', as0({ sOrdQty: '1' })), 1);
    applyOrderEvent(m, ev('AS1', as1({ sExecQty: '1', sUnercQty: '0' })), 2);
    const back = applyOrderEvent(m, ev('AS0', as0({})), 3);
    expect(back.ignored).toBe(true);
    expect(m.get('141')?.status).toBe('FILLED');
  });
  it('canTransition — 허용/차단', () => {
    expect(canTransition('ACCEPTED', 'FILLED')).toBe(true);
    expect(canTransition('FILLED', 'ACCEPTED')).toBe(false);
    expect(canTransition('CANCELLED', 'PARTIALLY_FILLED')).toBe(false);
  });
});

describe('재시작 상태 복원 + LIVE 취소완료 판정', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'order-events-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('저장 후 재시작 시 원주문번호 기준 상태 복원', () => {
    const s1 = new OrderStore('__ev__', dir);
    const map = s1.trackedMap();
    applyOrderEvent(map, ev('AS0', as0({})), 1);
    applyOrderEvent(map, ev('AS1', as1({ sExecQty: '1', sUnercQty: '1' })), 2);
    s1.saveTracked(map); s1.flush();

    const s2 = new OrderStore('__ev__', dir); s2.load();
    const restored = s2.trackedMap();
    expect(restored.get('141')?.status).toBe('PARTIALLY_FILLED');
    expect(restored.get('141')?.cumExecQty).toBe(1);
  });

  it('AS3 만 수신하고 REST 취소 성공 기록이 없으면 취소 오케스트레이션 완료로 판정하지 않음', () => {
    applyOrderEvent(m, ev('AS0', as0({})), 1);
    applyOrderEvent(m, ev('AS3', as3({ sOrgOrdNo: '141', sCancCnfQty: '2' })), 2);
    const o = m.get('141')!;
    expect(o.status).toBe('CANCELLED');
    expect(o.restCancelOk).toBe(false);        // REST 취소 미실행
    expect(isCancelComplete(o)).toBe(false);   // → 취소 완료 아님
    // REST 취소 성공까지 있어야 완료
    expect(isCancelComplete({ ...o, restCancelOk: true })).toBe(true);
  });
});
