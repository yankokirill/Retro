// npm run sim:regressions — пересобирает регрессионные трассы мутантов (SIM-10 кр. 3):
// для каждого из M1–M7 берёт первый seed из конфигурации SIM-12, на котором мутант падает,
// минимизирует трассу (ddmin, тот же мутант) и кладёт в test/regressions/<Mk>-<профиль>-seed<N>.json.
// Трасса мутанта на настоящем ядре обязана быть зелёной, с мутантом — красной; это проверяет
// test/regressions.test.ts. Трассы других находок (настоящие баги) добавляются вручную:
//   npm run sim -- --replay=.sim/fail-<seed>.json --minimize --out=test/regressions/<имя>.json

import { mkdirSync, writeFileSync } from "node:fs";
import { buildConfig } from "../src/config.js";
import { minimizeTrace } from "../src/minimize.js";
import { MUTANT_IDS, type MutantId, mutantHooks } from "../src/mutants.js";
import { runSimulation } from "../src/run.js";
import { createTrace, serializeTrace } from "../src/trace.js";

interface Plan {
  readonly profile: "default" | "faults";
  readonly ops: number;
  readonly checkpointMin?: number;
  readonly checkpointMax?: number;
}

/** Конфигурации совпадают с test/mutants.test.ts (SIM-12): там доказано, что мутант на них пойман. */
const PLANS: Record<MutantId, Plan> = {
  M1: { profile: "default", ops: 400 },
  M2: { profile: "default", ops: 400 },
  M3: { profile: "default", ops: 400 },
  M4: { profile: "default", ops: 400 },
  M5: { profile: "faults", ops: 500 },
  M6: { profile: "default", ops: 1000, checkpointMin: 20, checkpointMax: 60 },
  M7: { profile: "default", ops: 400 },
};

const directory = new URL("../test/regressions/", import.meta.url);
mkdirSync(directory, { recursive: true });

for (const id of MUTANT_IDS) {
  const plan = PLANS[id];
  const hooks = mutantHooks(id);
  let written = false;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const built = buildConfig({ seed, clients: 5, ...plan });
    if (!built.ok) throw new Error(built.error);
    const config = built.config;
    const run = await runSimulation(config, { hooks });
    if (run.ok) continue;
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
    const result = await minimizeTrace(trace, { hooks });
    const name = `${id}-${plan.profile}-seed${seed}.json`;
    writeFileSync(new URL(name, directory), `${serializeTrace(result.trace)}\n`);
    console.log(
      `${name}: ${run.violation.property}, ${trace.decisions.length} → ${result.trace.decisions.length} решений, ${result.runs} прогонов${result.exhausted ? " (бюджет исчерпан)" : ""}`,
    );
    written = true;
    break;
  }
  if (!written)
    throw new Error(`мутант ${id} не упал ни на одном seed 1–6 — регрессионную трассу не собрать`);
}
