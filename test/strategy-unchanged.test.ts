import { describe, it, expect } from 'vitest';
import { getBBSignal } from '../src/lib/bollinger';

// 배포 아키텍처 변경이 매매 전략 출력을 바꾸지 않았음을 고정(characterization)한다.
// getBBSignal(bands, hasPosition, aboveUpper, rsiValues) 의 원본 4-인자 계약 그대로.
type BBand = { datetime: string; close: number; upper: number; middle: number; lower: number };
const band = (close: number, upper: number, middle: number, lower: number): BBand =>
  ({ datetime: '20260101000000', close, upper, middle, lower });

describe('매매 전략 characterization (불변)', () => {
  it('미보유 + 매수조건 충족(직전≤하단, 현재>하단, RSI≤35, RSI상승) → BUY', () => {
    const bands = [band(100, 110, 105, 100), band(105, 110, 105, 100)];
    const s = getBBSignal(bands as any, false, false, [30, 34]);
    expect(s.action).toBe('BUY');
  });

  it('보유 + 상단돌파 후 하락(above_upper=true, 현재<상단) → SELL', () => {
    const bands = [band(112, 110, 105, 100), band(105, 110, 105, 100)];
    const s = getBBSignal(bands as any, true, true, [50, 50]);
    expect(s.action).toBe('SELL');
  });

  it('미보유 + RSI 과열(>35) → NONE (매수 없음)', () => {
    const bands = [band(100, 110, 105, 100), band(105, 110, 105, 100)];
    const s = getBBSignal(bands as any, false, false, [50, 55]);
    expect(s.action).toBe('NONE');
  });

  it('보유 + 상단선 위(above_upper 미도달 상태 유지) → HOLD', () => {
    const bands = [band(100, 110, 105, 100), band(115, 110, 105, 100)];
    const s = getBBSignal(bands as any, true, false, [50, 50]);
    expect(s.action).toBe('HOLD');
  });
});
