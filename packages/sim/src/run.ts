// Главный цикл — docs/design/T-005-simulator.md § 5.2.
//
//   const prng = createPrng(config.seed);
//   const world = createWorld(config, prng);
//   пока world.acts < config.ops: выбрать событие (enabledEvents + веса
//   профиля), applyEvent, прогнать пошаговые проверки S1–S3/S7/S10/S11 над
//   наблюдением этого шага; на контрольной точке — drain (S9) + S4/S5/S6/S8
//   + полный S1.
//
// `--replay`/`--minimize` (SIM-10) — T-027, здесь их нет (docs/tasks.md § 7.1).

import type { SimConfig } from "./config.js";
import type { Event } from "./events.js";
import type { Stats } from "./stats.js";
import type { Violation } from "./violation.js";

export type RunResult =
  | { readonly ok: true; readonly decisions: readonly Event[]; readonly stats: Stats }
  | {
      readonly ok: false;
      readonly violation: Violation;
      readonly decisions: readonly Event[];
      readonly stats: Stats;
    };

export async function runSimulation(config: SimConfig): Promise<RunResult> {
  throw new Error("runSimulation: not implemented");
}
