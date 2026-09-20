// SIM-06 — docs/spec/simulator.md § 5.2: генератор не подделывает операции.
// Кр. 1: дельта попадает в мир только через API ядра клиента; сканер
// исходников (в стиле purity.test.ts). Кр. 2: любое сообщение клиента проходит
// `clientMessageSchema` — это S11, нарушение = `ok:false` со `property: "S11"`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfig, type Profile, runSimulation } from "../src/index.js";

const SRC_DIR = join(import.meta.dirname, "..", "src");
const GENERATOR_AND_WORLD = ["world", "events", "intents", "apply", "drain", "run"].map((name) =>
  join(SRC_DIR, `${name}.ts`),
);

/** Экспорты `@retro/crdt`, порождающие дельту (публичный index.ts пакета). */
const DELTA_CONSTRUCTORS: ReadonlySet<string> = new Set([
  "setField",
  "createSticker",
  "editText",
  "move",
  "setColor",
  "setGroup",
  "deleteEntity",
  "restoreEntity",
  "createGroup",
  "renameGroup",
  "createAction",
  "assign",
  "setDone",
  "vote",
  "unvote",
  "toWire",
]);

const CRDT_IMPORT = /import\s+(?:type\s+)?([^;]*?)\s+from\s+["']@retro\/crdt["']/g;
const MANUAL_OP = /\btype\s*:\s*["']op["']/;

/** Нарушения в тексте одного исходника. */
function findForgeries(file: string, content: string): string[] {
  const offenders: string[] = [];
  CRDT_IMPORT.lastIndex = 0;
  for (const match of content.matchAll(CRDT_IMPORT)) {
    const clause = match[1] ?? "";
    if (/^\*\s+as\b/.test(clause.trim())) {
      offenders.push(`${file}: namespace-импорт @retro/crdt скрывает конструкторы`);
      continue;
    }
    const names = clause
      .replace(/[{}]/g, " ")
      .split(",")
      .map((part) =>
        part
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          ?.trim(),
      );
    for (const name of names) {
      if (name && DELTA_CONSTRUCTORS.has(name))
        offenders.push(`${file}: импорт ${name} из @retro/crdt`);
    }
  }
  if (MANUAL_OP.test(content)) offenders.push(`${file}: ручная сборка сообщения {type:"op"}`);
  return offenders;
}

describe("SIM-06: генератор не подделывает операции", () => {
  it("SIM-06 кр. 1 / REQ-023: world/events/intents/apply/drain/run не импортируют конструкторы дельт из @retro/crdt и не собирают op вручную", () => {
    const offenders: string[] = [];
    for (const file of GENERATOR_AND_WORLD) {
      offenders.push(...findForgeries(file, readFileSync(file, "utf8")));
    }
    expect(offenders).toEqual([]);
  });

  it("SIM-06 кр. 1: сканер не пуст — ловит подделку и пропускает чтение", () => {
    expect(GENERATOR_AND_WORLD.length).toBe(6);
    expect(findForgeries("x.ts", `import { vote, materialize } from "@retro/crdt";`)).toHaveLength(
      1,
    );
    expect(
      findForgeries("x.ts", `import {\n  type Delta,\n  toWire as w,\n} from "@retro/crdt";`),
    ).toHaveLength(1);
    expect(findForgeries("x.ts", `const m = { type: "op", dot };`)).toHaveLength(1);
    expect(findForgeries("x.ts", `import * as crdt from "@retro/crdt";`)).toHaveLength(1);
    expect(
      findForgeries("x.ts", `import { materialize, merge, empty } from "@retro/crdt";`),
    ).toEqual([]);
  });

  for (const profile of ["default", "faults"] as const satisfies readonly Profile[]) {
    for (const seed of [1, 2, 3]) {
      it(`SIM-06 кр. 2 / S11 / REQ-023: profile=${profile} seed=${seed} — все сообщения клиента проходят clientMessageSchema`, async () => {
        const built = buildConfig({ seed, clients: 4, ops: 400, profile });
        if (!built.ok) throw new Error(`невалидная конфигурация: ${built.error}`);
        const result = await runSimulation(built.config);
        if (!result.ok) {
          expect(
            result.violation.property,
            `profile=${profile} seed=${seed}: ${result.violation.message}`,
          ).not.toBe("S11");
        }
        expect(result.ok, `profile=${profile} seed=${seed}`).toBe(true);
        expect(result.stats.maxMessageBytes.toServer).toBeGreaterThan(0);
      }, 120_000);
    }
  }
});
