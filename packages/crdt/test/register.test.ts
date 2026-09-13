// REQ-007 (кр. 1–2) и REQ-008 (кр. 1–2) — на уровне состояния CRDT, без
// прав/UI (это T-002/T-011/T-015).
//
// consistency-model.md § 1.4: `text`/`title` — политика «все видимые
// варианты» (конфликт остаётся видимым); `place`/`color`/`group`/`deleted` —
// «победитель по метке» (наибольший Stamp = (lamport, actor), § 1.3), а
// проигравшая запись остаётся в E (не удаляется — § 8, I2.1/I2.3).
//
// Сценарий конкуренции строится через createForkScenario (test/arbitraries.ts):
// один стикер создаётся общим предком, обе ветви получают этот общий предок,
// но не видят операций друг друга — это и есть «не видя правки друг друга»
// из формулировки REQ-007/008.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compareStamps,
  type Dot,
  editText,
  merge,
  move,
  type Stamp,
  values,
  visible,
} from "../src/index.js";
import {
  colorArb,
  columnArb,
  createForkScenario,
  findEntryByDot,
  fracArb,
  soleEntry,
  textArb,
  valueEquals,
} from "./arbitraries.js";

function dotEquals(a: Dot, b: Dot): boolean {
  return a.actor === b.actor && a.counter === b.counter;
}

function maxStamp(a: Stamp, b: Stamp): Stamp {
  return compareStamps(a, b) >= 0 ? a : b;
}

