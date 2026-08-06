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

## 3) 트레이드 러너 (현재: Phase 1 게이트 + 엔진 로드 확인)

```cmd
npm run ls:trade
```
잔고 점검 통과 + 전략엔진(BB/RSI) 로드 확인까지 수행합니다.
**시세/15분봉/주문(Phase 2)은 LS 공식 TR 확정 후 추가**되며, 그전까지는
`LS_LIVE_TRADING=true` 여도 주문을 실행하지 않습니다(안전 차단).

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
