// SIM-07 — docs/spec/simulator.md § 7: досылка всегда завершается покоем.
// Снаружи (через `runSimulation`) наблюдается только положительная часть:
// прогон ok, а контрольная точка была (значит покой на ней достигнут, иначе
// было бы нарушение S9). Кр. 1–2 (S9 при превышении B / пустых каналах при
// P ≠ ∅) требуют доступа к внутренностям `drain`, у которого нет публичного
// порта; `checks.ts` S9 не содержит. Это перечислено в отчёте.

import { describe, expect, it } from "vitest";
import { buildConfig, type Profile, runSimulation } from "../src/index.js";

const PROFILES_UNDER_TEST: readonly Profile[] = ["default", "chaos", "faults"];
const SEEDS = [1, 2, 3];

describe("SIM-07: досылка завершается покоем", () => {
  for (const profile of PROFILES_UNDER_TEST) {
    for (const seed of SEEDS) {
      it(`SIM-07 / REQ-024 / REQ-025: profile=${profile} seed=${seed} — досылка на контрольных точках завершилась покоем`, async () => {
        const built = buildConfig({
          seed,
          clients: 5,
          ops: 600,
          profile,
          checkpointMin: 100,
          checkpointMax: 250,
        });
        if (!built.ok) throw new Error(`невалидная конфигурация: ${built.error}`);
        const result = await runSimulation(built.config);
        if (!result.ok) {
          expect(
            result.violation.property,
            `profile=${profile} seed=${seed}: ${result.violation.message}`,
          ).not.toBe("S9");
        }
        expect(result.ok, `profile=${profile} seed=${seed}`).toBe(true);
        // несколько контрольных точек: диапазон 100–250 при 600 E1 + обязательная в конце
        expect(result.stats.checkpoints).toBeGreaterThanOrEqual(2);
      }, 120_000);
    }
  }
});
