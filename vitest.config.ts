import { defineConfig } from 'vitest/config';

// 유닛 테스트 전용 설정 — Cloudflare Pages 빌드 플러그인을 배제하고
// 순수 로직만 Node 환경에서 실행한다.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
