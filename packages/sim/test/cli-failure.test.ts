// CLI § 11.1 / § 9.3: путь нарушения (код 1) и внутренней ошибки (код 2).
// На живой системе нарушений нет, поэтому runSimulation подменён.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStats } from "../src/stats.js";
import { violation } from "../src/violation.js";

const run = vi.hoisted(() => ({ runSimulation: vi.fn() }));
vi.mock("../src/run.js", () => run);

import { main } from "../src/cli.js";

let errors: string[];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...args) => void errors.push(args.join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  run.runSimulation.mockReset();
});

describe("CLI § 11.1 / § 9.3: нарушение свойства", () => {
  it("CLI § 9.3: нарушение — код 1, отчёт с ID свойства, шагом, seed и repro, трасса записана", async () => {
    const stats = createStats();
    stats.checkpoints = 7;
    run.runSimulation.mockResolvedValue({
      ok: false,
      violation: violation("S4", 42, "X_c ≠ proj_u(X_S)"),
      decisions: [
        { kind: "cut", connection: 0 },
        { kind: "connect", client: 1 },
      ],
      stats,
    });
    const dir = mkdtempSync(join(tmpdir(), "sim-cli-fail-"));
    try {
      const path = join(dir, "fail.json");
      const code = await main([
        "--clients=4",
        "--ops=100",
        "--seed=912873",
        "--profile=reveal",
        `--trace=${path}`,
      ]);
      expect(code).toBe(1);
      const report = errors.join("\n");
      expect(report).toContain("SIM FAIL S4 at step 42, checkpoint 7");
      expect(report).toContain("seed=912873 profile=reveal clients=4 ops=100");
      expect(report).toContain("X_c ≠ proj_u(X_S)");
      expect(report).toContain("last events: cut:conn=0 connect:client=1");
      expect(report).toContain(
        "npm run sim -- --profile=reveal --clients=4 --ops=100 --seed=912873",
      );
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8")).decisions).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI § 11.1: внутренняя ошибка", () => {
  it("CLI § 11.1: исключение из симулятора — код 2, не 1 (это не нарушение свойства)", async () => {
    run.runSimulation.mockRejectedValue(new Error("boom"));
    const code = await main(["--clients=3", "--ops=10", "--seed=1"]);
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("внутренняя ошибка");
    expect(errors.join("\n")).toContain("boom");
  });
});
