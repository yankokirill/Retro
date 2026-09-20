// SIM-04 — docs/spec/simulator.md § 4.3: при профиле `default` и `--ops ≥ 500`
// за один прогон случается каждая из шести неисправностей сети.

import { describe, expect, it } from "vitest";
import { buildConfig, runSimulation, type Stats } from "../src/index.js";

const OPS = 500;
const CASES: readonly { readonly seed: number; readonly clients: number }[] = [
  { seed: 1, clients: 3 },
  { seed: 2, clients: 5 },
  { seed: 3, clients: 8 },
  { seed: 4, clients: 4 },
];

const FLAGS: readonly (keyof Stats["faultCoverage"])[] = [
  "cutWithNonEmptyPending",
  "cutWithNonEmptyToClient",
  "noticeAfterAddressedMessage",
  "reloadWithNonEmptyPending",
  "connectWithNullLastSeq",
  "connectWithKnownLastSeq",
];

describe("SIM-04: все неисправности сети достижимы", () => {
  for (const { seed, clients } of CASES) {
    it(`SIM-04 / REQ-023: профиль default, seed=${seed} clients=${clients} ops=${OPS} — все 6 неисправностей за один прогон`, async () => {
      const built = buildConfig({ seed, clients, ops: OPS, profile: "default" });
      if (!built.ok) throw new Error(`невалидная конфигурация: ${built.error}`);
      const result = await runSimulation(built.config);
      expect(
        result.ok,
        `прогон seed=${seed} clients=${clients} упал: ${JSON.stringify(result.ok ? null : result.violation)}`,
      ).toBe(true);
      const missing = FLAGS.filter((flag) => !result.stats.faultCoverage[flag]);
      expect(
        missing,
        `seed=${seed} clients=${clients}: не наступили условия SIM-04: ${missing.join(", ")}`,
      ).toEqual([]);
    }, 120_000);
  }
});
