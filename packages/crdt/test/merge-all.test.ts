// mergeAll(states) — ⨆ за один проход; обязан совпадать с левой свёрткой merge
// (consistency-model.md § 9, теорема Т1: ⊔ — объединение множеств, порядок и
// группировка не важны). Нужна очереди дельт клиента (T-005: |P| ~ 10²).

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { empty, equals, merge, mergeAll } from "../src/index.js";
import { scenarioArb } from "./arbitraries.js";

describe("REQ-022 (T1): mergeAll", () => {
  it("REQ-022: mergeAll(xs) равно левой свёртке merge по xs", () => {
    fc.assert(
      fc.property(
        scenarioArb("mall-a"),
        scenarioArb("mall-b"),
        scenarioArb("mall-c"),
        (a, b, c) => {
          const states = [a.merged, b.merged, c.merged, ...a.deltas, ...c.deltas];
          const folded = states.reduce((acc, state) => merge(acc, state), empty());
          expect(equals(mergeAll(states), folded)).toBe(true);
        },
      ),
    );
  });

  it("REQ-022: mergeAll([]) — пустое состояние, mergeAll([x]) равно x", () => {
    expect(equals(mergeAll([]), empty())).toBe(true);
    fc.assert(
      fc.property(scenarioArb("mall-one"), (a) => {
        expect(equals(mergeAll([a.merged]), a.merged)).toBe(true);
      }),
    );
  });
});
