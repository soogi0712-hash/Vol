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

## 3) 국내(KR) 자동매매 — 지속 실행 러너 (해외 없음)

```cmd
npm run ls:trade
```
`ls:trade` 는 **국내(KR) 전용 지속 실행 러너**입니다. 해외(US) g3101/g3203 조회는 완전히 제거됐습니다.
**Asia/Seoul 평일 09:00~15:30** 동안 계속 돌며(Ctrl+C 로 종료), 기존 엔진 BB(20,2)·RSI(14)·
`getBBSignal`로 신호를 계산합니다(전략 조건 불변, 확정봉 40개 이상). 기본 `LS_LIVE_TRADING=false`
→ 주문 API 미호출(`[KR-DRY-RUN]`), 파라미터만 검증합니다.

**동작(1분 틱):**

1. **재시작 복원**: 시작 시 `data/us-orders-KR_<종목>.json` 에서 미체결(pending)·주문번호를 로드.
2. **미체결 재확인/취소**: pending 이 있으면 매 틱 `CSPAQ13700` 체결조회 →
   전량체결이면 해소 / 부분·미체결이면 유지 / **`LS_KR_PENDING_TIMEOUT_SEC`(기본 120s) 경과 시
   `CSPAT00801` 로 잔량 취소**(취소 접수 rsp_cd 00000/00156 확인 시에만 해소 → 다음 주문 허용).
3. **미체결 존재 시 신규 주문 차단**(취소 확인 전 다음 주문 금지).
4. 장중이면 **15분봉(t8412) 재조회 → 신호 재평가**. `signal=BUY` 이면 실제 주문 직전까지
   **모든 파라미터 로그**: `[KR-ORDER-PARAMS] IsuNo=A005930 qty=1 price=.. BnsTpCode=2(매수)
   OrdprcPtnCode=00(지정가) MgntrnCode=000 MbrNo=NXT · dup=.. dailyOver=.. live=.. candle=..`.
5. **동일 15분봉 중복주문 금지**(확정봉 datetime 키), **하루 매수 최대 1회**, **maxQty=1**.
6. 주문 API 호출은 `LS_LIVE_TRADING=true` **그리고** 국내장 시간일 때만. 성공 시 **주문번호 즉시 저장**
   → `CSPAQ13700` 로 전량/부분체결 확인. 실패해도 **자동 재주문 없음**.
7. 모든 주문/체결/취소 `rsp_cd`/`rsp_msg` 를 저장(order-store audit).
8. **15:30 이후 신규 주문 금지**. `LS_KR_EXIT_AFTER_CLOSE=true` + 미체결 없음이면 종료, 아니면 대기.
9. **SIGINT/SIGTERM** 정상 종료(저장 flush 후 exit).

공식 TR(필드 확인분): 매수 `CSPAT00601`(BnsTpCode=2, OrdprcPtnCode=00) → OrdNo · 체결조회
`CSPAQ13700`(OutBlock2 BuyOrdQty/BuyExecQty) · 취소 `CSPAT00801`(OrgOrdNo/IsuNo/OrdQty, rsp_cd 00156=취소접수).

#### 🔴 중복주문 방지 (SK하이닉스 3중 체결 버그 수정)

실계정에서 같은 15분봉에 1주씩 3회 체결된 사고를 다음으로 수정했습니다:

1. **성공코드 재검토**: `CSPAT00601` `rsp_cd=00040`("매수 주문이 완료되었습니다.")를 성공 allow-list에
   추가. 이전에는 실패로 오판(throw)되어 dedup 기록이 안 되고 재주문됐습니다.
2. **성공 판정 = OrdNo 존재 또는 성공코드**(`isKROrderSuccess`). 코드 몰라도 주문번호가 있으면 성공.
3. **candle lock 을 "전송 직전"(응답 해석 전) 기록 + 즉시 flush**. 주문을 보낸 순간 같은 확정봉
   추가 주문을 **영구 차단**. 전송 후 API/네트워크/파싱 오류가 나도 **재주문하지 않습니다**.
4. **거래소 대사(reconciliation)**: 주문 전 `CSPAQ13700` 로 당일 매수주문 수량을 확인해 로컬 기록보다
   많으면(=로컬이 놓친 주문) 전송을 금지합니다.
