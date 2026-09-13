// T-002 — «Остальные операции CRDT», на уровне состояния (без прав/UI —
// это T-011/T-015/T-019).
//
// REQ-009 (кр. 3), REQ-012 (кр. 2), REQ-013 (кр. 1), REQ-018 (кр. 2):
// docs/spec/consistency-model.md § 1.4 (таблица полей и политик разрешения),
// § 3.1 (дельты операций). Плюс общие свойства, обязательные для КАЖДОЙ
// новой операции (crdt-op SKILL.md, п.7; docs/spec/consistency-model.md § 8–9):
// T1 (законы решётки merge), I1.1 (сходимость), I2 (ни один dot не теряется)
// — привязаны к REQ-022, как в lattice.test.ts/convergence.test.ts для T-001.
//
// setColor/setGroup/deleteEntity/restoreEntity/createGroup/renameGroup/
// createAction/assign/setDone НЕ экспортированы `src/index.ts` (T-002 ещё не
// реализован — см. комментарий у PendingT2Ops в test/arbitraries.ts).
// Каждый вызов ниже поэтому бросает `TypeError: ... is not a function`, а не
// проверяет ложную логику самого теста.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compareStamps,
  type Dot,
  editText,
  empty,
  equals,
  merge,
  move,
  values,
  visible,
} from "../src/index.js";
import {
  colorArb,
  createActionForkScenario,
  createForkScenario,
  createGroupForkScenario,
  dotPresent,
  findEntryByDot,
  foldDeltas,
  guestIdArb,
  pendingOps,
  scenarioArb,
  soleEntry,
  textArb,
  valueEquals,
} from "./arbitraries.js";

function dotEquals(a: Dot, b: Dot): boolean {
  return a.actor === b.actor && a.counter === b.counter;
}

