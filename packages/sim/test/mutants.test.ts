// SIM-12 / REQ-022 — каждый мутант § 10.2 пойман указанной проверкой.
// Контроль: те же конфигурации без мутанта зелёные (иначе падение нельзя приписать мутанту).

import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config.js";
import { MUTANT_DESCRIPTIONS, MUTANT_IDS, type MutantId, mutantHooks } from "../src/mutants.js";
import { runSimulation } from "../src/run.js";

interface Plan {
  readonly profile: "default" | "conflicts" | "faults";
  readonly clients: number;
  readonly ops: number;
  readonly checkpointMin?: number;
  readonly checkpointMax?: number;
  readonly seeds: readonly number[];
  /** Свойства из таблицы § 10.2: хотя бы один прогон обязан упасть на одном из них. */
  readonly properties: readonly string[];
}

const SEEDS = [1, 2, 3, 4];

const PLANS: Record<MutantId, Plan> = {
  M1: { profile: "default", clients: 5, ops: 400, seeds: SEEDS, properties: ["S9", "S6"] },
  M2: { profile: "default", clients: 5, ops: 400, seeds: SEEDS, properties: ["S3", "S4"] },
  M3: { profile: "default", clients: 5, ops: 400, seeds: SEEDS, properties: ["S10"] },
  M4: { profile: "default", clients: 5, ops: 400, seeds: SEEDS, properties: ["S7"] },
  M5: { profile: "faults", clients: 5, ops: 500, seeds: SEEDS, properties: ["S7"] },
  M6: {
    profile: "default",
    clients: 5,
    ops: 1000,
    checkpointMin: 20,
    checkpointMax: 60,
    seeds: SEEDS,
    properties: ["S4"],
  },
  M7: { profile: "default", clients: 5, ops: 400, seeds: SEEDS, properties: ["S4"] },
};

function configOf(plan: Plan, seed: number) {
  const built = buildConfig({
    seed,
    clients: plan.clients,
    ops: plan.ops,
    profile: plan.profile,
    checkpointMin: plan.checkpointMin,
    checkpointMax: plan.checkpointMax,
  });
  if (!built.ok) throw new Error(built.error);
  return built.config;
}

describe("SIM-12 / REQ-022: каждый мутант пойман", () => {
  it("SIM-12 / REQ-022: в таблице ровно мутанты M1–M7", () => {
    expect([...MUTANT_IDS]).toEqual(["M1", "M2", "M3", "M4", "M5", "M6", "M7"]);
  });

  for (const id of MUTANT_IDS) {
    const plan = PLANS[id];
    it(`SIM-12 / REQ-022: мутант ${id} падает на ${plan.properties.join(" или ")}`, {
      timeout: 120_000,
    }, async () => {
      const seen: string[] = [];
      for (const seed of plan.seeds) {
        const run = await runSimulation(configOf(plan, seed), { hooks: mutantHooks(id) });
        if (run.ok) {
          seen.push(`seed ${seed}: зелёный`);
          continue;
        }
        seen.push(`seed ${seed}: ${run.violation.property}`);
        if (plan.properties.includes(run.violation.property)) return;
      }
      expect.fail(
        `мутант ${id} выжил (${MUTANT_DESCRIPTIONS[id]}); ожидалось ${plan.properties.join(
          " или ",
        )}; ${seen.join(", ")}`,
      );
    });
  }

  it("SIM-12 / REQ-022: контроль — без мутанта (hooks: {}) те же конфигурации и seed зелёные", {
    timeout: 300_000,
  }, async () => {
    const bad: string[] = [];
    const done = new Set<string>();
    for (const id of MUTANT_IDS) {
      const plan = PLANS[id];
      for (const seed of plan.seeds) {
        const key = `${plan.profile}/${plan.clients}/${plan.ops}/${plan.checkpointMin}/${seed}`;
        if (done.has(key)) continue;
        done.add(key);
        const run = await runSimulation(configOf(plan, seed), { hooks: {} });
        if (!run.ok) bad.push(`${key}: ${run.violation.property} ${run.violation.message}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