5. **현금 주문가능금액(`MnyOrdAbleAmt`, CSPAQ12200) 사전 확인**: `price*qty > 현금가능액` 이면 절대
   `CSPAT00601` 을 호출하지 않습니다. **신용/증거금 가능액은 매수 판단에 사용하지 않습니다.**

> ⚠️ `MbrNo`(회원/거래소 라우팅)는 공식 예제값 `"NXT"` 기본(`LS_KR_MBR_NO` 로 조정). KRX 라우팅이
> 필요하면 실주문 전 `[KR-ORDER-PARAMS]` 로그로 확인하세요. 지정가는 현재가를 원 정수로 반올림하므로
> **틱사이즈 준수는 실주문 전 확인**하세요. 스케줄러 예약 시 09:00 시작으로 등록하면 됩니다.

- 거래소코드(exchcd)는 확인분만: **NASDAQ=82, NYSE=81**. 미확인 거래소(AMEX 등)는
  추측하지 않고 `UNSUPPORTED_EXCHANGE`로 로그 후 스킵합니다(공식 코드 확인 후 추가).
- 오류는 종류별로 구분 기록: 네트워크오류 / 호출제한 / 빈응답 / 데이터부족 / API오류 / 무효응답.
- TR: 국내현재가 `t1102`, 해외현재가 `g3101`, 국내분봉 `t8412`, 해외분봉 `g3203` (모두 공식).

### 해외 15분봉(g3203) 공식 요청 제한 — 비압축 qrycnt ≤ 5

LS 공식 문서상 `g3203` 는 **비압축(`comp_yn="N"`) 시 `qrycnt` 최대 5**, 압축(`comp_yn="Y"`) 시
최대 2000 입니다. 과거 코드가 `comp_yn="N"` 에 `qrycnt=120` 을 보내 **공식 제한을 위반**했고,
이것이 빈 응답(빈 `rsp_cd`/`rsp_msg`)의 원인이었습니다. 수정:

- 단건 호출 `getLSUS15Min` 은 `comp_yn="N"`, `qrycnt` 를 **공식 상한 5 로 강제 clamp**.
  (압축 응답 해제 방식은 공식 문서에서 확인되지 않아 사용하지 않습니다 — 추측 금지.)
- 20개 이상 확보가 필요하면 `getLSUS15MinPaged` 로 **연속조회**: 응답 헤더 `tr_cont="Y"` +
  `tr_cont_key` 를 다음 요청 헤더로 넘겨 5봉씩 최대 12회 반복(=60봉), timestamp 중복 제거.
  `g3203InBlock` 에는 `cts_date/cts_time` 입력 필드가 없으므로(공식) 연속조회는 헤더 방식만 사용합니다.
- 빈 응답 진단 로그에 `qrycnt / comp_yn / ncnt / tr_cont / tr_cont_key` 를 반드시 출력합니다.

#### g3203 이 빈 응답일 때 — g3202(과거 틱) fallback + WebSocket 누적

실계정에서 `g3203` 이 `rsp_cd=''`, `rec_count=0`, `tr_cont=N` 으로 **빈 응답**이면 연속조회가
시작조차 안 됩니다. 이때 공식 대체 TR 을 다음 순서로 사용합니다(가짜 봉 생성·readiness 우회 금지):

1. **g3202 (NTICK, 과거 틱)** → 15분 재집계. `date+loctime`(America/New_York)로 15분 버킷팅,
   `open/high/low/close/exevol` 집계, 최신(형성) 버킷 제외, 거래 없는 구간은 채우지 않음.
   비압축 `qrycnt=5` + `tr_cont` 연속조회로 최대 40회 누적(틱은 같은 시각 중복이 정상 → dedup 안 함).
2. g3202 도 빈 응답이면 **WebSocket GSC 누적만으로** 확정봉을 모읍니다. `confirmed≥20` 전에는
   신규매수 금지(readiness 게이트 유지), 오늘 실주문 없음.

> `g3103`(일주월)·`g3204`(일주월년)은 **일봉류**라 15분봉 전략에 부적합 → 사용하지 않습니다.

#### 어떤 TR 이 과거 데이터를 주는지 진단 — `npm run ls:us-history-diag`