describe("REQ-009 кр.3: конкурентные editText и deleteEntity одного стикера (уровень состояния)", () => {
  it("REQ-009 кр.3: стикер оказывается в корзине, но отредактированный текст не теряется", () => {
    const fork = createForkScenario("creator", ["editor", "deleter"], {
      column: "start",
      frac: "a0|frac",
      text: "A",
      color: "yellow",
    });

    // editor меняет текст, не видя, что deleter параллельно удаляет стикер.
    const edit = editText(fork.branchA.state, fork.branchA.clock, fork.id, "B");
    const del = pendingOps.deleteEntity(fork.branchB.state, fork.branchB.clock, fork.id);
    const merged = merge(merge(fork.base, edit.delta), del.delta);

    const textKey = { entity: fork.id, field: "text" as const };
    const deletedKey = { entity: fork.id, field: "deleted" as const };

    // `text` и `deleted` — независимые ячейки (§ 1.4): удаление не перекрывает
    // запись текста и наоборот, поэтому конфликта на каждом отдельном поле нет.
    expect(values(merged, textKey)).toEqual(["B"]);
    expect(values(merged, deletedKey)).toEqual([true]);

    // Стикер "в корзине": exists(id) ∧ deleted(id) (R1, § 4) — на уровне
    // состояния это win_(id,deleted).v === true.
    const deletedWinner = visible(merged, deletedKey)[0];
    expect(deletedWinner?.value).toBe(true);

    // Отредактированный текст не потерян — виден и остаётся физически в E.
    expect(findEntryByDot(merged, textKey, soleEntry(edit.delta).dot)?.value).toBe("B");

    // ...и остаётся виден и после восстановления (REQ-009 кр.2 + кр.3 вместе).
    const restore = pendingOps.restoreEntity(merged, del.clock, fork.id);
    const restored = merge(merged, restore.delta);
    expect(values(restored, deletedKey)).toEqual([false]);
    expect(values(restored, textKey)).toEqual(["B"]);
  });

  it("REQ-009 кр.3: property — независимо от конкретных текста/удаления оба эффекта видны одновременно", () => {
    fc.assert(
      fc.property(textArb(), (newText) => {
        const fork = createForkScenario("creator", ["editor", "deleter"], {
          column: "start",
          frac: "a0|frac",
          text: "seed",
          color: "yellow",
        });
        const edit = editText(fork.branchA.state, fork.branchA.clock, fork.id, newText);
        const del = pendingOps.deleteEntity(fork.branchB.state, fork.branchB.clock, fork.id);
        const merged = merge(merge(fork.base, edit.delta), del.delta);

        const textKey = { entity: fork.id, field: "text" as const };
        const deletedKey = { entity: fork.id, field: "deleted" as const };

        expect(values(merged, textKey)).toEqual([newText]);
        expect(visible(merged, deletedKey)[0]?.value).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

describe("REQ-010 кр.2: конкурентный setColor одного стикера (уровень состояния)", () => {
  it("REQ-010 кр.2: побеждает цвет с большей меткой, проигравший остаётся в entries", () => {
    const fork = createForkScenario("creator", ["u1", "u2"], {
      column: "start",
      frac: "a0|frac",
      text: "A",
      color: "yellow",
    });

    const setA = pendingOps.setColor(fork.branchA.state, fork.branchA.clock, fork.id, "green");
    const setB = pendingOps.setColor(fork.branchB.state, fork.branchB.clock, fork.id, "blue");
    const merged = merge(merge(fork.base, setA.delta), setB.delta);
    const key = { entity: fork.id, field: "color" as const };

    const entryA = soleEntry(setA.delta);
    const entryB = soleEntry(setB.delta);
    const expectedWinner = compareStamps(entryA.stamp, entryB.stamp) >= 0 ? entryA : entryB;
    const expectedLoser = expectedWinner === entryA ? entryB : entryA;

    const visibleEntries = visible(merged, key);
    expect(visibleEntries).toHaveLength(2);

    const winner = visibleEntries.reduce((best, e) =>
      compareStamps(e.stamp, best.stamp) > 0 ? e : best,
    );
    expect(valueEquals(winner.value, expectedWinner.value)).toBe(true);
    expect(dotEquals(winner.dot, expectedWinner.dot)).toBe(true);

    // Проигравший цвет остаётся физически в entries (I2.3/REQ-025), не показывается как текущий.
    const loserEntry = findEntryByDot(merged, key, expectedLoser.dot);
    expect(loserEntry).toBeDefined();
    expect(valueEquals(loserEntry?.value ?? null, expectedLoser.value)).toBe(true);
    expect(dotEquals(winner.dot, expectedLoser.dot)).toBe(false);
  });

  it("REQ-010: property — для произвольной пары разных цветов побеждает больший stamp, проигравший остаётся видимым в истории", () => {
    fc.assert(
      fc.property(
        fc.tuple(colorArb, colorArb).filter(([a, b]) => a !== b),
        fc.integer({ min: 0, max: 3 }),
        (colors, warmup) => {
          const [colorA, colorB] = colors;
          const fork = createForkScenario(
            "creator",
            ["u1", "u2"],
            { column: "start", frac: "a0|frac", text: "A", color: "yellow" },
            [warmup, 0],
          );
          const setA = pendingOps.setColor(fork.branchA.state, fork.branchA.clock, fork.id, colorA);
          const setB = pendingOps.setColor(fork.branchB.state, fork.branchB.clock, fork.id, colorB);
          const merged = merge(merge(fork.base, setA.delta), setB.delta);
          const key = { entity: fork.id, field: "color" as const };

          const entryA = soleEntry(setA.delta);
          const entryB = soleEntry(setB.delta);
          const expectedWinner = compareStamps(entryA.stamp, entryB.stamp) >= 0 ? entryA : entryB;
          const expectedLoser = expectedWinner === entryA ? entryB : entryA;

          const winner = visible(merged, key).reduce((best, e) =>
            compareStamps(e.stamp, best.stamp) > 0 ? e : best,
          );
          expect(dotEquals(winner.dot, expectedWinner.dot)).toBe(true);
          expect(findEntryByDot(merged, key, expectedLoser.dot)).toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("REQ-012 кр.2: конкурентное renameGroup (уровень состояния)", () => {
  it("REQ-012 кр.2: оба варианта названия видны как конфликт («все варианты», как text)", () => {
    const fork = createGroupForkScenario("creator", ["u1", "u2"], {
      column: "start",
      frac: "a0|frac",
      title: "Group A",
    });

    const renameA = pendingOps.renameGroup(
      fork.branchA.state,
      fork.branchA.clock,
      fork.id,
      "Sprint 1",
    );
    const renameB = pendingOps.renameGroup(
      fork.branchB.state,
      fork.branchB.clock,
      fork.id,
      "Итерация 1",
    );
    const merged = merge(merge(fork.base, renameA.delta), renameB.delta);
    const key = { entity: fork.id, field: "title" as const };

    const titles = values(merged, key);
    expect(new Set(titles)).toEqual(new Set(["Sprint 1", "Итерация 1"]));
    expect(titles).toHaveLength(2);
    expect(visible(merged, key)).toHaveLength(2);
  });

  it("REQ-012: property — для произвольных различных названий конкурентный renameGroup не теряет ни один вариант", () => {
    fc.assert(
      fc.property(
        fc.tuple(textArb(), textArb()).filter(([a, b]) => a !== b),
        (titles) => {
          const [titleA, titleB] = titles;
          const fork = createGroupForkScenario("creator", ["u1", "u2"], {
            column: "start",
            frac: "a0|frac",
            title: "seed",
          });
          const renameA = pendingOps.renameGroup(
            fork.branchA.state,
            fork.branchA.clock,
            fork.id,
            titleA,
          );
          const renameB = pendingOps.renameGroup(
            fork.branchB.state,
            fork.branchB.clock,
            fork.id,
            titleB,
          );
          const merged = merge(merge(fork.base, renameA.delta), renameB.delta);
          const key = { entity: fork.id, field: "title" as const };

          expect(new Set(values(merged, key))).toEqual(new Set([titleA, titleB]));
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("REQ-013 кр.1: конкурентный moveGroup через move() (уровень состояния)", () => {
  it("REQ-013 кр.1: побеждает перемещение с большей меткой", () => {
    const fork = createGroupForkScenario("creator", ["u1", "u2"], {
      column: "start",
      frac: "a0|frac",
      title: "Group A",
    });

    // moveGroup переиспользует тот же примитив move()/write((id,"place"),.) —
    // consistency-model.md § 3.1: "поле одно и то же для любого Kind".
    const moveA = move(fork.branchA.state, fork.branchA.clock, fork.id, {
      column: "stop",
      frac: "b0|frac",
    });
    const moveB = move(fork.branchB.state, fork.branchB.clock, fork.id, {
      column: "continue",
      frac: "c0|frac",
    });
    const merged = merge(merge(fork.base, moveA.delta), moveB.delta);
    const key = { entity: fork.id, field: "place" as const };

    const entryA = soleEntry(moveA.delta);
    const entryB = soleEntry(moveB.delta);
    const expectedWinner = compareStamps(entryA.stamp, entryB.stamp) >= 0 ? entryA : entryB;
    const expectedLoser = expectedWinner === entryA ? entryB : entryA;

    const winner = visible(merged, key).reduce((best, e) =>
      compareStamps(e.stamp, best.stamp) > 0 ? e : best,
    );
    expect(dotEquals(winner.dot, expectedWinner.dot)).toBe(true);
    expect(valueEquals(winner.value, expectedWinner.value)).toBe(true);

    // Проигравшее перемещение группы не потеряно — видно в истории (REQ-025).
    const loserEntry = findEntryByDot(merged, key, expectedLoser.dot);
    expect(loserEntry).toBeDefined();
    expect(dotEquals(winner.dot, expectedLoser.dot)).toBe(false);
  });

  it("REQ-013: property — при разных lamport (прогрев одной ветки) побеждает больший lamport", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3 }), (warmup) => {
        const fork = createGroupForkScenario(
          "creator",
          ["u1", "u2"],
          { column: "start", frac: "a0|frac", title: "Group A" },
          [warmup, 0],
        );
        const moveA = move(fork.branchA.state, fork.branchA.clock, fork.id, {
          column: "stop",
          frac: "b0|frac",
        });
        const moveB = move(fork.branchB.state, fork.branchB.clock, fork.id, {
          column: "continue",
          frac: "c0|frac",
        });
        const merged = merge(merge(fork.base, moveA.delta), moveB.delta);
        const key = { entity: fork.id, field: "place" as const };

        const entryA = soleEntry(moveA.delta);
        const entryB = soleEntry(moveB.delta);
        expect(entryA.stamp.lamport).toBeGreaterThan(entryB.stamp.lamport);

        const winner = visible(merged, key).reduce((best, e) =>
          compareStamps(e.stamp, best.stamp) > 0 ? e : best,
        );
        expect(dotEquals(winner.dot, entryA.dot)).toBe(true);
        expect(findEntryByDot(merged, key, entryB.dot)).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });
});

describe("REQ-018 кр.2: конкурентный assign одного action item (уровень состояния)", () => {
  it("REQ-018 кр.2: побеждает назначение с большей меткой, проигравшее — в истории", () => {
    const fork = createActionForkScenario("creator", ["u1", "u2"], { text: "Сделать X" });

    const assignA = pendingOps.assign(fork.branchA.state, fork.branchA.clock, fork.id, "guest-1");
    const assignB = pendingOps.assign(fork.branchB.state, fork.branchB.clock, fork.id, "guest-2");
    const merged = merge(merge(fork.base, assignA.delta), assignB.delta);
    const key = { entity: fork.id, field: "assignee" as const };

    const entryA = soleEntry(assignA.delta);
    const entryB = soleEntry(assignB.delta);
    const expectedWinner = compareStamps(entryA.stamp, entryB.stamp) >= 0 ? entryA : entryB;
    const expectedLoser = expectedWinner === entryA ? entryB : entryA;

    const winner = visible(merged, key).reduce((best, e) =>
      compareStamps(e.stamp, best.stamp) > 0 ? e : best,
    );
    expect(winner.value).toBe(expectedWinner.value);
    expect(dotEquals(winner.dot, expectedWinner.dot)).toBe(true);

    const loserEntry = findEntryByDot(merged, key, expectedLoser.dot);
    expect(loserEntry).toBeDefined();
    expect(loserEntry?.value).toBe(expectedLoser.value);
    expect(dotEquals(winner.dot, expectedLoser.dot)).toBe(false);
  });

  it("REQ-018: property — для произвольной пары разных ответственных (включая «нет ответственного») побеждает больший stamp", () => {
    fc.assert(
      fc.property(
        fc.tuple(guestIdArb, guestIdArb).filter(([a, b]) => a !== b),
        (guestIds) => {
          const [guestA, guestB] = guestIds;
          const fork = createActionForkScenario("creator", ["u1", "u2"], { text: "Сделать X" });
          const assignA = pendingOps.assign(
            fork.branchA.state,
            fork.branchA.clock,
            fork.id,
            guestA,
          );
          const assignB = pendingOps.assign(
            fork.branchB.state,
            fork.branchB.clock,
            fork.id,
            guestB,
          );
          const merged = merge(merge(fork.base, assignA.delta), assignB.delta);
          const key = { entity: fork.id, field: "assignee" as const };

          const entryA = soleEntry(assignA.delta);
          const entryB = soleEntry(assignB.delta);
          const expectedWinner = compareStamps(entryA.stamp, entryB.stamp) >= 0 ? entryA : entryB;
          const expectedLoser = expectedWinner === entryA ? entryB : entryA;

          const winner = visible(merged, key).reduce((best, e) =>
            compareStamps(e.stamp, best.stamp) > 0 ? e : best,
          );
          expect(dotEquals(winner.dot, expectedWinner.dot)).toBe(true);
          expect(findEntryByDot(merged, key, expectedLoser.dot)).toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// REQ-022 — свойства, обязательные для КАЖДОЙ новой операции T-002
// (crdt-op SKILL.md, п.7; docs/spec/consistency-model.md § 8–9), проверенные
// на сценариях, построенных generic-генератором scenarioArb (test/arbitraries.ts),
// который теперь включает setColor/setGroup/delete/restore/createGroup/
// createAction/renameGroup/assign/setDone наравне с операциями T-001.
// ---------------------------------------------------------------------------

describe("REQ-022 (T1/I1.1/I2): свойства merge для операций T-002", () => {
  it("REQ-022: T1 — merge коммутативен и идемпотентен на сценариях с операциями T-002", () => {
    fc.assert(
      fc.property(scenarioArb("t2-comm-a"), scenarioArb("t2-comm-b"), (a, b) => {
        expect(equals(merge(a.merged, b.merged), merge(b.merged, a.merged))).toBe(true);
        expect(equals(merge(a.merged, a.merged), a.merged)).toBe(true);
        expect(equals(merge(a.merged, empty()), a.merged)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("REQ-022: I1.1 — сценарий с операциями T-002 сходится независимо от порядка и повторов слияния его дельт", () => {
    fc.assert(
      fc.property(
        scenarioArb("t2-conv", { minOps: 1, maxOps: 12 }).chain((scenario) =>
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
          const doubled = foldDeltas([...scenario.deltas, ...scenario.deltas]);
          expect(equals(reordered, scenario.merged)).toBe(true);
          expect(equals(doubled, scenario.merged)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("REQ-022: I2 — dot каждой выполненной операции (включая T-002) остаётся физически в состоянии", () => {
    fc.assert(
      fc.property(scenarioArb("t2-noloss", { minOps: 1, maxOps: 12 }), (scenario) => {
        for (const dot of scenario.dots) {
          expect(dotPresent(scenario.merged, dot)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});
