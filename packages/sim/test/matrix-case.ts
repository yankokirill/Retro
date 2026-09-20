// SIM-09 / docs/spec/simulator.md § 11.2 — матрица `test:sim`: 6 профилей ×
// 4 фиксированных seed × --ops=1500, --clients от 3 до 8, плюс один случайный
// seed на профиль `default`.
//
// Каждая пара «профиль × seed» — отдельный файл test/matrix/*.test.ts: vitest
// распараллеливает только файлы, а прогон — чисто процессорная работа, так что
// один файл на пару загружает все ядра ровно. Число клиентов — функция пары
// (не случайность): порядок профилей и seed фиксирован.

import { expect, it } from "vitest";
import { buildConfig, PROFILES, type Profile, runSimulation } from "../src/index.js";

export const OPS = 1500;
export const FIXED_SEEDS = [1, 2, 3, 4] as const;

/** 3..8, детерминированно от позиции пары в матрице. */
export function clientsFor(profile: Profile, seed: number): number {
  const position = PROFILES.indexOf(profile) * FIXED_SEEDS.length + (seed - 1);
  return 3 + (position % 6);
}

export function defineMatrixCase(profile: Profile, seed: number, clients: number): void {
  it(`SIM-09 / I1.2 / REQ-022: profile=${profile} seed=${seed} clients=${clients} ops=${OPS} — S1–S11 не нарушены`, async () => {
    const built = buildConfig({ seed, clients, ops: OPS, profile });
    if (!built.ok) throw new Error(`невалидная конфигурация матрицы: ${built.error}`);
    const result = await runSimulation(built.config);
    if (!result.ok) {
      // Воспроизведение: те же (profile, seed, clients, ops) в runSimulation детерминированы (SIM-02).
      throw new Error(
        `нарушение ${JSON.stringify(result.violation)}; воспроизвести: profile=${profile} seed=${seed} clients=${clients} ops=${OPS}`,
      );
    }
    expect(result.ok).toBe(true);
  });
}
