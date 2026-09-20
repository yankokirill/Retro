// Индекс видимых записей по ячейкам (кэш `visible`, T-005): перенос через merge/mergeAll
// обязан давать то же, что холодная перестройка из `entries`/`supersedes`.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { empty, fromWire, merge, mergeAll, type State, toWire, visible } from "../src/index.js";
import { scenarioArb } from "./arbitraries.js";

/** Детерминированное перемешивание (LCG) — порядок доставки дельт. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed >>> 0 || 1;
  for (let i = result.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

/** Видимое содержимое всех ячеек состояния: `entity|field → отсортированные dot видимых записей`. */
function visibleCells(state: State): Record<string, string[]> {
  const cells: Record<string, string[]> = {};
  for (const entry of state.entries.values()) {
    const key = entry.key;
    cells[`${key.entity}|${key.field}`] = visible(state, key).map(
      (e) => `${e.dot.actor}:${e.dot.counter}`,
    );
  }
  return cells;
}

describe("cell index: перенос через merge равен холодной перестройке", () => {
  it("REQ-022: visible на прогретой цепочке merge (любой порядок, прогрев по ходу) равно visible холодного состояния", () => {
    fc.assert(
      fc.property(
        scenarioArb("cix-a", { minOps: 30, maxOps: 90 }),
        scenarioArb("cix-b", { minOps: 30, maxOps: 90 }),
        fc.integer(),
        (a, b, seed) => {
          const deltas = shuffled([...a.deltas, ...b.deltas], seed);
          let warm: State = empty();
          deltas.forEach((delta, index) => {
            warm = merge(warm, delta);
            if (index % 7 === 0) visible(warm, { entity: "warm-up", field: "text" });
          });
          const cold = fromWire(toWire(warm));
          expect(visibleCells(warm)).toEqual(visibleCells(cold));
        },
      ),
      { numRuns: 60 },
    );
  });

  it("REQ-022: visible после mergeAll (в том числе поверх прогретого базового состояния) равно холодному", () => {
    fc.assert(
      fc.property(
        scenarioArb("cix-c", { minOps: 40, maxOps: 100 }),
        fc.integer(),
        (scenario, seed) => {
          const deltas = shuffled(scenario.deltas, seed);
          const half = Math.floor(deltas.length / 2);
          let base: State = empty();
          for (const delta of deltas.slice(0, half)) base = merge(base, delta);
          visible(base, { entity: "warm-up", field: "text" });
          const combined = mergeAll([base, ...deltas.slice(half)]);
          const cold = fromWire(toWire(combined));
          expect(visibleCells(combined)).toEqual(visibleCells(cold));
        },
      ),
      { numRuns: 60 },
    );
  });
});
