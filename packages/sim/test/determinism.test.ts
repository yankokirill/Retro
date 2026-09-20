// SIM-02: детерминизм — docs/spec/simulator.md § 4.2 «SIM-02».
//
// кр. 2: ни `packages/sim/src` (кроме `cli.ts`), ни `packages/server-core/src`,
// ни `packages/client-core/src` не читают часы, случайность, таймеры,
// переменные окружения или файлы.
// кр. 1: одинаковые seed/конфигурация → побайтно равные трассы/итог при
// двух прогонах в одном процессе.
//
// Сканер работает на исходном тексте после вырезания `//`/`/* */`
// комментариев — иначе документационные упоминания вроде "Date.now()
// запрещён везде, кроме cli.ts" (ровно такой комментарий есть в stats.ts)
// давали бы ложное срабатывание. Тот же сканер годится и без вырезания
// комментариев для случая, когда паттерн требует вызова со скобкой сразу
// после имени — но вырезание надёжнее и ближе к тому, что делает Biome.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config.js";
import { runSimulation } from "../src/run.js";

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string): string[] {
  const result: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      result.push(...walk(full));
      continue;
    }
    if (name.endsWith(".ts") && !name.endsWith(".test.ts")) result.push(full);
  }
  return result;
}

const SIM_SRC = join(import.meta.dirname, "..", "src");
const SERVER_CORE_SRC = join(import.meta.dirname, "..", "..", "server-core", "src");
const CLIENT_CORE_SRC = join(import.meta.dirname, "..", "..", "client-core", "src");

const FORBIDDEN: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "Date.now(", pattern: /Date\.now\(/g },
  { label: "new Date()", pattern: /new Date\(\s*\)/g },
  { label: "performance.now(", pattern: /performance\.now\(/g },
  { label: "Math.random(", pattern: /Math\.random\(/g },
  { label: "crypto.randomUUID(", pattern: /crypto\.randomUUID\(/g },
  { label: "getRandomValues(", pattern: /getRandomValues\(/g },
  { label: "setTimeout(", pattern: /setTimeout\(/g },
  { label: "setInterval(", pattern: /setInterval\(/g },
  { label: "setImmediate(", pattern: /setImmediate\(/g },
  { label: "process.env", pattern: /process\.env/g },
  { label: "readFileSync(", pattern: /readFileSync\(/g },
  { label: "readFile(", pattern: /(?<!write)readFile\(/g },
];

function scan(files: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const content = stripComments(readFileSync(file, "utf8"));
    for (const { label, pattern } of FORBIDDEN) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) offenders.push(`${file}: ${label}`);
    }
  }
  return offenders;
}

describe("SIM-02 кр. 2: ядра и симулятор не читают часы/случайность/I-O напрямую", () => {
  it("SIM-02 кр. 2: packages/sim/src (кроме cli.ts) — чисто", () => {
    const files = walk(SIM_SRC).filter((f) => !f.endsWith(`${join("src", "cli.ts")}`));
    expect(scan(files)).toEqual([]);
  });

  it("SIM-02 кр. 2: packages/server-core/src — чисто", () => {
    expect(scan(walk(SERVER_CORE_SRC))).toEqual([]);
  });

  it("SIM-02 кр. 2: packages/client-core/src — чисто", () => {
    expect(scan(walk(CLIENT_CORE_SRC))).toEqual([]);
  });

  it("SIM-02 кр. 2: сканер не пуст (проверка не тавтология)", () => {
    expect(walk(SIM_SRC).length).toBeGreaterThan(5);
    expect(walk(SERVER_CORE_SRC).length).toBeGreaterThan(3);
    expect(walk(CLIENT_CORE_SRC).length).toBeGreaterThan(1);
  });
});

describe("SIM-02 кр. 1: два прогона с одинаковым seed дают одинаковый результат", () => {
  it("SIM-02 кр. 1: runSimulation(seed=42) дважды в одном процессе — одинаковые decisions/stats.steps/итог", async () => {
    const configResult = buildConfig({ seed: 42, clients: 3, ops: 50 });
    if (!configResult.ok) throw new Error(`buildConfig failed: ${configResult.error}`);

    const first = await runSimulation(configResult.config);
    const second = await runSimulation(configResult.config);

    expect(first.ok).toBe(second.ok);
    expect(first.decisions).toEqual(second.decisions);
    expect(first.stats.steps).toEqual(second.stats.steps);
    if (!first.ok && !second.ok) {
      expect(first.violation).toEqual(second.violation);
    }
  });
});
