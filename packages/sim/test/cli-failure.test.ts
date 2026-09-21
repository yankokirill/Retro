// CLI § 11.1 / § 9.3: путь нарушения (код 1) и внутренней ошибки (код 2).
// На живой системе нарушений нет, поэтому runSimulation подменён.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEDULER_VERSION, TRACE_VERSION } from "../src/config.js";
import { createStats } from "../src/stats.js";
import { violation } from "../src/violation.js";

const run = vi.hoisted(() => ({ runSimulation: vi.fn() }));
vi.mock("../src/run.js", () => run);
const replay = vi.hoisted(() => ({ replayTrace: vi.fn() }));
vi.mock("../src/replay.js", () => replay);
const minimize = vi.hoisted(() => ({ minimizeTrace: vi.fn(), DEFAULT_MINIMIZE_BUDGET: 2000 }));
vi.mock("../src/minimize.js", () => minimize);

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
  replay.replayTrace.mockReset();
  minimize.minimizeTrace.mockReset();
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

describe("CLI § 9.2: --replay упавшей трассы", () => {
  it("SIM-10 кр. 1: replay, упавший на нарушении, — код 1 и отчёт с свойством и шагом", async () => {
    const stats = createStats();
    stats.checkpoints = 3;
    replay.replayTrace.mockResolvedValue({
      ok: false,
      violation: violation("S4", 42, "X_c ≠ proj_u(X_S)"),
      applied: 10,
      skipped: 2,
      stats,
    });
    const dir = mkdtempSync(join(tmpdir(), "sim-cli-replay-fail-"));
    try {
      const path = join(dir, "trace.json");
      writeFileSync(
        path,
        JSON.stringify({
          version: TRACE_VERSION,
          schedulerVersion: SCHEDULER_VERSION,
          seed: 7,
          config: {
            clients: 3,
            ops: 20,
            profile: "default",
            checkpointMin: 200,
            checkpointMax: 800,
          },
          decisions: [{ kind: "cut", connection: 0 }],
        }),
      );
      expect(await main([`--replay=${path}`])).toBe(1);
      const report = errors.join("\n");
      expect(report).toContain("SIM FAIL S4 at step 42, checkpoint 3");
      expect(report).toContain("seed=7 profile=default clients=3 ops=20");
      expect(report).toContain("выполнено=10 пропущено=2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI § 9.2/§ 9.3: --replay --minimize и различие клиента", () => {
  const traceText = JSON.stringify({
    version: TRACE_VERSION,
    schedulerVersion: SCHEDULER_VERSION,
    seed: 7,
    config: { clients: 3, ops: 20, profile: "default", checkpointMin: 200, checkpointMax: 800 },
    decisions: [
      { kind: "connect", client: 1 },
      {
        kind: "act",
        client: 1,
        intent: { type: "createSticker", column: "start", frac: "a", text: "x", color: "yellow" },
      },
      { kind: "checkpoint" },
    ],
  });

  it("SIM-10 кр. 2: --replay --minimize печатает различие клиента, итог ddmin и журнал шагов, пишет .min.json", async () => {
    const stats = createStats();
    stats.checkpoints = 1;
    const failing = {
      ok: false,
      violation: violation("S4", 5, "X_c ≠ proj_u(X_S)", {
        client: 1,
        guest: "0cd52fea-205d-4b38-9f90-45bd3e3ca3e7",
        role: "participant",
        actor: "5f000000-0000-4000-8000-0000000000a1",
        connections: [0],
        missingInClient: {
          created: ["7c000000-0000-4000-8000-0000000000e2:4"],
          createdCount: 1,
          entries: 5,
          votes: 0,
          unvotes: 0,
        },
        extraInClient: { created: [], createdCount: 0, entries: 0, votes: 0, unvotes: 0 },
      }),
      applied: 2,
      skipped: 0,
      consumed: 3,
      skippedIndexes: [],
      stats,
    };
    replay.replayTrace.mockResolvedValue(failing);
    minimize.minimizeTrace.mockResolvedValue({
      trace: {
        version: TRACE_VERSION,
        schedulerVersion: SCHEDULER_VERSION,
        seed: 7,
        config: { clients: 3, ops: 20, profile: "default", checkpointMin: 200, checkpointMax: 800 },
        decisions: [
          {
            kind: "act",
            client: 1,
            intent: {
              type: "createSticker",
              column: "start",
              frac: "a",
              text: "x",
              color: "yellow",
            },
          },
          { kind: "checkpoint" },
        ],
      },
      property: "S4",
      originalDecisions: 100,
      runs: 12,
      exhausted: false,
    });
    const dir = mkdtempSync(join(tmpdir(), "sim-cli-minimize-"));
    try {
      const path = join(dir, "fail-7.json");
      writeFileSync(path, traceText);
      expect(await main([`--replay=${path}`, "--minimize", "--minimize-budget=50"])).toBe(1);
      expect(minimize.minimizeTrace).toHaveBeenCalledWith(expect.anything(), { budget: 50 });
      const report = errors.join("\n");
      expect(report).toContain("SIM FAIL S4 at step 5, checkpoint 1");
      expect(report).toContain(
        "client #1 (guest 0cd52fea…, participant, actor 5f000000…): X_c ≠ proj_u(X_S)",
      );
      expect(report).toContain("missing in X_c: created 1 (7c000000-0000), 5 entries");
      expect(report).toContain("extra in X_c:   —");
      expect(report).toContain("last events for client #1: connect:client=1 act:client=1");
      expect(report).toContain("MINIMIZED S4: 100 → 2 решений, 12 прогонов, 1-минимальна");
      expect(report).toContain("журнал шагов:");
      expect(report).toContain('1. act client=1 createSticker "x"');
      const minPath = join(dir, "fail-7.min.json");
      expect(existsSync(minPath)).toBe(true);
      expect(JSON.parse(readFileSync(minPath, "utf8")).decisions).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SIM-10 кр. 2: --minimize на трассе, которая не падает, — код 2 (минимизировать нечего)", async () => {
    replay.replayTrace.mockResolvedValue({
      ok: true,
      applied: 3,
      skipped: 0,
      consumed: 3,
      skippedIndexes: [],
      stats: createStats(),
    });
    const dir = mkdtempSync(join(tmpdir(), "sim-cli-minimize-"));
    try {
      const path = join(dir, "green.json");
      writeFileSync(path, traceText);
      expect(await main([`--replay=${path}`, "--minimize"])).toBe(2);
      expect(errors.join("\n")).toContain("минимизировать нечего");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
