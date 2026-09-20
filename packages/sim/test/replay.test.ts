// SIM-10 кр. 1 — воспроизведение упавшей трассы; docs/spec/simulator.md § 9.1–9.2.
// Источник падающих прогонов — мутанты (§ 10.2): на живой системе нарушений нет.

import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config.js";
import type { WorldHooks } from "../src/hooks.js";
import { type MutantId, mutantHooks } from "../src/mutants.js";
import { replayTrace } from "../src/replay.js";
import { runSimulation } from "../src/run.js";
import { createTrace, parseTrace, serializeTrace, TraceError } from "../src/trace.js";

function configOf(seed: number, ops: number, profile = "default" as const) {
  const built = buildConfig({ seed, clients: 5, ops, profile });
  if (!built.ok) throw new Error(built.error);
  return built.config;
}

function traceOf(
  config: ReturnType<typeof configOf>,
  decisions: Parameters<typeof createTrace>[2],
) {
  return createTrace(
    config.seed,
    {
      clients: config.clients,
      ops: config.ops,
      profile: config.profile.name,
      checkpointMin: config.checkpointMin,
      checkpointMax: config.checkpointMax,
    },
    decisions,
  );
}

/** Пары (мутант, свойство, на котором он обязан упасть): S9 приходит из досылки, S3 — из наблюдения ack, S4 — из контрольной точки, S10 — из рассылки. */
const CASES: readonly (readonly [MutantId, string])[] = [
  ["M1", "S9"],
  ["M3", "S10"],
  ["M7", "S4"],
];

describe("SIM-10 кр. 1: воспроизведение трассы упавшего прогона", () => {
  for (const [mutant, property] of CASES) {
    it(`SIM-10 кр. 1: трасса прогона с мутантом ${mutant} при replay падает на ${property} на том же шаге, без пропусков`, async () => {
      const hooks: WorldHooks = mutantHooks(mutant);
      const config = configOf(1, 400);
      const run = await runSimulation(config, { hooks });
      expect(run.ok, "мутант должен упасть").toBe(false);
      if (run.ok) return;
      expect(run.violation.property).toBe(property);

      // Через текст: то, что реально лежит в .sim/fail-<seed>.json.
      const trace = parseTrace(serializeTrace(traceOf(config, run.decisions)));
      const replay = await replayTrace(trace, { hooks });

      expect(replay.ok).toBe(false);
      expect(replay.violation?.property).toBe(run.violation.property);
      expect(replay.violation?.step).toBe(run.violation.step);
      expect(replay.skipped, "полная трасса воспроизводится без пропусков").toBe(0);
    });
  }

  it("SIM-10 кр. 1: та же трасса на настоящем ядре (без мутанта) не нарушает свойств", async () => {
    const config = configOf(1, 400);
    const run = await runSimulation(config, { hooks: mutantHooks("M7") });
    expect(run.ok).toBe(false);
    const replay = await replayTrace(traceOf(config, run.decisions));
    expect(replay.violation, replay.violation?.message).toBeUndefined();
    expect(replay.ok).toBe(true);
  });

  it("SIM-10: replay зелёной трассы повторяет прогон — без пропусков, те же счётчики", async () => {
    const config = configOf(3, 300);
    const run = await runSimulation(config);
    expect(run.ok).toBe(true);
    const replay = await replayTrace(traceOf(config, run.decisions));
    expect(replay.ok).toBe(true);
    expect(replay.skipped).toBe(0);
    expect(replay.stats.accepted).toBe(run.stats.accepted);
    expect(replay.stats.cuts).toBe(run.stats.cuts);
    expect(replay.stats.reloads).toBe(run.stats.reloads);
    expect(replay.stats.duplicateAcks).toBe(run.stats.duplicateAcks);
    expect(replay.stats.checkpoints).toBe(run.stats.checkpoints);
  });

  it("SIM-10 § 9.2: решения, неприменимые в мире, пропускаются и считаются", async () => {
    const config = configOf(3, 300);
    const run = await runSimulation(config);
    // Без подключений доставка из пустого канала и разрыв несуществующего соединения неприменимы.
    const withoutConnects = run.decisions.filter((event) => event.kind !== "connect");
    const replay = await replayTrace(traceOf(config, withoutConnects));
    expect(replay.skipped).toBeGreaterThan(0);
  });

  it("SIM-10: схема версий (ВС-9) — чужой формат отвергается, иная версия планировщика проигрывается", async () => {
    const config = configOf(3, 100);
    const run = await runSimulation(config);
    const trace = traceOf(config, run.decisions);
    expect(() => parseTrace(JSON.stringify({ ...trace, version: 999 }))).toThrow(TraceError);
    const otherScheduler = parseTrace(JSON.stringify({ ...trace, schedulerVersion: 1 }));
    expect((await replayTrace(otherScheduler)).ok).toBe(true);
  });

  it("SIM-10: parseTrace отвергает мусор и решения неизвестного вида", () => {
    expect(() => parseTrace("{")).toThrow(TraceError);
    expect(() => parseTrace("[]")).toThrow(TraceError);
    const config = configOf(1, 10);
    const trace = traceOf(config, []);
    expect(() => parseTrace(JSON.stringify({ ...trace, decisions: [{ kind: "bogus" }] }))).toThrow(
      TraceError,
    );
    expect(() =>
      parseTrace(JSON.stringify({ ...trace, decisions: [{ kind: "reload", client: 0 }] })),
    ).toThrow(TraceError);
  });
});
