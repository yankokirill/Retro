import { defineConfig } from "vitest/config";

// *.int.test.ts — реальный Postgres в Testcontainers (CLAUDE.md § 6 шаг 6).
// Отдельно от vitest.config.ts: поднятие контейнера занимает секунды,
// не должно тормозить обычный `npm test`; запускается через `npm run test:int`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.int.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
