import { defineConfig } from "@playwright/test";

const SERVER_PORT = 3000;
const WEB_PORT = 5173;

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
  },
  // Стек поднимается здесь; Postgres и миграции — снаружи (`npm run test:e2e` в корне).
  webServer: [
    {
      command: "npx tsx src/server.ts",
      cwd: "../apps/server",
      url: `http://localhost:${SERVER_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: String(SERVER_PORT),
        DATABASE_URL: process.env.DATABASE_URL ?? "postgres://retro:retro@localhost:5432/retro",
        VOTER_TOKEN_SECRET: process.env.VOTER_TOKEN_SECRET ?? "e2e-secret-not-for-production",
      },
    },
    {
      command: `npm run dev -w apps/web -- --port ${WEB_PORT} --strictPort`,
      cwd: "..",
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