```cmd
npm run ls:us-history-diag
```
AAPL 1종목에 대해 `g3203 / g3202 / g3103 / g3204` 를 각 1회 호출해
`rsp_cd`, `rawCount`(행수), 시간범위, **생성 가능한 15분봉 수**를 출력합니다.
실계정에서 어떤 TR 이 실제로 과거 데이터를 반환하는지 경험적으로 확인하는 용도입니다. 주문 없음.

### Warm-up 모드 (확정봉 < 20)

최초 설치 후 확정봉이 20개 미만이면 **Warm-up** 상태입니다.

- READY 로그에 `warmup=true remaining=12` 형태로 **남은 개수**를 표시합니다.
- Warm-up 동안에도 BB(20,2)·RSI(14)·Signal 을 **계속 계산**해 `[WARMUP ...]` 로그로 남깁니다
  (확정봉 부족으로 BB 미산출 시 `signal=NONE`).
- 확정봉이 **20개가 되는 순간 자동으로 `READY=true`** 로 전환됩니다(GSC/GSH 신선·호가>0 조건 충족 시).
- 저장된 확정봉은 영구 유지되어, 재설치가 아니라면 다음날도 8→9→10…개로 **누적**됩니다.
- ⚠️ confirmed 를 가짜 봉으로 채우지 않습니다. `remaining` 은 실제 확정봉 수만 반영합니다.

### ARMED 모드 — 조건 감시 전용(주문 없음)

`LS_TRADING_ARMED=true` 로 켜면 `ls:usws` 가 10초마다 **실주문 10개 필수조건**의 충족 여부를
`[ARMED ...]` 로그로 남깁니다. **주문은 절대 내지 않습니다**(조건 감시만).

10개 조건: ① `confirmed≥20` ② `signal=BUY` ③ `wsConnected` ④ GSC ≤300초 ⑤ GSH ≤30초
⑥ `bid/ask/lastPrice>0` ⑦ 미국 정규장(America/New_York 09:30–16:00, 평일) ⑧ 주문가능수량(예수금)
조회 성공 ⑨ 동일 확정봉 중복주문 없음 ⑩ 미체결 주문 없음. 전부 충족되면
`[ARMED-READY]` 로그를 남기되 **주문은 하지 않습니다**.

> 공휴일 달력은 공식 소스가 없어 반영하지 않습니다(휴장일엔 거래소가 주문을 거부). 평일+시간만 판정.

### 실주문 게이트 — 3중 차단

실주문은 다음이 **모두** 참일 때만 실행되도록 설계했고, 현재는 실행 불가 상태입니다:

1. ARMED 10개 조건 전부 충족, **그리고**
2. `LS_LIVE_TRADING=true` (사용자가 전체 테스트 후 직접 변경), **그리고**
3. `LS_CANCEL_TR_CONFIRMED=true` — **미체결 취소 TR(COSAT00311) 공식 필드 확인 시에만 true**.

현재 3번이 `false`(취소 TR 공식 필드 미확인 → 추측 금지)이므로, `LS_LIVE_TRADING=true` 로
바꿔도 실주문은 차단됩니다. `[ARMED-READY]` 로그만 남습니다.

**구현된 주문 기능(공식 필드 확인분, 단위테스트 완료):**
- 지정가 매수 `COSAT00301`(OrdPtnCode=02 매수, OrdprcPtnCode=00 지정가)
- 체결/미체결 조회 `COSAQ00102`(OrdNo/ExecQty/UnercQty)
- 해외 예수금/주문가능 조회 `COSOQ02701`(cash-only 결제 판정 — 공식 필드 확인분: OutBlock3 USD `FcurrDps`(USD현금)·`PrexchOrdAbleAmt`(선환전 주문가능)·`BaseXchrat`(기준환율), OutBlock4 `WonDpsBalAmt`(원화현금)·`WonPrexchAbleAmt`(원화 선환전)·`OvrsMgn`(해외증거금))
- 주문상태 영구저장 `order-store`(하루 매수1/매도1 한도, 동일봉 중복방지, 미체결 추적, **재시작 중복주문 방지**)
- 오케스트레이션 `trader`(전송→기록→체결확인→미체결취소, 방어적 재검증)

