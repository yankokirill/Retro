// CLI — docs/spec/simulator.md § 11.1: разбор флагов, коды выхода 0/2, сводка,
// принудительная запись трассы. Путь нарушения (код 1) — в cli-failure.test.ts
// (подмена runSimulation: на живой системе нарушения нет).

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseCliArgs } from "../src/cli.js";
import { TRACE_VERSION } from "../src/config.js";

let logs: string[];
let errors: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => void errors.push(args.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("CLI § 11.1: разбор флагов", () => {
  it("CLI § 11.1: значения по умолчанию — 5 клиентов, 10000 оп, профиль default, контрольные точки 200–800", () => {
    const parsed = parseCliArgs([]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args).toMatchObject({
      clients: 5,
      ops: 10000,
      profile: "default",
      checkpointMin: 200,
      checkpointMax: 800,
      quiet: false,
    });
    expect(parsed.args.seed).toBeUndefined();
  });

  it("CLI § 11.1: неизвестный флаг — ошибка разбора", () => {
    expect(parseCliArgs(["--bogus"]).ok).toBe(false);
  });

  it("CLI § 11.1: числовые флаги разбираются строго — 12abc, 1e4, 5.9, -1 не принимаются", () => {
    for (const bad of [
      "--seed=12abc",
      "--ops=1e4",
      "--clients=5.9",
      "--seed=-1",
      "--ops=",
      "--checkpoint-min=x",
    ]) {
      const parsed = parseCliArgs([bad]);
      expect(parsed.ok, bad).toBe(false);
    }
    const good = parseCliArgs(["--seed=0", "--ops=10000", "--clients=20"]);
    expect(good.ok).toBe(true);
  });
});

describe("CLI § 11.1: прогон и коды выхода", () => {
  it("CLI § 11.1: успешный прогон — код 0, seed первой строкой, итоговая строка и сводка", async () => {
    const code = await main(["--clients=3", "--ops=40", "--seed=11"]);
    expect(code).toBe(0);
    expect(logs[0]).toBe("11");
    expect(logs[1]).toMatch(
      /^OK seed=11 profile=default clients=3 ops=40 steps=\d+ time=\d+\.\ds$/,
    );
    const summary = logs.join("\n");
    expect(summary).toContain("E1 по намерениям");
    expect(summary).toContain("принято операций");
    expect(summary).toContain("разрывы");
    expect(summary).toContain("max |P|");
  });

  it("CLI § 11.1: --quiet — только итоговая строка (seed внутри неё)", async () => {
    const code = await main(["--clients=3", "--ops=40", "--seed=11", "--quiet"]);
    expect(code).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^OK seed=11 /);
  });

  it("CLI § 11.1: без --seed случайный seed печатается первой строкой", async () => {
    const code = await main(["--clients=2", "--ops=10"]);
    expect(code).toBe(0);
    expect(logs[0]).toMatch(/^\d+$/);
  });

  it("CLI § 11.1: неверные аргументы — код 2", async () => {
    expect(await main(["--profile=nope"])).toBe(2);
    expect(await main(["--clients=99"])).toBe(2);
    expect(await main(["--bogus"])).toBe(2);
    expect(errors.length).toBe(3);
  });

  it("CLI § 11.1: --trace пишет трассу и при успехе", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-cli-"));
    try {
      const path = join(dir, "nested", "trace.json");
      const code = await main([
        "--clients=3",
        "--ops=20",
        "--seed=5",
        "--quiet",
        `--trace=${path}`,
      ]);
      expect(code).toBe(0);
      expect(existsSync(path)).toBe(true);
      const trace = JSON.parse(readFileSync(path, "utf8"));
      expect(trace).toMatchObject({
        version: TRACE_VERSION,
        seed: 5,
        config: { clients: 3, ops: 20 },
      });
      expect(Array.isArray(trace.decisions)).toBe(true);
      expect(trace.decisions.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
