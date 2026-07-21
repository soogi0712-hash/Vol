import { describe, it, expect } from 'vitest';
import { selectPriorityScanItems, type ScanItem, type ScanGate } from '../src/lib/trade-engine';

// ── 테스트 헬퍼 ──────────────────────────────────────────────
function holding(ticker: string, market: 'KR' | 'US' = 'KR'): ScanItem {
  return {
    ticker, ticker_name: `${ticker}-name`, market,
    exchange: market === 'US' ? 'NASD' : 'KOSPI', source: 'HOLDING',
  };
}
function watch(ticker: string, market: 'KR' | 'US' = 'KR'): ScanItem {
  return {
    ticker, ticker_name: `${ticker}-name`, market,
    exchange: market === 'US' ? 'NASD' : 'KOSPI', source: 'WATCH',
  };
}

// 기본 게이트: 개장 + 거래 활성, 스캔 활성은 각 테스트에서 조정
function gate(overrides: Partial<ScanGate> = {}): ScanGate {
  return {
    krOpen: true, usOpen: true,
    krTradeEnabled: true, usTradeEnabled: true,
    krScanEnabled: true, usScanEnabled: true,
    ...overrides,
  };
}

const tickers = (items: ScanItem[]) => items.map(i => i.ticker);

describe('selectPriorityScanItems — Risk 1 게이트 분리', () => {
  // A. 거래 활성 + 스캔 비활성 + 보유 종목 → 보유는 스캔된다
  it('A: 스캔 비활성이어도 보유 종목은 스캔한다', () => {
    const out = selectPriorityScanItems(
      [holding('005930')], [],
      gate({ krScanEnabled: false }),
    );
    expect(tickers(out)).toEqual(['005930']);
    expect(out[0].source).toBe('HOLDING');
  });

  // B. 거래 활성 + 스캔 비활성 + 무보유 감시 종목 → 스캔/매수 없음
  it('B: 스캔 비활성이면 감시 종목은 스캔하지 않는다(매수 불가)', () => {
    const out = selectPriorityScanItems(
      [], [watch('000660')],
      gate({ krScanEnabled: false }),
    );
    expect(out).toHaveLength(0);
    expect(tickers(out)).not.toContain('000660');
  });

  // C. 거래 활성 + 스캔 활성 + 감시 종목 → 스캔된다
  it('C: 스캔 활성이면 감시 종목을 스캔한다', () => {
    const out = selectPriorityScanItems(
      [], [watch('000660')],
      gate({ krScanEnabled: true }),
    );
    expect(tickers(out)).toEqual(['000660']);
    expect(out[0].source).toBe('WATCH');
  });

  // D. 보유 + 감시에 동시에 존재 → 한 번만 처리 (보유 우선)
  it('D: 보유·감시 중복 종목은 1회만, 보유로 처리한다', () => {
    const out = selectPriorityScanItems(
      [holding('AAPL', 'US')], [watch('AAPL', 'US')],
      gate(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].ticker).toBe('AAPL');
    expect(out[0].source).toBe('HOLDING');
  });

  // D 보강: 스캔 비활성 + 중복 → 보유로 여전히 1회 스캔
  it('D2: 스캔 비활성이어도 중복 종목은 보유로 1회 스캔된다', () => {
    const out = selectPriorityScanItems(
      [holding('005930')], [watch('005930')],
      gate({ krScanEnabled: false }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('HOLDING');
  });

  // 시장 마감 시 보유/감시 모두 스캔 안 함 (주문 불가)
  it('시장 마감이면 보유도 감시도 스캔하지 않는다', () => {
    const out = selectPriorityScanItems(
      [holding('005930')], [watch('000660')],
      gate({ krOpen: false }),
    );
    expect(out).toHaveLength(0);
  });

  // 거래 비활성이면 보유·감시 모두 제외
  it('거래 비활성이면 보유도 감시도 제외한다', () => {
    const out = selectPriorityScanItems(
      [holding('005930')], [watch('000660')],
      gate({ krTradeEnabled: false }),
    );
    expect(out).toHaveLength(0);
  });

  // 시장별 독립 게이트: KR 스캔 off, US 스캔 on
  it('시장별로 스캔 게이트가 독립 적용된다 (KR off / US on)', () => {
    const out = selectPriorityScanItems(
      [holding('005930', 'KR')],
      [watch('000660', 'KR'), watch('AAPL', 'US')],
      gate({ krScanEnabled: false, usScanEnabled: true }),
    );
    // KR 보유(005930)는 스캔, KR 감시(000660)는 제외, US 감시(AAPL)는 스캔
    expect(tickers(out).sort()).toEqual(['005930', 'AAPL'].sort());
    expect(tickers(out)).not.toContain('000660');
  });

  // 보유 항상 우선순위(리스트 순서): 보유가 감시보다 앞선다
  it('보유 항목이 감시 항목보다 먼저 배치된다', () => {
    const out = selectPriorityScanItems(
      [holding('005930')], [watch('000660')],
      gate(),
    );
    expect(tickers(out)).toEqual(['005930', '000660']);
  });
});
