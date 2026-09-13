// T-001 / REQ-022 / consistency-model.md § 9, теорема Т1:
// компоненты состояния — конечные множества, merge (⊔) — покомпонентное
// объединение, значит коммутативен, ассоциативен и идемпотентен для ЛЮБЫХ
// состояний. Отсюда следует I1.1 (REQ-022) — сходимость независимо от
// порядка слияния. Тесты этого файла проверяют сами законы; convergence.test.ts
// проверяет их следствие на наборах дельт с перестановками и повторами.
//
// Состояния строятся только через публичный API (createSticker/editText/move/
// setField) по последовательностям операций — не через произвольные Map — это
// гарантирует корректную форму W1–W4 (consistency-model.md § 7).

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { empty, equals, merge } from "../src/index.js";
import { foldDeltas, scenarioArb } from "./arbitraries.js";

describe("REQ-022 (T1): законы решётки для merge", () => {
  it("REQ-022: T1 коммутативность — merge(a, b) равно merge(b, a)", () => {
    fc.assert(
      fc.property(scenarioArb("comm-a"), scenarioArb("comm-b"), (a, b) => {
        const left = merge(a.merged, b.merged);
        const right = merge(b.merged, a.merged);
        expect(equals(left, right)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("REQ-022: T1 ассоциативность — merge(merge(a,b),c) равно merge(a, merge(b,c))", () => {
    fc.assert(
      fc.property(
        scenarioArb("assoc-a"),
        scenarioArb("assoc-b"),
        scenarioArb("assoc-c"),
        (a, b, c) => {
          const left = merge(merge(a.merged, b.merged), c.merged);
          const right = merge(a.merged, merge(b.merged, c.merged));
          expect(equals(left, right)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("REQ-022: T1 идемпотентность — merge(a, a) равно a", () => {
    fc.assert(
      fc.property(scenarioArb("idem"), (a) => {
        expect(equals(merge(a.merged, a.merged), a.merged)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("REQ-022: T1 — пустое состояние является нейтральным элементом merge", () => {
    fc.assert(
      fc.property(scenarioArb("neutral"), (a) => {
        expect(equals(merge(a.merged, empty()), a.merged)).toBe(true);
        expect(equals(merge(empty(), a.merged), a.merged)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("REQ-022: T1 — merge отдельных дельт по порядку равен merge их же в обратном порядке", () => {
    // Частный, более прямой случай ассоциативности+коммутативности сразу на
    // уровне дельт одной операции, а не только на уровне готовых состояний.
    fc.assert(
      fc.property(scenarioArb("rev", { minOps: 2, maxOps: 10 }), (scenario) => {
        const forward = foldDeltas(scenario.deltas);
        const backward = foldDeltas([...scenario.deltas].reverse());
        expect(equals(forward, backward)).toBe(true);
        expect(equals(forward, scenario.merged)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("REQ-022: equals не зависит от порядка объединения дельт (перестановка при слиянии)", () => {
    fc.assert(
      fc.property(
        scenarioArb("order", { minOps: 2, maxOps: 10 }).chain((scenario) =>
          fc.tuple(
            fc.constant(scenario),
            fc.shuffledSubarray([...scenario.deltas], {
              minLength: scenario.deltas.length,
              maxLength: scenario.deltas.length,
            }),
          ),
        ),
        ([scenario, shuffled]) => {
          const reordered = foldDeltas(shuffled);
          expect(equals(reordered, scenario.merged)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("REQ-022: equals симметрично и рефлексивно на построенных состояниях", () => {
    fc.assert(
      fc.property(scenarioArb("refl-a"), scenarioArb("refl-b"), (a, b) => {
        expect(equals(a.merged, a.merged)).toBe(true);
        expect(equals(a.merged, b.merged)).toBe(equals(b.merged, a.merged));
      }),
      { numRuns: 100 },
    );
  });
});
