// SIM-01: симулятор не содержит своей копии логики сервера/клиента и не
// импортирует внутренности пакетов — docs/spec/simulator.md § 2 (таблица),
// критерий 1. Проверяется сканером исходников (то же обещание, что и
// `noRestrictedImports` в Biome, но независимой проверкой — правило 3
// CLAUDE.md запрещает полагаться только на то, что мы сами не читаем).
//
// Сканер — простой `readFileSync` + регулярка, без `node:child_process`
// (как и требует задание). `cli.ts` — единственное исключение файла всего
// пакета (аргументы, запись трассы), но и он не должен читать внутренности
// других пакетов, поэтому включён в сканирование наравне с остальными —
// исключение из SIM-01 касается I/O (SIM-02), не импортов.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = join(import.meta.dirname, "..", "src");

function sourceFiles(): readonly string[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(SRC_DIR, name));
}

const FORBIDDEN_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'from "@retro/*/src/*"', pattern: /from\s+["']@retro\/[^"']+\/src\//g },
  { label: 'from "../../apps/*"', pattern: /from\s+["'][^"']*\bapps\//g },
];

describe("SIM-01: packages/sim не импортирует внутренности пакетов или apps/*", () => {
  it("SIM-01 кр. 1: ни один файл src/*.ts не импортирует .../src/ у @retro/* пакетов", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const content = readFileSync(file, "utf8");
      for (const { label, pattern } of FORBIDDEN_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(content)) {
          offenders.push(`${file}: ${label}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("SIM-01 кр. 1: у каждого src/*.ts файла хотя бы одна проверка выполнена (сканер не пуст)", () => {
    // Проверка, что сам сканер не «пустой» (не проверяет ноль файлов) —
    // иначе предыдущий тест был бы тавтологией (§ 10 simulator.md, «проверка
    // не должна быть пустой»).
    expect(sourceFiles().length).toBeGreaterThan(5);
  });
});
