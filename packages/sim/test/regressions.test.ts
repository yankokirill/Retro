// SIM-10 кр. 3 — регрессионные трассы: всё, что лежит в test/regressions/, воспроизводится на
// текущем коде без нарушений (как контрапример fast-check, CLAUDE.md § 4). Трассы мутантов
// (`Mk-…json`) ещё и «с зубами»: с их мутантом они по-прежнему падают, иначе трасса перестала
// что-либо проверять. Пересборка: `npm run sim:regressions`.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MUTANT_IDS, type MutantId, mutantHooks } from "../src/mutants.js";
import { replayTrace } from "../src/replay.js";
import { parseTrace } from "../src/trace.js";

const DIRECTORY = new URL("./regressions/", import.meta.url);
const names = readdirSync(DIRECTORY)
  .filter((name) => name.endsWith(".json"))
  .sort();

describe("SIM-10 кр. 3: регрессионные трассы", () => {
  it("SIM-10 кр. 3: каталог не пуст — есть трасса каждого из мутантов M1–M7", () => {
    for (const id of MUTANT_IDS) {
      expect(
        names.some((name) => name.startsWith(`${id}-`)),
        `нет регрессионной трассы мутанта ${id} — запусти npm run sim:regressions`,
      ).toBe(true);
    }
  });

  for (const name of names) {
    const trace = () => parseTrace(readFileSync(new URL(name, DIRECTORY), "utf8"));

    it(`SIM-10 кр. 3: ${name} воспроизводится на текущем коде без нарушений`, async () => {
      const result = await replayTrace(trace());
      expect(result.violation, result.violation?.message).toBeUndefined();
      expect(result.ok).toBe(true);
    });

    const mutant = /^(M[1-7])-/.exec(name)?.[1] as MutantId | undefined;
    if (mutant) {
      it(`SIM-10 кр. 3: ${name} с мутантом ${mutant} по-прежнему падает — трасса не потеряла зубы`, async () => {
        const result = await replayTrace(trace(), { hooks: mutantHooks(mutant) });
        expect(result.ok, `мутант ${mutant} выжил на своей регрессионной трассе`).toBe(false);
      });
    }
  }
});
