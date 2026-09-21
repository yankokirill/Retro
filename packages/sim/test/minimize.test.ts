// SIM-10 кр. 2 — минимизация: минимальная трасса падает на том же свойстве, и удаление любого
// одного решения делает прогон зелёным или меняет свойство (1-минимальность ddmin).
// Источник падающих трасс — мутанты (§ 10.2): на живой системе нарушений нет.

import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config.js";
import { minimizeTrace } from "../src/minimize.js";
import { type MutantId, mutantHooks } from "../src/mutants.js";
import { replayTrace } from "../src/replay.js";
import { runSimulation } from "../src/run.js";
import { createTrace, TraceError } from "../src/trace.js";

async function failingTrace(mutant: MutantId, seed: number, ops: number) {
  const built = buildConfig({ seed, clients: 5, ops, profile: "default" });
  if (!built.ok) throw new Error(built.error);
  const config = built.config;
  const run = await runSimulation(config, { hooks: mutantHooks(mutant) });
  if (run.ok) throw new Error(`мутант ${mutant} не упал (seed ${seed})`);
  const trace = createTrace(
    seed,
    {
      clients: config.clients,
      ops: config.ops,
      profile: config.profile.name,
      checkpointMin: config.checkpointMin,
      checkpointMax: config.checkpointMax,
    },
    run.decisions,
  );
  return { trace, property: run.violation.property };
}

const CASES: readonly (readonly [MutantId, number, string])[] = [
  ["M7", 1, "S4"],
  ["M1", 1, "S9"],
  ["M3", 1, "S10"],
];

describe("SIM-10 кр. 2: минимизация упавшей трассы", () => {
  for (const [mutant, seed, property] of CASES) {
    it(`SIM-10 кр. 2: трасса мутанта ${mutant} сжимается, падает на том же ${property} и 1-минимальна`, async () => {
      const hooks = mutantHooks(mutant);
      const { trace, property: original } = await failingTrace(mutant, seed, 300);
      expect(original).toBe(property);

      const result = await minimizeTrace(trace, { hooks });
      expect(result.exhausted, "бюджет по умолчанию хватает").toBe(false);
      expect(result.property).toBe(property);
      expect(result.trace.decisions.length).toBeLessThan(trace.decisions.length / 5);

      const minimal = result.trace;
      const replay = await replayTrace(minimal, { hooks });
      expect(replay.violation?.property).toBe(property);
      expect(replay.skipped, "в минимальной трассе нет мёртвых решений").toBe(0);

      // 1-минимальность: без любого одного решения — зелёный прогон или другое свойство.
      for (let index = 0; index < minimal.decisions.length; index++) {
        const without = {
          ...minimal,
          decisions: minimal.decisions.filter((_, position) => position !== index),
        };
        const after = await replayTrace(without, { hooks });
        expect(
          after.violation?.property,
          `решение #${index} (${minimal.decisions[index]?.kind}) можно удалить — трасса не 1-минимальна`,
        ).not.toBe(property);
      }
    }, 120_000);
  }

  it("SIM-10 кр. 2: минимизированная трасса мутанта на настоящем ядре зелёная (годится в регрессионные)", async () => {
    const { trace } = await failingTrace("M7", 1, 300);
    const result = await minimizeTrace(trace, { hooks: mutantHooks("M7") });
    const onReal = await replayTrace(result.trace);
    expect(onReal.violation, onReal.violation?.message).toBeUndefined();
  }, 120_000);

  it("SIM-10 кр. 2: зелёную трассу минимизировать нельзя — ошибка, не пустой результат", async () => {
    const built = buildConfig({ seed: 3, clients: 3, ops: 60, profile: "default" });
    if (!built.ok) throw new Error(built.error);
    const run = await runSimulation(built.config);
    const trace = createTrace(
      3,
      { clients: 3, ops: 60, profile: "default", checkpointMin: 200, checkpointMax: 800 },
      run.decisions,
    );
    await expect(minimizeTrace(trace)).rejects.toThrow(TraceError);
  });

  it("SIM-10: исчерпанный бюджет — лучшее найденное, всё ещё падает на том же свойстве, exhausted = true", async () => {
    const hooks = mutantHooks("M7");
    const { trace, property } = await failingTrace("M7", 1, 300);
    const result = await minimizeTrace(trace, { hooks, budget: 4 });
    expect(result.exhausted).toBe(true);
    expect(result.runs).toBeLessThanOrEqual(4);
    const replay = await replayTrace(result.trace, { hooks });
    expect(replay.violation?.property).toBe(property);
  }, 120_000);

  it("SIM-10: минимизация детерминирована — два вызова дают одну и ту же трассу", async () => {
    const hooks = mutantHooks("M7");
    const { trace } = await failingTrace("M7", 1, 300);
    const a = await minimizeTrace(trace, { hooks });
    const b = await minimizeTrace(trace, { hooks });
    expect(JSON.stringify(a.trace)).toBe(JSON.stringify(b.trace));
  }, 120_000);
});