describe("REQ-007: одновременное редактирование текста одного стикера (уровень состояния)", () => {
  it("REQ-007 кр.1: конкурентные editText оставляют оба варианта видимыми, ни один не потерян", () => {
    const fork = createForkScenario("creator", ["u1", "u2"], {
      column: "start",
      frac: "a0|frac",
      text: "A",
      color: "yellow",
    });

    const editU1 = editText(fork.branchA.state, fork.branchA.clock, fork.id, "B");
    const editU2 = editText(fork.branchB.state, fork.branchB.clock, fork.id, "C");

    const merged = merge(merge(fork.base, editU1.delta), editU2.delta);
    const key = { entity: fork.id, field: "text" as const };

    const visibleTexts = values(merged, key);
    expect(new Set(visibleTexts)).toEqual(new Set(["B", "C"]));
    expect(visibleTexts).toHaveLength(2);
    expect(visible(merged, key)).toHaveLength(2);
  });

  it("REQ-007 кр.2: правка, видевшая оба варианта, разрешает конфликт — виден один текст, старые записи остаются в entries", () => {
    const fork = createForkScenario("creator", ["u1", "u2"], {
      column: "start",
      frac: "a0|frac",
      text: "A",
      color: "yellow",
    });

    const editU1 = editText(fork.branchA.state, fork.branchA.clock, fork.id, "B");
    const editU2 = editText(fork.branchB.state, fork.branchB.clock, fork.id, "C");
    const merged = merge(merge(fork.base, editU1.delta), editU2.delta);
    const key = { entity: fork.id, field: "text" as const };

    // Участник видит оба варианта (merged) и сохраняет новое значение.
    // Часы должны быть после editU1 (OpResult.clock), а не branchA.clock "до":
    // иначе dot разрешающей правки совпал бы с dot editU1 (нарушение W1/V1,
    // § 1.2, § 7 — актор берёт следующее значение счётчика).
    const resolverClock = editU1.clock;
    const resolve = editText(merged, resolverClock, fork.id, "resolved");
    const finalState = merge(merged, resolve.delta);

    expect(values(finalState, key)).toEqual(["resolved"]);
    expect(visible(finalState, key)).toHaveLength(1);

    // Оба конфликтовавших варианта физически остаются в state.entries.
    const dotU1 = soleEntry(editU1.delta).dot;
    const dotU2 = soleEntry(editU2.delta).dot;
    expect(findEntryByDot(finalState, key, dotU1)?.value).toBe("B");
    expect(findEntryByDot(finalState, key, dotU2)?.value).toBe("C");
  });

  it("REQ-007: property — для произвольных различных текстов конкурентная правка не теряет ни один вариант", () => {
    fc.assert(
      fc.property(
        fc.tuple(textArb(), textArb()).filter(([a, b]) => a !== b),
        columnArb,
        fracArb,
        colorArb,
        (texts, column, frac, color) => {
          const [textA, textB] = texts;
          const fork = createForkScenario("creator", ["u1", "u2"], {
            column,
            frac,
            text: "seed",
            color,
          });
          const editA = editText(fork.branchA.state, fork.branchA.clock, fork.id, textA);
          const editB = editText(fork.branchB.state, fork.branchB.clock, fork.id, textB);
          const merged = merge(merge(fork.base, editA.delta), editB.delta);
          const key = { entity: fork.id, field: "text" as const };

          expect(new Set(values(merged, key))).toEqual(new Set([textA, textB]));

          // Часы после editA (OpResult.clock), а не branchA.clock "до" —
          // иначе dot резолва совпал бы с dot editA (W1/V1, § 1.2, § 7).
          const resolve = editText(merged, editA.clock, fork.id, "resolved");
          const finalState = merge(merged, resolve.delta);
          expect(values(finalState, key)).toEqual(["resolved"]);
          expect(findEntryByDot(finalState, key, soleEntry(editA.delta).dot)?.value).toBe(textA);
          expect(findEntryByDot(finalState, key, soleEntry(editB.delta).dot)?.value).toBe(textB);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("REQ-008: одновременное перемещение одного стикера (уровень состояния)", () => {
  it("REQ-008 кр.1: конкурентные move — побеждает запись с наибольшей меткой (compareStamps)", () => {
    const fork = createForkScenario("creator", ["u1", "u2"], {
      column: "start",
      frac: "a0|frac",
      text: "A",
      color: "yellow",
    });

    const moveU1 = move(fork.branchA.state, fork.branchA.clock, fork.id, {
      column: "stop",
      frac: "b0|frac",
    });
    const moveU2 = move(fork.branchB.state, fork.branchB.clock, fork.id, {
      column: "continue",
      frac: "c0|frac",
    });
    const merged = merge(merge(fork.base, moveU1.delta), moveU2.delta);
    const key = { entity: fork.id, field: "place" as const };

    const entryU1 = soleEntry(moveU1.delta);
    const entryU2 = soleEntry(moveU2.delta);
    const expectedWinner = compareStamps(entryU1.stamp, entryU2.stamp) >= 0 ? entryU1 : entryU2;

    const visibleEntries = visible(merged, key);
    expect(visibleEntries).toHaveLength(2);

    const winnerEntry = visibleEntries.reduce((best, e) =>
      compareStamps(e.stamp, best.stamp) > 0 ? e : best,
    );
    expect(valueEquals(winnerEntry.value, expectedWinner.value)).toBe(true);
    expect(dotEquals(winnerEntry.dot, expectedWinner.dot)).toBe(true);

    const allValues = values(merged, key);
    expect(valueEquals(allValues[0] ?? null, expectedWinner.value)).toBe(true);
    expect(allValues).toHaveLength(2);
  });

  it("REQ-008 кр.2: проигравшее перемещение не потеряно — видно в entries, хотя не отображается как текущее", () => {
    const fork = createForkScenario("creator", ["u1", "u2"], {
      column: "start",
      frac: "a0|frac",
      text: "A",
      color: "yellow",
    });

    const moveU1 = move(fork.branchA.state, fork.branchA.clock, fork.id, {
      column: "stop",
      frac: "b0|frac",
    });
    const moveU2 = move(fork.branchB.state, fork.branchB.clock, fork.id, {
      column: "continue",
      frac: "c0|frac",
    });
    const merged = merge(merge(fork.base, moveU1.delta), moveU2.delta);
    const key = { entity: fork.id, field: "place" as const };

    const entryU1 = soleEntry(moveU1.delta);
    const entryU2 = soleEntry(moveU2.delta);
    const loserDot = compareStamps(entryU1.stamp, entryU2.stamp) >= 0 ? entryU2.dot : entryU1.dot;
    const loserValue =
      compareStamps(entryU1.stamp, entryU2.stamp) >= 0 ? entryU2.value : entryU1.value;

    // Проигравшая запись остаётся физически в entries...
    const loserInHistory = findEntryByDot(merged, key, loserDot);
    expect(loserInHistory).toBeDefined();
    expect(valueEquals(loserInHistory?.value ?? null, loserValue)).toBe(true);

    // ...но не совпадает с победителем (не отображается как текущее место).
    const winner = visible(merged, key).reduce((best, e) =>
      compareStamps(e.stamp, best.stamp) > 0 ? e : best,
    );
    expect(dotEquals(winner.dot, loserDot)).toBe(false);
  });

  it("REQ-008: property — при разных lamport (после «прогрева» одной из веток) побеждает больший lamport", () => {
    fc.assert(
      fc.property(
        columnArb,
        columnArb,
        fracArb,
        fracArb,
        colorArb,
        fc.integer({ min: 1, max: 3 }),
        (colA, colB, fracA, fracB, color, warmup) => {
          // U1 прогревается — его clock.lamport уходит вперёд относительно U2,
          // поэтому его следующая метка гарантированно больше по lamport.
          const fork = createForkScenario(
            "creator",
            ["u1", "u2"],
            { column: "start", frac: "a0|frac", text: "A", color },
            [warmup, 0],
          );
          const moveU1 = move(fork.branchA.state, fork.branchA.clock, fork.id, {
            column: colA,
            frac: fracA,
          });
          const moveU2 = move(fork.branchB.state, fork.branchB.clock, fork.id, {
            column: colB,
            frac: fracB,
          });
          const merged = merge(merge(fork.base, moveU1.delta), moveU2.delta);
          const key = { entity: fork.id, field: "place" as const };

          const entryU1 = soleEntry(moveU1.delta);
          const entryU2 = soleEntry(moveU2.delta);
          expect(entryU1.stamp.lamport).toBeGreaterThan(entryU2.stamp.lamport);

          const winner = visible(merged, key).reduce((best, e) =>
            compareStamps(e.stamp, best.stamp) > 0 ? e : best,
          );
          expect(dotEquals(winner.dot, entryU1.dot)).toBe(true);
          expect(valueEquals(winner.value, entryU1.value)).toBe(true);

          // Проигравший (U2) остаётся в истории.
          expect(findEntryByDot(merged, key, entryU2.dot)).toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("REQ-008: property — при равных lamport побеждает больший actorId (tie-break из compareStamps)", () => {
    fc.assert(
      fc.property(
        columnArb,
        columnArb,
        fracArb,
        fracArb,
        colorArb,
        (colA, colB, fracA, fracB, color) => {
          // Без прогрева оба свежих актора получают одинаковый lamport
          // (max по общему предку + 1) — метки различаются только actorId.
          const fork = createForkScenario("creator", ["u1", "u2"], {
            column: "start",
            frac: "a0|frac",
            text: "A",
            color,
          });
          const moveU1 = move(fork.branchA.state, fork.branchA.clock, fork.id, {
            column: colA,
            frac: fracA,
          });
          const moveU2 = move(fork.branchB.state, fork.branchB.clock, fork.id, {
            column: colB,
            frac: fracB,
          });
          const merged = merge(merge(fork.base, moveU1.delta), moveU2.delta);
          const key = { entity: fork.id, field: "place" as const };

          const entryU1 = soleEntry(moveU1.delta);
          const entryU2 = soleEntry(moveU2.delta);
          const expectedWinnerDot =
            maxStamp(entryU1.stamp, entryU2.stamp) === entryU1.stamp ? entryU1.dot : entryU2.dot;

          const winner = visible(merged, key).reduce((best, e) =>
            compareStamps(e.stamp, best.stamp) > 0 ? e : best,
          );
          expect(dotEquals(winner.dot, expectedWinnerDot)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