**미확인(공식 필드 확보 후 구현 예정 — 그전까지 LIVE 차단):**
- 미체결 취소/정정 `COSAT00311` (카탈로그에 요청 필드 없음)
- 매도상환 `COSMT00300` (카탈로그에 요청 필드 없음)

### P0-15 — 해외주식 cash-only 결제(USD 현금 OR 원화현금 선환전) 판정 근거

실계정 `COSOQ02701` 이 `rsp_cd=00136`·USD `FcurrDps=0.00`(USD 현금 0)을 반환했으나, 해당 계좌는
**원화현금 선환전(원화주문)** 으로 미국주식 주문이 가능하다. **오늘 국내장 실제 미수 사고**가 있었으므로
`USD=0` 을 이유로 안전장치를 우회하거나 **신용/미수/대출/증거금(레버리지)** 을 절대 사용하지 않는다.
공식 카탈로그 `COSOQ02701` resExample 로 아래 필드를 확인해 두 경로로 판정한다(추측 없음):

| 블록 | 필드 | 의미 | 용도 |
|---|---|---|---|
| OutBlock3(USD) | `FcurrDps` | 외화예수금(순수 USD 현금) | USD 결제 경로 |
| OutBlock3(USD) | `PrexchOrdAbleAmt` | 선환전 주문가능(USD, LS가 환haircut 반영) | 원화결제 경로 상한(USD) |
| OutBlock3(USD) | `BaseXchrat` | 기준환율(USD→KRW) | 원화환산 |
| OutBlock4 | `WonDpsBalAmt` | 원화예수금잔고(실제 KRW 현금) | 원화결제 경로 현금근거 |
| OutBlock4 | `MnyoutAbleAmt` | 출금가능금액(전액출금=순수현금 근거) | — |
| OutBlock4 | `WonPrexchAbleAmt` | 원화 선환전 가능(KRW) | 원화결제 경로 현금 |
| OutBlock4 | `OvrsMgn` | 해외증거금(미수/레버리지) | **>0 이면 즉시 차단** |

판정(`decideUSCashPayment`): ① `OvrsMgn>0` → 차단 ② USD현금 ≥ 필요USD → **USD 결제**
③ 아니면 공식 선환전가능(USD) ≥ 필요USD **그리고** `min(WonDpsBalAmt, WonPrexchAbleAmt)` ≥ 필요USD×환율
→ **원화현금 선환전 결제**, 아니면 `KRW_CASH_INSUFFICIENT` 차단. 원화현금은 실제 예수금을 초과할 수
없도록 `min` 으로 캡해 레버리지 유입을 차단한다. 진단 로그 `[STARTUP-US-CASH]`/`[BUY-US-CASH]`:
`USD cashOrderable / KRW cashOrderable / 선환전USD / 기준환율 / 미수(OvrsMgn) / estimated 1share / paymentMode / orderAllowed`.

### COSAT00311(미체결 취소) 공식 필드 확인 결과 — 근거

Phase 3A 완성을 위해 취소 TR 을 구현하려 했으나, **공식 필드를 확인하지 못했습니다.** 확인 경로와 결과:

| 출처 | 결과 |
|---|---|
| LS 공식 카탈로그 스냅샷(`blocks.json`) | `COSAT00311` → `in_blocks:{}`, `out_blocks:{}` (필드 없음) |
| 공식 카탈로그 API 파일 | `COSAT00311` → `reqExample:null`, `resExample:null` |
| LS 공식 포털(`openapi.ls-sec.co.kr`) | HTTP 403(비로그인 접근 차단) |
| 제3자 라이브러리(`smallfish06/krsec`) | "LS 주문 정정/취소는 `ErrNotSupported` 반환"(미구현) |

`COSAT00301`(주문)·`COSAQ00102`(체결)·`COSOQ00201`(잔고)·`COSOQ02701`(예수금)은 공식 필드가
카탈로그에 있어 구현했지만, **`COSAT00311` 은 어느 공식 출처에도 요청 필드(원주문번호/취소수량/
정정취소구분 등)가 없습니다.** 추측 금지 원칙에 따라 **취소 요청 본문을 임의로 만들지 않았습니다.**

