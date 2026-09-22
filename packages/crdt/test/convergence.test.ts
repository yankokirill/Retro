// REQ-022 — «Сходимость независимо от порядка и повторов доставки».
// Формально I1.1 (consistency-model.md § 8), доказано как следствие Т1
// (§ 9): одно и то же множество дельт, полученное репликой в любом порядке,
// с повторами, пачками или по одной — даёт то же самое состояние.
//
// lattice.test.ts проверяет сами законы merge; этот файл проверяет их
// прямое следствие на наборах дельт: перестановки, дубликаты, доставку
// пачками и (для малого числа дельт) исчерпывающий перебор всех
// перестановок.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Delta, empty, equals, merge, type State } from "../src/index.js";
import { foldDeltas, permutations, scenarioArb } from "./arbitraries.js";

function foldStates(states: readonly State[]): State {
  return states.reduce<State>((acc, s) => merge(acc, s), empty());
}

describe("REQ-022: сходимость независимо от порядка и повторов доставки", () => {
  it("REQ-022: одно и то же множество дельт в двух случайных порядках даёт равные состояния", () => {
    fc.assert(
      fc.property(
        scenarioArb("perm", { minOps: 1, maxOps: 12 }).chain((scenario) =>
          fc.tuple(
            fc.constant(scenario),
            fc.shuffledSubarray([...scenario.deltas], {
              minLength: scenario.deltas.length,
              maxLength: scenario.deltas.length,
            }),
            fc.shuffledSubarray([...scenario.deltas], {
              minLength: scenario.deltas.length,
              maxLength: scenario.deltas.length,
            }),
          ),
        ),
        ([scenario, permA, permB]) => {
          const stateA = foldDeltas(permA);
          const stateB = foldDeltas(permB);
          expect(equals(stateA, stateB)).toBe(true);
          expect(equals(stateA, scenario.merged)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("REQ-022: дельты, доставленные пачками произвольной группировки, сходятся к тому же состоянию", () => {
    fc.assert(
      fc.property(
        scenarioArb("batches", { minOps: 2, maxOps: 12 }).chain((scenario) =>
          fc.tuple(
            fc.constant(scenario),
            fc.shuffledSubarray([...scenario.deltas], {
              minLength: scenario.deltas.length,
              maxLength: scenario.deltas.length,
            }),
            fc.array(fc.nat({ max: 3 }), {
              minLength: scenario.deltas.length,
              maxLength: scenario.deltas.length,
            }),
          ),
        ),
        ([scenario, shuffled, batchTags]) => {
          // Перемешанные дельты раскладываются по batchTags в группы
          // (пачки), внутри пачки сливаются в состояние, затем пачки
          // сливаются между собой — имитация доставки пачками в
          // произвольной группировке и произвольном порядке.
          const batches = new Map<number, Delta[]>();
          shuffled.forEach((delta, i) => {
            const tag = batchTags[i] ?? 0;
            const list = batches.get(tag) ?? [];
            list.push(delta);
            batches.set(tag, list);
          });
          const batchStates = [...batches.values()].map((deltas) => foldDeltas(deltas));
          const result = foldStates(batchStates);
          expect(equals(result, scenario.merged)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("REQ-022: повторная доставка (дубликаты дельт вперемешку с остальными) не меняет итоговое состояние", () => {
    fc.assert(
      fc.property(
        scenarioArb("dup", { minOps: 1, maxOps: 10 }).chain((scenario) =>
          fc.tuple(
            fc.constant(scenario),
            fc.array(fc.nat({ max: Math.max(scenario.deltas.length - 1, 0) }), {
              minLength: 0,
              maxLength: 10,
            }),
          ),
        ),
        ([scenario, repeatIndexes]) => {
          const repeats = repeatIndexes
            .map((i) => scenario.deltas[i])
            .filter((d): d is Delta => d !== undefined);
          const withRepeats = [...scenario.deltas, ...repeats];
          const stateWithRepeats = foldDeltas(withRepeats);
          expect(equals(stateWithRepeats, scenario.merged)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("REQ-022: слияние одной и той же дельты дважды подряд не меняет состояние (идемпотентность доставки)", () => {
    fc.assert(
      fc.property(scenarioArb("dup-adjacent", { minOps: 1, maxOps: 10 }), (scenario) => {
        const doubled = scenario.deltas.flatMap((d) => [d, d]);
        expect(equals(foldDeltas(doubled), scenario.merged)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("REQ-022: полный перебор всех перестановок для малого числа дельт (≤ 6) даёт одинаковое состояние", () => {
    // Исчерпывающий перебор внутри тела свойства — numRuns намеренно меньше
    // 100 (разрешённое исключение из инструкции): 6! = 720 перестановок на
    // каждый запуск уже даёт большое покрытие (consistency-model.md § 11: «≤ 6»
    // — до 2026-09-22 здесь стоял maxOps: 5, независимая проверка это поймала,
    // docs/review/2026-09-22-full-project.md).
    fc.assert(
      fc.property(
        scenarioArb("exhaustive", { minOps: 1, maxOps: 6, minActors: 2, maxActors: 3 }),
        (scenario) => {
          const reference = scenario.merged;
          for (const perm of permutations(scenario.deltas)) {
            expect(equals(foldDeltas(perm), reference)).toBe(true);
          }
        },
      ),
      { numRuns: 15 },
    );
  });
});
