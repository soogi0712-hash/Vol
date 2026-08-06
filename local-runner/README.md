# local-runner — LS증권 API 로컬 실행 (Windows 노트북)

LS Open API는 **등록된 공인 IP에서만** 호출할 수 있습니다. Cloudflare Worker의 IP는
매번 달라지고 등록도 불가하므로, **LS 토큰·시세·잔고·주문은 이 로컬 러너(노트북)에서만**
실행합니다. Worker에는 LS 호출 코드가 포함되지 않습니다(번들에서 완전 제외).

- 유지: 볼린저밴드 BB(20,2), RSI(14), 매매조건, 종목 유니버스 (`src/lib/*` 재사용)
- 로컬: LS 토큰/잔고/시세/주문
- 기본 **observe-only** — 실주문은 Phase 2 이후 + `LS_LIVE_TRADING=true` 에서만

## 0) 사전 준비 — 공인 IP 등록

1. `npm run ls:diag` 를 한 번 실행하면 로그에 **현재 공인 IP** 가 출력됩니다.
2. LS Open API 포털에서 그 IP 를 등록하세요. (노트북 IP 가 바뀌면 재등록/고정 IP 권장)
3. IP 미등록 시 토큰/잔고 호출이 거부됩니다.

## 1) 설정

```cmd
copy .env.local.example .env.local
notepad .env.local
```
`LS_APP_KEY`, `LS_APP_SECRET` 를 채웁니다. (선택) `LS_ACCOUNT_NO`, `LS_ACCOUNT_SUFFIX`.
`.env.local` 은 `.gitignore` 로 커밋이 차단됩니다 — 절대 커밋하지 마세요.

```cmd
npm install
```
(`tsx` 가 devDependencies 에 포함되어 함께 설치됩니다.)

## 2) Phase 1 — 토큰·잔고 검증

```cmd
npm run ls:diag
```
출력: 공인 IP, `token_ok`, `kr_balance_ok`/`kr_total_eval`/`kr_orderable_cash`,
`us_balance_ok`/`us_total_eval_krw`, 마스킹된 계좌. 로그는
`local-runner/logs/ls-diag-YYYYMMDD.log` 에도 저장됩니다.
비밀값(앱키/시크릿/토큰/전체 계좌번호)은 콘솔·파일 어디에도 출력되지 않습니다.

성공 기준: `token_ok && kr_balance_ok && us_balance_ok` → 종료코드 0.

## 3) Phase 2 — 시세·15분봉·관찰 신호 (주문 없음)

```cmd
npm run ls:trade
```
동작: 지정 종목(`LS_KR_SYMBOLS`/`LS_US_SYMBOLS`)에 대해 LS 15분봉(국내 t8412 / 해외 g3203)을
받아 **형성 중 봉을 제외한 확정봉 40개 이상**을 확보하고, 기존 엔진 BB(20,2)·RSI(14)·
`getBBSignal`로 신호를 계산해 `[OBSERVE ...]` 로그만 남깁니다. **주문은 하지 않습니다**
(`LS_LIVE_TRADING`은 observe 유지, 주문 기능은 Phase 3).

- 거래소코드(exchcd)는 확인분만: **NASDAQ=82, NYSE=81**. 미확인 거래소(AMEX 등)는
  추측하지 않고 `UNSUPPORTED_EXCHANGE`로 로그 후 스킵합니다(공식 코드 확인 후 추가).
- 오류는 종류별로 구분 기록: 네트워크오류 / 호출제한 / 빈응답 / 데이터부족 / API오류 / 무효응답.
- TR: 국내현재가 `t1102`, 해외현재가 `g3101`, 국내분봉 `t8412`, 해외분봉 `g3203` (모두 공식).

### 해외 시세 구분(delaygb) — 미국 실시간 Non-Display 불가