→ 결과: `cancelLSUSOrder` 는 예외를 던지고, 코드 상수 `LS_CANCEL_TR_CONFIRMED=false` 가
**실주문을 3중 차단**합니다. 취소 흐름은 **모의(주입식) 함수로 BUY→PENDING→CANCELLED 를
단위테스트로 검증**했습니다(`test/trader.test.ts`). 공식 `COSAT00311` 스펙(요청 InBlock 필드,
원주문번호 필드명, 정정/취소 구분값, 응답 필드)을 주시면 즉시 실함수로 교체하고 상수를 켭니다.

### 계좌 WebSocket 주문 이벤트 추적 (AS0~AS4)

기존 시세 WebSocket 연결에서 **계좌 주문 이벤트**도 등록해 주문 상태를 실시간 통보받습니다.

- 등록: `{header:{token, tr_type:"1"}, body:{tr_cd:"AS0"|"AS1"|"AS2"|"AS3"|"AS4", tr_key:""}}`.
  `tr_type` — **1=계좌등록**, 2=계좌해제, 3=시세등록, 4=시세해제. GSC/GSH 는 `"3"` 유지, AS0~AS4 는 `"1"`.
  재연결 시 GSC/GSH + AS0~AS4 **모두 자동 재등록**.
- **AS0 접수** → `ACCEPTED` (sOrdNo/sOrgOrdNo/sOrdMktCode/sOrdPtnCode/sShtnIsuNo/sOrdQty/sOrdPrc/sUnercQty/sRjtRsn)
- **AS1 체결** → `sUnercQty>0` 이면 `PARTIALLY_FILLED`, `==0` 이면 `FILLED`. 누적 체결수량·평균가 저장.
  동일 `sExecNO`/`sAbrdExecId` 중복 이벤트 무시. FILLED 확인 전 체결 완료 처리 안 함.
- **AS2 정정** → `MODIFIED` (확인 이벤트로만 처리, REST 정정 요청은 구현/호출 안 함)
- **AS3 취소** → `sOrgOrdNo` 로 원주문을 찾아, 취소확인수량>0 & 거부사유 없음일 때만
  `CANCELLED`(부분체결 후면 `PARTIALLY_FILLED_CANCELLED`). 중복 AS3 는 idempotent 무시.
- **AS4 거부** → `REJECTED` (주문번호·원주문번호·거부사유 저장, 확인된 공통 필드만)
- 상태 전이: `CREATED→SUBMITTED→ACCEPTED→PARTIALLY_FILLED/FILLED→MODIFIED→CANCELLED/PARTIALLY_FILLED_CANCELLED→REJECTED`.
  **역방향 전이는 차단**합니다. 상태는 원주문번호 기준으로 디스크 저장 → 재시작 복원.
- 보안: 계좌번호 전체 미출력, 앱키/시크릿/토큰 마스킹, 저장 시 민감정보 미포함(파싱된 안전 필드만).

> ⚠️ **AS0~AS4 는 주문·정정·취소를 "실행"하는 API 가 아니라 상태 통보 이벤트입니다.**
> 특히 **AS3 는 취소 "결과 확인" 이벤트**이지 취소 "요청" 이 아닙니다. 따라서 AS3 수신만으로
> 취소 기능이 구현됐다고 판단하지 않습니다. LIVE 취소 완료는 **REST 취소(COSAT00311) 성공 AND
> 해당 원주문번호 AS3 수신** 두 조건을 모두 만족해야 하며(`isCancelComplete`), REST 취소가
> 미구현(공식 필드 미확인)이므로 `LS_CANCEL_TR_CONFIRMED=false` 와 실주문 하드 차단을 유지합니다.

### Phase 3A 오늘 실전 제한(코드로 강제)

