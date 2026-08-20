# Vol KR/US 역매공파 서버 상시운영 배포 (P0-36)

Windows 로컬 데몬을 Ubuntu 서버 `/opt/phoenix/vol` 의 Docker Compose 상시운영으로 이전한다.
목표: **PC 가 꺼져 있어도 서버가 24h 살아 KR/US 세션을 자동 판단하고 장중에만 실거래.**

> ⚠️ **전략/금액/손절익절/역매공파 로직 무변경.** 자격증명은 `secrets/vol.env`(서버 호스트 전용, git/image 미포함).
> 아래 명령을 문서로 제공하되 **자격증명 값을 출력·커밋하지 말 것.**

## 구성 요약
- `vol-kr` / `vol-us` — 동일 이미지, command 만 다름(장애 격리, item 1·13).
- `restart: unless-stopped` — 크래시/서버 재부팅 자동복구(item 2·3).
- 세션 판단은 코드가 IANA 존(`Asia/Seoul`·`America/New_York`, DST 자동)을 직접 사용 → 컨테이너 TZ 무관하게 정확(item 6·7). 장외에는 주문 없이 sleep, 정규장(REGULAR)만 실주문(item 5).
- 상태(`data`/`.cache`/`logs`)는 `./state` bind mount 로 영속(item 9·10·12).
- healthcheck = 데몬이 매 cycle 쓰는 하트비트 신선도(item 11).

## 0) 사전 준비 (서버, 최초 1회)
```bash
# Ubuntu 서버에 Docker Engine + compose plugin 설치되어 있어야 함
docker --version && docker compose version

sudo mkdir -p /opt/phoenix
sudo chown "$USER":"$USER" /opt/phoenix
cd /opt/phoenix
git clone <this-repo-url> vol      # 또는 기존 체크아웃 사용
cd /opt/phoenix/vol
git checkout claude/vol-repo-git-status-ythsco
```

## 1) 시크릿 파일 작성 (서버에만, git/image 금지)
```bash
mkdir -p secrets
cp secrets/vol.env.example secrets/vol.env
# secrets/vol.env 를 편집해 실제 LS 발급 KEY/SECRET/계좌 + 실거래 스위치 입력
#   (에디터로 직접 입력. 값을 터미널에 echo/cat 하지 말 것)
chmod 600 secrets/vol.env
```

## 2) 상태 디렉터리 + (선택) Windows 캐시 이전
```bash
mkdir -p state/data state/logs state/cache
# 기존 Windows 일봉 캐시/원장을 그대로 이전하면 재빌드 없이 즉시 운영 가능:
#   Windows 의 <Vol>\local-runner\data\*  →  서버 state/data/
#   Windows 의 <Vol>\local-runner\.cache\* →  서버 state/cache/  (선택)
# 예: 로컬에서 rsync/scp 로 state/data 채우기.
# 컨테이너는 node(uid 1000)로 실행되므로 소유권 정리:
sudo chown -R 1000:1000 state
```
캐시가 없으면 최초 1회 pool 구축(오래 걸림, rate-limit 준수):
```bash
docker compose build
docker compose run --rm vol-kr node --import tsx local-runner/yeokmae-build-kr-history.ts
docker compose run --rm vol-us node --import tsx local-runner/yeokmae-build-us-history.ts
```

## 3) ⚠️ 이중 실행 방지 (중요)
서버 가동 전 **Windows 자동시작을 반드시 중지** — 같은 LS 계좌에 두 곳이 붙으면 안 됨.
```
Windows:  powershell -ExecutionPolicy Bypass -File scripts\uninstall-yeokmae-autostart.ps1
          (실행 중 supervisor 는 Ctrl+C)
```
> 방어선: 서버/로컬이 동시에 붙어도 **주문 전 거래소 주문내역 대사(CSPAQ13700/COSAQ00102)** 가
> 상대가 낸 주문을 감지해 중복 POST 를 차단한다(item 15 기존 안전장치). 그래도 운영상 한쪽만 가동할 것.

## 4) 기동 (PC 없이 계속 동작, item 14)
```bash
cd /opt/phoenix/vol
docker compose up -d --build
docker compose ps                 # vol-kr / vol-us: Up (healthy)
```
서버 부팅 시 자동 복구를 위해 Docker 서비스 활성화(대부분 기본 활성):
```bash
sudo systemctl enable docker
```

## 5) 상태/로그 확인
```bash
docker compose ps
docker inspect --format '{{.Name}} {{.State.Health.Status}}' vol-kr vol-us
docker compose logs -f --tail=100 vol-kr      # [YEOKMAE-KR-LOOP] cycle=... 지속 출력
docker compose logs -f --tail=100 vol-us      # [YEOKMAE-US-LOOP] cycle=...
# 파일 로그(rotation): state/logs/kr-live.log, us-live.log (데몬 내부 rotation)
#                       + docker json-file 로그(max 10m x5)
```

## 6) 컨테이너 재생성 후 상태복원 검증 (item 10)
```bash
docker compose up -d --force-recreate vol-kr
docker compose logs --tail=50 vol-kr | grep -E "RECONCILE|HOLDINGS-DIAG|LIVE-CFG|MANUAL-HOLDING"
# state/data 의 us-yeokmae-positions.json / us-orders-* / pending 이 그대로 복원되고
# 시작 시 reconcile 로 broker 대사 후 loop 재개되어야 함(managed position 유지, 수동보유 자동 SELL 금지).
```

## 운영 명령
```bash
docker compose restart vol-us            # 한 시장만 재시작(다른 시장 무영향, item 13)
docker compose stop                      # graceful (SIGTERM → 데몬 store flush → 종료)
docker compose down                      # 컨테이너 제거(상태는 ./state 에 보존)
docker compose pull; docker compose up -d --build   # 코드 갱신 배포
```

## 절전/재부팅 (item 9 보고)
- 서버가 꺼져 있거나 절전이면 당연히 거래 불가. 서버는 상시 전원/네트워크 권장(절전 비활성).
- 재부팅 후: `restart: unless-stopped` + `systemctl enable docker` 로 컨테이너 자동 복구.

---
**주의:** 이 문서는 배포 절차만 정의한다. 실제 서버 반영(`docker compose up -d`)은 사용자가
자격증명(`secrets/vol.env`)을 채운 뒤 직접 실행한다.