미국주식 **실시간 시세는 Non-Display(오픈API) 이용이 불가**합니다. 따라서 US 는 기본
**지연시세(DELAYED)** 로 조회합니다. `delaygb` 는 코드에 하드코딩하지 않으며, 다음처럼 정합니다:

- `LS_US_QUOTE_MODE=REALTIME` → `delaygb='R'` (공식 reqExample 로 확인된 값)
- `LS_US_QUOTE_MODE=DELAYED`(기본) → `delaygb = LS_US_DELAYGB` (LS 공식 g3101/g3203 문서의
  **지연 delaygb 코드를 직접 입력**). 확인 못 한 코드는 추측해 넣지 않으므로, 미설정 시
  US 시세는 건너뛰고 안내 로그를 남깁니다.

> 해외 약정등록 직후에는 약정 전 발급된 토큰 캐시를 지워야 합니다:
> `.env.local` 에 `LS_FORCE_TOKEN_REFRESH=true` (또는 `rmdir /s /q local-runner\.cache`).

### 해외 실시간 시세 (WebSocket GSC/GSH)

미국 실시간 시세는 REST(g3101)가 아닌 **WebSocket GSC(체결)/GSH(호가)** 로 받습니다.

```cmd
npm run ls:usws
```
- URL `wss://openapi.ls-sec.co.kr:9443/websocket`, 등록 `{header:{token,tr_type:"3"},body:{tr_cd:"GSC"|"GSH",tr_key}}`.
- `tr_key = exchcd+symbol` 을 **총 18자리 오른쪽 공백 패딩**(공식 예: `"81SOXL            "`). REST `keysymbol`(패딩 없음)과 **혼용 금지**.
- 거래소코드: **82=NASDAQ, 81=NYSE/AMEX**(SOXL=81, 공식 GSH 예제로 확인).
- GSC 체결로 **실시간 15분봉** 생성(초기 REST g3203 시드 + 이후 실시간 집계), GSH 로 최우선 매수/매도 호가 수집.
- readiness gate: GSC 30초 이내 수신 + `lastPrice>0` + 15분봉 ≥20 이어야 신규매수 허용(아니면 stale → 신규매수 금지, 보유매도만 stale 표시로 허용).
- **주문은 하지 않습니다**(`LS_LIVE_TRADING=false`, 시세/봉 생성 검증까지만).
- Node 21+ 의 전역 WebSocket 사용(별도 패키지 불필요). 실행 시간은 `LS_WS_SECONDS`(기본 60초).

## 4) Windows 작업 스케줄러 자동 시작

`schtasks` 예 (평일 09:00~15:30 사이 5분마다 트레이드 러너 실행):

```cmd
schtasks /Create /TN "LS-Trade" /TR "cmd /c cd /d C:\path\to\Vol && npm run ls:trade >> local-runner\logs\schtask.out 2>&1" /SC MINUTE /MO 5 /ST 09:00 /ET 15:30 /K /RL LIMITED
```

진단용 1회 실행 예약:
```cmd
schtasks /Create /TN "LS-Diag" /TR "cmd /c cd /d C:\path\to\Vol && npm run ls:diag" /SC ONCE /ST 08:55
```

작업 제거:
```cmd
schtasks /Delete /TN "LS-Trade" /F
```

> 노트북이 절전되면 스케줄러가 못 돌 수 있습니다. 전원 옵션에서 절전 해제 또는
> "컴퓨터를 절전 모드에서 해제하여 이 작업 실행"을 켜세요.
> 상시 구동이 필요하면 NSSM 등으로 서비스 등록도 가능합니다.

## 보안 원칙

- `.env.local`, `local-runner/.cache/`(토큰), `local-runner/logs/` 는 커밋 금지(.gitignore).
- 로그에는 마스킹된 값만 — 앱키/시크릿/토큰/전체 계좌번호 절대 미출력.
- 모든 LS 요청은 공식 문서의 URL/TR/필드만 사용(`src/lib/ls-api.ts`).