`LS_US_LIVE_SYMBOL`(기본 NASDAQ:AAPL) 1종목 · `LS_US_MAX_QTY=1`(상한 강제) · 지정가만 ·
매수가=GSH ask · 매도가=GSH bid · 하루 매수/매도 각 1회 · 정규장만 · `confirmed≥20`+`signal=BUY`+
READY · 미체결 시 신규 금지 · 동일봉 중복 금지 · 주문번호 즉시 디스크 저장 · `COSAQ00102` 체결확인 ·
미체결 `LS_US_PENDING_TIMEOUT_SEC`(기본 60s) 경과 시 취소 시도 · 취소 성공 전 다음 주문 금지 ·
재시작 시 pending·주문번호 복원 · 매도는 보유수량(`COSOQ00201` `AstkSellAbleQty`) 확인 후 최대 1주 ·
모든 LS 원문 `rsp_cd/rsp_msg` 저장 · 실패해도 자동 재주문 금지.

**현재 실주문은 실행되지 않습니다** — 취소 TR 미확인으로 3중 차단 유지, `LS_LIVE_TRADING=false`.

#### US 주문 중복방지 (KR 3중체결 사고 패턴 이식)

국내에서 발생한 중복주문 사고 방지 패턴을 미국 주문 경로(`executeBuyOrder`)에도 동일 적용했습니다:

- **`US_ORDER_POST_IDEMPOTENT`** — `COSAT00301` 전송 **직전**(응답 해석 전) candle lock 을 영구 저장+flush.
  같은 확정봉 BUY 신호가 3번 반복돼도 **실제 POST 는 1회**. HTTP/timeout/500/parse/rsp_cd 오류 뒤에도 **재POST 0회**.
- **`US_CASH_ONLY_GATE`** — 주문 직전 예수금(`COSOQ02701`) 재조회. **두 경로**로 현금결제 판정
  (`decideUSCashPayment`): ① USD 현금(`FcurrDps`) 충분 → USD 결제 ② USD=0 이면 **원화현금 선환전**
  (`PrexchOrdAbleAmt`/`WonPrexchAbleAmt`, 실제 예수금 min 캡). `orderAllowed=false`이면 `COSAT00301`
  **미호출**. **`OvrsMgn`(해외증거금)>0 이면 즉시 차단** — 신용/미수/대출/증거금 레버리지 절대 미사용. (P0-15)
- **`US_PENDING_REORDER_BLOCKED`** — pending 주문이 하나라도 있으면 신규 BUY 금지.
- **`US_RESTART_RECONCILIATION`** — 주문 전 `COSAQ00102` 로 당일 실제 매수주문과 로컬 OrderStore 를
  대사. 조회 실패 또는 로컬 미기록 주문 감지 시 신규 BUY 금지(재시작 후에도).
- **`US_AS_EVENT_LINKED`** — AS0/AS1/AS3/AS4 상태추적을 **주문번호로 pending 과 연결**(`linkTrackedToOrders`).
  종결(FILLED/CANCELLED/PFC/REJECTED) 이벤트 수신 시 해당 주문번호 pending 을 해소.
- 성공 판정 = **OrdNo 존재 또는 성공코드(00000)**(`isUSOrderSuccess`) — 미확인 성공코드도 OrdNo 로 성공 처리.

> 오늘 첫 미국 실전 대상: `LS_US_LIVE_SYMBOL`=NASDAQ:AAPL 1종목, 1주, 하루 BUY 1회.

#### 수동취소 모드(MANUAL_CANCEL_MODE) + P0 체크리스트 (실전 투입 게이트)

REST 자동취소 TR(COSAT00311)은 공식 필드 미확인이라 **자동취소(AUTO_CANCEL_MODE)는 불가**합니다.
대신 **수동취소 모드**로 실전 운영합니다:

- **P0-1**: `AUTO_CANCEL_MODE=false`, `MANUAL_CANCEL_MODE=true`(코드상수로 강제).
- **P0-2**: 미체결 주문 발생 시 자동취소하지 않고 `[MANUAL-CANCEL] 미체결 주문 발생. LS HTS/MTS에서
  수동취소하십시오.` 를 출력하며, **pending 유지 → 다음 BUY 절대 금지**.
- **P0-3**: **AS3(취소 확인) 수신** 시 해당 원주문을 `CANCELLED` 로 바꾸고 pending 을 해소 →
  그때만 다음 BUY 허용(`linkTrackedToOrders`). (체결 AS1 도 동일하게 해소)
