import { defineConfig } from "vitest/config";

// Интеграционные тесты (*.int.test.ts, реальный Postgres в Testcontainers,
// CLAUDE.md § 6 шаг 6) — отдельный конфиг vitest.int.config.ts и команда
// test:int, не часть обычного `npm test` (быстрый, без Docker).
export default defineConfig({
  test: {
    environment: "node",
    exclude: ["dist/**", "node_modules/**", "**/*.int.test.ts"],
  },
});
