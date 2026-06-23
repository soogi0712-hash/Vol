# 볼린저밴드 자동매매 웹앱

## 프로젝트 개요
- **이름**: Bollinger Band Auto Trader
- **목표**: 한국투자증권 Open API 기반 볼린저밴드 전략 자동매매
- **전략**: 하단 이탈 후 복귀 매수 → 중심선/상단선 매도

## 매매 전략

### 매수 조건
- 직전 봉 종가 < 볼린저밴드 하단선 (이탈)
- AND 현재 봉 종가 >= 볼린저밴드 하단선 (복귀)
- → 시장가 매수 실행

### 매도 조건
- 1차 매도: 현재 봉 종가 >= 중심선 → 전량 시장가 매도
- 전량 매도: 현재 봉 종가 >= 상단선 → 전량 시장가 매도

### 기본 설정값
| 항목 | 기본값 |
|------|--------|
| BB 기간 | 20 |
| 표준편차 배수 | 2.0 |
| 기준 가격 | 종가 |
| 주문 방식 | 시장가 |
| 거래 제한 | 없음 |
| 신용/미수 | 절대 사용 안함 |

## 주요 기능

### ✅ 구현 완료
- [x] 볼린저밴드 계산 엔진 (SMA + 표준편차 기반)
- [x] 한국투자증권 Open API 연동 (실전)
  - 액세스 토큰 자동 발급/갱신 (KV 캐시)
  - 일봉 OHLCV 조회
  - 주문가능현금 조회
  - 보유종목 조회
  - 현금 매수/매도 주문 (시장가)
- [x] 자동매매 엔진
  - 감시 종목별 볼린저밴드 신호 판단
  - 매수/매도 주문 자동 실행
  - 잔고 부족 시 매수 스킵
  - Cloudflare Cron Trigger (매분, 장 시간 자동 스캔)
- [x] D1 데이터베이스 (6개 테이블)
  - watch_list: 감시 종목 설정
  - orders: 주문 내역
  - holdings: 보유 종목 (실시간 동기화)
  - trade_logs: 전략 판단 로그
  - realized_profits: 실현 손익
  - system_config: 시스템 설정
- [x] 대시보드 UI
  - 대시보드 (요약 + 최근 주문 + 스캔 결과)
  - 감시 종목 관리 (CRUD)
  - 보유 종목 현황
  - 주문 내역
  - 실현 손익
  - 매매 로그
- [x] 자동매매 ON/OFF 토글
- [x] 수동 스캔 실행
- [x] 볼린저밴드 신호 미리보기 (종목별)
- [x] 보유 종목 KIS 동기화

## API 엔드포인트

### 트레이딩
| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/trading/dashboard` | 대시보드 요약 |
| GET | `/api/trading/holdings` | 보유 종목 |
| GET | `/api/trading/orders` | 주문 내역 |
| GET | `/api/trading/logs` | 매매 로그 |
| GET | `/api/trading/profits` | 실현 손익 |
| POST | `/api/trading/toggle` | 자동매매 ON/OFF |
| POST | `/api/trading/scan` | 수동 스캔 |
| POST | `/api/trading/sync-holdings` | 보유종목 동기화 |
| GET | `/api/trading/preview/:ticker` | BB 신호 미리보기 |

### 감시 종목
| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/watchlist` | 목록 조회 |
| POST | `/api/watchlist` | 종목 추가 |
| PUT | `/api/watchlist/:id` | 종목 수정 |
| DELETE | `/api/watchlist/:id` | 종목 삭제 |

### 시스템 설정
| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/config` | 설정 조회 |
| PUT | `/api/config/:key` | 설정 수정 |

## 환경변수 설정

### 필수 시크릿 (wrangler secret put)
```bash
wrangler secret put KIS_APP_KEY        # 앱키
wrangler secret put KIS_APP_SECRET     # 앱시크릿
wrangler secret put KIS_ACCOUNT_NO     # 계좌번호 앞 8자리
wrangler secret put KIS_ACCOUNT_SUFFIX # 계좌번호 뒤 2자리 (보통 01)
```

### 로컬 개발 (.dev.vars)
```
KIS_APP_KEY=your_app_key_here
KIS_APP_SECRET=your_app_secret_here
KIS_ACCOUNT_NO=12345678
KIS_ACCOUNT_SUFFIX=01
```

## Cloudflare 배포 방법

### 1. D1 데이터베이스 생성
```bash
npx wrangler d1 create bollinger-trader-production
# 출력된 database_id를 wrangler.jsonc에 업데이트
```

### 2. KV 네임스페이스 생성
```bash
npx wrangler kv:namespace create BOLLINGER_KV
npx wrangler kv:namespace create BOLLINGER_KV --preview
# 출력된 id를 wrangler.jsonc에 업데이트
```

### 3. wrangler.jsonc 업데이트
```jsonc
{
  "d1_databases": [{ "binding": "DB", "database_name": "bollinger-trader-production", "database_id": "실제-id" }],
  "kv_namespaces": [{ "binding": "KV", "id": "실제-id", "preview_id": "preview-id" }]
}
```

### 4. 마이그레이션 적용
```bash
npx wrangler d1 migrations apply bollinger-trader-production
```

### 5. 시크릿 설정
```bash
wrangler secret put KIS_APP_KEY
wrangler secret put KIS_APP_SECRET
wrangler secret put KIS_ACCOUNT_NO
wrangler secret put KIS_ACCOUNT_SUFFIX
```

### 6. 배포
```bash
npm run deploy
```

## Cron 트리거 설정
- `wrangler.jsonc`의 `triggers.crons`: `"* 0-6 * * 1-5"`
- 월~금 UTC 00:00~06:00 (= KST 09:00~15:00) 매분 자동 스캔

## 로컬 개발
```bash
npm run build
pm2 start ecosystem.config.cjs
# http://localhost:3000
```

## 데이터 모델
- **watch_list**: 감시 종목 (ticker, bb_period, bb_stddev, buy_qty)
- **orders**: 주문 (order_no, ticker, order_type, price, qty, status, reason)
- **holdings**: 보유 종목 (ticker, qty, avg_price, eval_profit_loss)
- **trade_logs**: 전략 로그 (action, bb_upper/middle/lower, message)
- **realized_profits**: 실현 손익 (buy_price, sell_price, qty, profit_loss, return_rate)
- **system_config**: 시스템 설정 (auto_trade_enabled, scan_interval)

## 기술 스택
- **Backend**: Hono + TypeScript on Cloudflare Workers
- **Database**: Cloudflare D1 (SQLite)
- **Cache**: Cloudflare KV (토큰 캐싱)
- **Frontend**: Vanilla JS + Tailwind CSS
- **Cron**: Cloudflare Workers Scheduled Triggers
- **API**: 한국투자증권 Open API (실전)

## 주의사항
⚠️ **실전 계좌 연동 앱입니다. 반드시 소액으로 테스트 후 사용하세요.**
⚠️ 자동매매 ON 전 감시 종목과 매수 수량을 꼭 확인하세요.
⚠️ 장 시간(09:00~15:30) 외에는 자동 스캔이 실행되지 않습니다.