- **P0-4**: `LS_LIVE_TRADING=true` 라도 아래 전부여야 실제 POST — READY·confirmed≥20·signal=BUY·
  wsConnected·GSC fresh·GSH fresh·bid/ask/lastPrice>0·pending=0·하루 BUY<1·candle lock 없음·현금 충분.
- **P0-5**: POST 직전 현금(USD) **재조회**, `price×qty > cashOrderable` 이면 POST 금지.
- **P0-13**: **프로그램 시작 직후**(BUY 신호와 무관) AAPL `cashOrderable` 1회 조회 →
  `[STARTUP-CASH] cashOrderable=5234.15 USD rsp_cd=00000` 출력. **조회 실패면 LIVE 금지**(liveCapable=false).
  성공값은 메모리 캐시(60초), BUY 직전 executeBuyOrder 가 다시 재조회해 부족하면 POST 금지.
- **P0-6~P0-9**: AAPL·qty1·하루1(추가매수/물타기 금지) · OrdNo 저장 + AS 연결 · 재시작 대사 완료 전 BUY 금지 ·
  같은 candle BUY 신호 **100회 반복돼도 실제 POST 1회**.

러너 시작 시 `[P0-CHECKLIST]` 로 10개 플래그와 `US_LIVE_READY` 를 출력합니다.
**모두 true 여야 오늘 실전 가능**하며, `LS_LIVE_TRADING=true` 로 켜면 수동취소 모드로 BUY 가 실행됩니다.
하나라도 false 면 `LS_LIVE_TRADING=false` 를 유지하세요.

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
- readiness gate(신규매수): `wsConnected` + `bestBid>0` + `bestAsk>0` + **GSH 최근 30초** +
  `lastPrice>0` + **GSC 최근 300초** + **확정봉 ≥20** + 저장 정상. 하나라도 어긋나면 신규매수 금지.
  체결(GSC)이 뜸한 30초는 연결 장애가 아니므로 GSH 만 신선하면 stale 로 보지 않습니다.
  GSC 300초 초과 시 신호 계산·신규매수만 중단하고, 보유 매도 허용은 별도 안전정책으로 유지합니다.
- READY 로그는 상태를 항목별로 출력합니다: `confirmed=.. forming=.. gscAgeSec=.. gshAgeSec=.. wsConnected=.. bid=.. ask=..`.
- **주문은 하지 않습니다**(`LS_LIVE_TRADING=false`, 시세/봉 생성 검증까지만).
- Node 21+ 의 전역 WebSocket 사용(별도 패키지 불필요).

#### 15분봉 영구 저장·복원 (지속 실행형)

`ls:usws` 는 **Ctrl+C 전까지 계속** 돌며, GSC 로 만든 15분 확정봉을 종목별 JSON
(`local-runner/data/us-candles-<심볼>.json`)에 **즉시 영구 저장**합니다.

- **버킷 기준 시각**: GSC `ovsdate`+`trdtm`(미국 현지=America/New_York 벽시계)로 15분 버킷팅 →
  서머타임(EDT/EST) 자동 반영. 한국시간 문자열로 버킷팅하지 않습니다.
- **확정 vs 형성**: 버킷이 바뀌면 직전 봉을 **확정**해 즉시 디스크에 저장(같은 timestamp 중복 저장 금지).
  형성 중(최신) 봉은 정상 종료(Ctrl+C) 시에만 저장합니다.
- **복원**: 시작 시 저장된 확정봉을 불러와 BB/RSI 계산에 사용(0개부터 다시 시작하지 않음).
  REST g3203 시드가 0개여도 저장분으로 진행하며, REST 실패는 WebSocket 을 막지 않습니다.
- **안전성**: 임시파일 write 후 rename(atomic). 파일 손상 시 `.corrupt` 백업 + **신규매수 차단**.
  저장 파일에는 **OHLCV+timestamp 만** 담기며 앱키/토큰/계좌번호는 절대 저장하지 않습니다.
- **전략 연결(관찰)**: 확정봉 ≥20 이면 BB(20,2)/RSI(14)/`getBBSignal` 로 신호를 계산해
  `[OBSERVE ...]` 로그만 남깁니다. 신호가 나와도 **주문 함수는 호출하지 않습니다**.
- `local-runner/data/` 는 `.gitignore` 로 커밋 차단됩니다(런타임 데이터).

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
