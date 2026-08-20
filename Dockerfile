# Vol KR/US 역매공파 자동매매 데몬 (P0-36) — Ubuntu 서버 상시운영용 단일 이미지.
#   vol-kr / vol-us 서비스가 동일 이미지에서 command 만 바꿔 실행. 전략/주문 코드 무변경.
FROM node:22-slim

# tini: PID1 로 SIGTERM 을 node 로 전달(graceful shutdown) + 좀비 수거.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# 의존성 먼저(레이어 캐시). tsx 는 devDependency 이므로 전체 설치.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 소스 복사(.dockerignore 로 data/logs/.cache/.env/secrets/state 제외).
COPY . .

# 런타임 상태 디렉터리 — 볼륨 마운트가 덮지만 기본 생성 + node 소유권.
RUN mkdir -p local-runner/data local-runner/logs local-runner/.cache \
 && chown -R node:node /app

USER node

# 데몬은 node --import tsx 로 단일 프로세스 실행 → tini 가 전달한 SIGTERM 이 데몬 핸들러에 직접 도달(graceful).
ENTRYPOINT ["/usr/bin/tini","-g","--"]
CMD ["node","--import","tsx","local-runner/yeokmae-us-live.ts"]
