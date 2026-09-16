import { defineConfig } from "vitest/config";

// test:sim — весь packages/sim/test (docs/design/T-005-simulator.md § 5.1),
// отдельно от обычного test:unit (у пакета нет своего "test", root
// test:unit его не видит) и от test:int: не заходит в БД и в сеть, но
// прогоняет реальные симуляции и поэтому дороже юнит-тестов. Бюджет всего
// набора — ≤ 60 с на машине разработчика (docs/spec/simulator.md § 11.2);
// testTimeout здесь — предохранитель на случай, если один прогон
// симулятора зависнет, а не ожидаемая длительность.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
