// 실주문 게이트 (ARMED 판정) — 10개 필수 조건을 모두 충족해야 armed=true.
// ⚠️ 이 모듈은 "조건 충족 여부"만 계산한다. 주문은 절대 내지 않는다(순수 함수).
//    실제 주문 실행은 러너가 LS_LIVE_TRADING='true' + armed + 취소 TR 확인 시에만 수행한다.
import { LS_CANCEL_TR_CONFIRMED } from '../src/lib/ls-api';

export const GATE = {
  MIN_CONFIRMED: 20,     // confirmedCandles >= 20
  GSC_FRESH_S: 300,      // GSC 최근 300초 이내
  GSH_FRESH_S: 30,       // GSH 최근 30초 이내
  SESSION_OPEN_MIN: 9 * 60 + 30,   // 09:30 ET
  SESSION_CLOSE_MIN: 16 * 60,      // 16:00 ET
};

// 미국 정규장 여부 — America/New_York 09:30~16:00, 평일(주말 제외). 서머타임은 Intl 이 자동 반영.
// ⚠️ 공휴일 달력은 공식 소스가 없어 반영하지 않는다(휴장일엔 거래소가 주문 거부). README 참고.
export function etWallClock(nowMs: number): { weekday: string; minutes: number; hh: number; mm: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  let hh = parseInt(get('hour'), 10) % 24;   // Intl 은 자정을 '24'로 줄 수 있어 %24
  const mm = parseInt(get('minute'), 10);
  if (!Number.isFinite(hh)) hh = 0;
  return { weekday, minutes: hh * 60 + mm, hh, mm };
}
// ET 기준 날짜 YYYYMMDD (일일 매수/매도 횟수 키). 미국 현지 날짜로 하루를 구분한다.
export function etDateStr(nowMs: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}
export function isUSRegularSession(nowMs: number): boolean {
  const { weekday, minutes } = etWallClock(nowMs);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return minutes >= GATE.SESSION_OPEN_MIN && minutes < GATE.SESSION_CLOSE_MIN;
}

export interface GateState {
  confirmedCount: number;
  signalAction: string;            // 'BUY' | 'SELL' | 'HOLD' | 'NONE'
  wsConnected: boolean;
  gscAgeSec: number | null;
  gshAgeSec: number | null;
  bid: number; ask: number; lastPrice: number;
  nowMs: number;
  orderableQtyOk: boolean;         // 주문가능수량(예수금) 조회 성공 + 1주 이상 가능
  duplicateCandleOrdered: boolean; // 동일 확정봉에 이미 주문함
  hasPendingOrder: boolean;        // 미체결 주문 존재
}

export interface GateResult { armed: boolean; passed: string[]; blockedBy: string[] }

// 10개 조건 평가. 하나라도 실패하면 armed=false, blockedBy 에 사유 누적.
export function evaluateTradeGate(s: GateState): GateResult {
  const passed: string[] = [];
  const blockedBy: string[] = [];
  const chk = (name: string, ok: boolean) => { (ok ? passed : blockedBy).push(name); return ok; };

  const c1 = chk(`confirmed>=${GATE.MIN_CONFIRMED}`, s.confirmedCount >= GATE.MIN_CONFIRMED);
  const c2 = chk('signal=BUY', s.signalAction === 'BUY');
  const c3 = chk('wsConnected', s.wsConnected);
  const c4 = chk(`GSC<=${GATE.GSC_FRESH_S}s`, s.gscAgeSec != null && s.gscAgeSec <= GATE.GSC_FRESH_S);
  const c5 = chk(`GSH<=${GATE.GSH_FRESH_S}s`, s.gshAgeSec != null && s.gshAgeSec <= GATE.GSH_FRESH_S);
  const c6 = chk('bid/ask/last>0', s.bid > 0 && s.ask > 0 && s.lastPrice > 0);
  const c7 = chk('정규장(NY 09:30-16:00)', isUSRegularSession(s.nowMs));
  const c8 = chk('주문가능수량 조회성공', s.orderableQtyOk);
  const c9 = chk('동일봉 중복주문 없음', !s.duplicateCandleOrdered);
  const c10 = chk('미체결 없음', !s.hasPendingOrder);

  const armed = c1 && c2 && c3 && c4 && c5 && c6 && c7 && c8 && c9 && c10;
  return { armed, passed, blockedBy };
}

// 실주문 실행 가능 여부(러너용) — armed + LIVE 스위치 + 취소 TR 확인까지 모두 필요.
// ⚠️ LS_CANCEL_TR_CONFIRMED=false 인 동안에는 LIVE_TRADING=true 여도 실주문을 차단한다(안전).
export function canExecuteLive(armed: boolean, liveTrading: boolean): { execute: boolean; reason: string } {
  if (!armed) return { execute: false, reason: 'ARMED 조건 미충족' };
  if (!liveTrading) return { execute: false, reason: 'LS_LIVE_TRADING=false (관찰/ARMED 전용)' };
  if (!LS_CANCEL_TR_CONFIRMED) return { execute: false, reason: '미체결 취소 TR(공식 필드) 미확인 → 실주문 차단' };
  return { execute: true, reason: '실행 가능' };
}
