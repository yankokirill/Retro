// T-003 — «Материализация доски»: приёмочные тесты для `materialize : State →
// View` (docs/spec/consistency-model.md § 4, правила R1–R7) и связанных
// критериев REQ-009 (кр. 1–2), REQ-011 (кр. 2–3), REQ-013 (кр. 2), REQ-015
// (кр. 5), REQ-026.
//
// `materialize` в `src/index.ts` сейчас — заглушка: `throw new
// Error("materialize: not implemented")` (см. JSDoc над функцией). Каждый
// вызов `materialize(...)` ниже поэтому бросает эту ошибку — тесты падают
// из-за отсутствия реализации, а не из-за ошибки в самом тесте. Все
// состояния собираются ТОЛЬКО через публичный API `src/index.ts`
// (createSticker/createGroup/createAction/editText/move/setColor/setGroup/
// deleteEntity/restoreEntity/renameGroup/vote/unvote/merge) — CRDT-уровень
// намеренно не проверяет существование/вид цели (это V3, забота сервера),
// поэтому даже «стикер с несуществующей группой» строится обычным
// `setGroup`, без обращения к внутренним структурам пакета.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  activeVotes,
  type CardView,
  compareStamps,
  createAction,
  createGroup,
  createSticker,
  type Delta,
  deleteEntity,
  dotKey,
  editText,
  empty,
  type GroupView,
  type Item,
  materialize,
  merge,
  move,
  newClock,
  renameGroup,
  restoreEntity,
  setColor,
  setGroup,
  unvote,
  type View,
  vote,
} from "../src/index.js";
import {
  COLUMNS,
  createForkScenario,
  createGroupForkScenario,
  foldDeltas,
  scenarioArb,
  soleEntry,
} from "./arbitraries.js";

// ---------------------------------------------------------------------------
// Мелкие помощники теста (не часть публичного API пакета).
// ---------------------------------------------------------------------------

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("first: пустой список");
  return item;
}

function isGroup(item: Item): item is GroupView {
  return "cards" in item;
}

/** Снимок View как обычных данных — для сравнения между разными сборками состояния (I3/REQ-026). */
function viewSnapshot(view: View) {
  const summarizeCard = (card: CardView) => ({
    kind: "card" as const,
    id: card.id,
    text: [...card.text],
    conflict: card.conflict,
    color: card.color,
    votes: card.votes,
  });
  const summarizeItem = (item: Item) =>
    isGroup(item)
      ? {
          kind: "group" as const,
          id: item.id,
          title: [...item.title],
          conflict: item.conflict,
          cards: item.cards.map(summarizeCard),
        }
      : summarizeCard(item);

  const columns: Record<string, unknown[]> = {};
  for (const column of COLUMNS) {
    columns[column] = (view.columns.get(column) ?? []).map(summarizeItem);
  }
  return {
    columns,
    trash: [...view.trash],
    actions: view.actions.map((a) => ({
      id: a.id,
      text: [...a.text],
      conflict: a.conflict,
      assignee: a.assignee,
      done: a.done,
    })),
  };
}

// ---------------------------------------------------------------------------
// R1 — видимость и корзина.
// ---------------------------------------------------------------------------

describe("R1: сущность видна тогда и только тогда, когда exists ∧ ¬deleted", () => {
  it("REQ-009 кр.1–2: неудалённый стикер виден в колонке; удалённый — в корзине; восстановленный — снова виден", () => {
    const created = createSticker(empty(), newClock("owner"), {
      column: "start",
      frac: "m",
      text: "A",
      color: "yellow",
    });
    let state = merge(empty(), created.delta);
    const id = dotKey(created.dot);

    let view = materialize(state);
    expect(view.columns.get("start")).toEqual([
      { id, text: ["A"], conflict: false, color: "yellow", votes: 0 },
    ]);
    expect(view.trash).toEqual([]);

    const del = deleteEntity(state, created.clock, id);
    state = merge(state, del.delta);
    view = materialize(state);
    expect(view.columns.get("start") ?? []).toEqual([]);
    expect(view.trash).toEqual([id]);

    const restored = restoreEntity(state, del.clock, id);
    state = merge(state, restored.delta);
    view = materialize(state);
    expect(view.trash).toEqual([]);
    expect(view.columns.get("start")).toEqual([
      { id, text: ["A"], conflict: false, color: "yellow", votes: 0 },
    ]);
  });

  it("REQ-009 кр.2: восстановленный сгруппированный стикер возвращается внутрь своей группы (последнее известное место)", () => {
    const group = createGroup(empty(), newClock("owner"), {
      column: "start",
      frac: "g1",
      title: "G",
    });
    let state = merge(empty(), group.delta);
    const groupId = dotKey(group.dot);

    const sticker = createSticker(state, group.clock, {
      column: "stop",
      frac: "s1",
      text: "A",
      color: "yellow",
    });
    state = merge(state, sticker.delta);
    const stickerId = dotKey(sticker.dot);

    const setG = setGroup(state, sticker.clock, stickerId, groupId);
    state = merge(state, setG.delta);

    const del = deleteEntity(state, setG.clock, stickerId);
    state = merge(state, del.delta);
    expect(materialize(state).trash).toEqual([stickerId]);

    const restored = restoreEntity(state, del.clock, stickerId);
    state = merge(state, restored.delta);

    const view = materialize(state);
    expect(view.trash).toEqual([]);
    const group1 = first(view.columns.get("start") ?? []);
    if (!isGroup(group1)) throw new Error("ожидалась группа в колонке start");
    expect(group1.cards.map((c) => c.id)).toEqual([stickerId]);
  });

  it("R1: запись в ячейку для сущности, для которой нет записи в created, игнорируется", () => {
    const ghostWrite = editText(empty(), newClock("actor-1"), "never-created-id", "hello");
    const state = merge(empty(), ghostWrite.delta);
    const view = materialize(state);
    expect(view.trash).toEqual([]);
    for (const column of COLUMNS) {
      expect(view.columns.get(column) ?? []).toEqual([]);
    }
  });

  it("R1: удалённый action item пропадает из списка действий и не попадает в корзину (в отличие от стикеров/групп)", () => {
    const created = createAction(empty(), newClock("owner"), { text: "Do X" });
    let state = merge(empty(), created.delta);
    const id = dotKey(created.dot);

    let view = materialize(state);
    expect(view.actions).toEqual([
      { id, text: ["Do X"], conflict: false, assignee: null, done: false },
    ]);

    const del = deleteEntity(state, created.clock, id);
    state = merge(state, del.delta);
    view = materialize(state);
    expect(view.actions).toEqual([]);
    expect(view.trash).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R2 — text/title: все видимые значения + конфликт; color: победитель по метке.
// ---------------------------------------------------------------------------

describe("R2: text/title — все видимые значения и конфликт; color — победитель по метке", () => {
  it("R2: единственное значение text — conflict=false", () => {
    const created = createSticker(empty(), newClock("owner"), {
      column: "start",
      frac: "1",
      text: "A",
      color: "yellow",
    });
    const state = merge(empty(), created.delta);
    const card = first(materialize(state).columns.get("start") ?? []) as CardView;
    expect(card.text).toEqual(["A"]);
    expect(card.conflict).toBe(false);
  });

  it("REQ-007: конкурентные editText — оба варианта видны, conflict=true", () => {
    const fork = createForkScenario("creator", ["u1", "u2"], {
      column: "start",
      frac: "1",
      text: "seed",
      color: "yellow",
    });
    const editA = editText(fork.branchA.state, fork.branchA.clock, fork.id, "B");
    const editB = editText(fork.branchB.state, fork.branchB.clock, fork.id, "C");
    const merged = merge(merge(fork.base, editA.delta), editB.delta);
    const card = first(materialize(merged).columns.get("start") ?? []) as CardView;
    expect(new Set(card.text)).toEqual(new Set(["B", "C"]));
    expect(card.text).toHaveLength(2);
    expect(card.conflict).toBe(true);
  });

  it("REQ-012 кр.2: конкурентное renameGroup — оба варианта title видны, conflict=true", () => {
    const fork = createGroupForkScenario("creator", ["u1", "u2"], {
      column: "start",
      frac: "1",
      title: "seed",
    });
    const renameA = renameGroup(fork.branchA.state, fork.branchA.clock, fork.id, "Sprint 1");
    const renameB = renameGroup(fork.branchB.state, fork.branchB.clock, fork.id, "Итерация 1");
    const merged = merge(merge(fork.base, renameA.delta), renameB.delta);
    const group = first(materialize(merged).columns.get("start") ?? []);
    if (!isGroup(group)) throw new Error("ожидалась группа в колонке start");
    expect(new Set(group.title)).toEqual(new Set(["Sprint 1", "Итерация 1"]));
    expect(group.title).toHaveLength(2);
    expect(group.conflict).toBe(true);
    expect(group.cards).toEqual([]);
    // Никто не голосовал — счётчик группы (ADR-0006) остаётся нулевым.
    expect(group.votes).toBe(0);
  });

  it("REQ-010 кр.2: конкурентный setColor — во View показан победитель по метке, проигравший цвет не виден", () => {
    const fork = createForkScenario("creator", ["u1", "u2"], {
      column: "start",
      frac: "1",
      text: "A",
      color: "yellow",
    });
    const setA = setColor(fork.branchA.state, fork.branchA.clock, fork.id, "green");
    const setB = setColor(fork.branchB.state, fork.branchB.clock, fork.id, "blue");
    const merged = merge(merge(fork.base, setA.delta), setB.delta);

    const entryA = soleEntry(setA.delta);
    const entryB = soleEntry(setB.delta);
    const winnerIsA = compareStamps(entryA.stamp, entryB.stamp) >= 0;
    const expectedColor = winnerIsA ? "green" : "blue";

    const card = first(materialize(merged).columns.get("start") ?? []) as CardView;
    expect(card.color).toBe(expectedColor);
  });
});

// ---------------------------------------------------------------------------
// R3/R4 — эффективная группа стикера и её последствия для отображения.
// ---------------------------------------------------------------------------

describe("R3/R4: эффективная группа стикера", () => {
  it("REQ-011 кр.1: стикер с валидной группой отображается внутри группы, а не напрямую в колонке", () => {
    const group = createGroup(empty(), newClock("owner"), {
      column: "start",
      frac: "g1",
      title: "Group",
    });
    let state = merge(empty(), group.delta);
    const groupId = dotKey(group.dot);

    const sticker = createSticker(state, group.clock, {
      column: "start",
      frac: "s1",
      text: "A",
      color: "yellow",
    });
    state = merge(state, sticker.delta);
    const stickerId = dotKey(sticker.dot);

    const setG = setGroup(state, sticker.clock, stickerId, groupId);
    state = merge(state, setG.delta);

    const view = materialize(state);
    expect(view.columns.get("start")).toEqual([
      {
        id: groupId,
        title: ["Group"],
        conflict: false,
        cards: [{ id: stickerId, text: ["A"], conflict: false, color: "yellow", votes: 0 }],
        votes: 0,
      },
    ]);
  });

  it("REQ-011 кр.2: setGroup(none) возвращает стикер в колонку по последнему известному place — даже если place менялся, пока стикер лежал в группе", () => {
    const group = createGroup(empty(), newClock("owner"), {
      column: "start",
      frac: "g1",
      title: "G",
    });
    let state = merge(empty(), group.delta);
    const groupId = dotKey(group.dot);

    const sticker = createSticker(state, group.clock, {
      column: "start",
      frac: "s1",
      text: "A",
      color: "yellow",
    });
    state = merge(state, sticker.delta);
    const stickerId = dotKey(sticker.dot);
    let clock = sticker.clock;

    const setG = setGroup(state, clock, stickerId, groupId);
    state = merge(state, setG.delta);
    clock = setG.clock;

    // place стикера меняют, пока он лежит в группе — R4: собственный place не
    // используется, пока есть эффективная группа, но запись физически применяется.
    const moved = move(state, clock, stickerId, { column: "stop", frac: "z9" });
    state = merge(state, moved.delta);
    clock = moved.clock;

    const ungroup = setGroup(state, clock, stickerId, null);
    state = merge(state, ungroup.delta);

    const view = materialize(state);
    expect(view.columns.get("start") ?? []).toEqual([]);
    expect(view.columns.get("stop")).toEqual([
      { id: stickerId, text: ["A"], conflict: false, color: "yellow", votes: 0 },
    ]);
  });

  it("R3: group указывает на несуществующий id — трактуется как «нет группы»", () => {
    const created = createSticker(empty(), newClock("owner"), {
      column: "start",
      frac: "s1",
      text: "A",
      color: "yellow",
    });
    let state = merge(empty(), created.delta);
    const id = dotKey(created.dot);
    const setG = setGroup(state, created.clock, id, "nonexistent-group-id");
    state = merge(state, setG.delta);

    const view = materialize(state);
    expect(view.columns.get("start")).toEqual([
      { id, text: ["A"], conflict: false, color: "yellow", votes: 0 },
    ]);
  });

  it("R3: group указывает на сущность другого вида (стикер, не группа) — трактуется как «нет группы»", () => {
    const a = createSticker(empty(), newClock("owner"), {
      column: "start",
      frac: "s1",
      text: "A",
      color: "yellow",
    });
    let state = merge(empty(), a.delta);
    const b = createSticker(state, a.clock, {
      column: "start",
      frac: "s2",
      text: "B",
      color: "green",
    });
    state = merge(state, b.delta);
    const idA = dotKey(a.dot);
    const idB = dotKey(b.dot);

    const setG = setGroup(state, b.clock, idA, idB);
    state = merge(state, setG.delta);

    const items = materialize(state).columns.get("start") ?? [];
    expect(items).toHaveLength(2);
    for (const item of items) expect(isGroup(item)).toBe(false);
    expect(new Set(items.map((i) => i.id))).toEqual(new Set([idA, idB]));
  });

  it("REQ-011 кр.3 / REQ-013 кр.2: group указывает на удалённую группу — стикер отображается в своей колонке напрямую", () => {
    const group = createGroup(empty(), newClock("owner"), {
      column: "start",
      frac: "g1",
      title: "G",
    });
    let state = merge(empty(), group.delta);
    const groupId = dotKey(group.dot);

    const sticker = createSticker(state, group.clock, {
      column: "stop",
      frac: "s1",
      text: "A",
      color: "yellow",
    });
    state = merge(state, sticker.delta);
    const stickerId = dotKey(sticker.dot);

    const setG = setGroup(state, sticker.clock, stickerId, groupId);
    state = merge(state, setG.delta);

    const del = deleteEntity(state, setG.clock, groupId);
    state = merge(state, del.delta);

    const view = materialize(state);
    expect(view.trash).toEqual([groupId]);
    expect(view.columns.get("stop")).toEqual([
      { id: stickerId, text: ["A"], conflict: false, color: "yellow", votes: 0 },
    ]);
    // Стикер не должен остаться "спрятанным" внутри несуществующей группы нигде.
    for (const column of COLUMNS) {
      for (const item of view.columns.get(column) ?? []) {
        if (isGroup(item)) expect(item.id).not.toBe(groupId);
      }
    }
  });

  it("REQ-013 кр.1: конкурентное перемещение группы — побеждает большая метка (проверка на уровне View)", () => {
    const fork = createGroupForkScenario("creator", ["u1", "u2"], {
      column: "start",
      frac: "g1",
      title: "G",
    });
    const moveA = move(fork.branchA.state, fork.branchA.clock, fork.id, {
      column: "stop",
      frac: "b0",
    });
    const moveB = move(fork.branchB.state, fork.branchB.clock, fork.id, {
      column: "continue",
      frac: "c0",
    });
    const merged = merge(merge(fork.base, moveA.delta), moveB.delta);

    const entryA = soleEntry(moveA.delta);
    const entryB = soleEntry(moveB.delta);
    const winnerColumn =
      compareStamps(entryA.stamp, entryB.stamp) >= 0 ? entryA.value : entryB.value;
    const winnerColumnName = (winnerColumn as { column: string }).column;

    const view = materialize(merged);
    // Группа встречается ровно в одной колонке — победившей.
    let found = 0;
    for (const column of COLUMNS) {
      const items = view.columns.get(column) ?? [];
      if (items.some((item) => item.id === fork.id)) {
        found += 1;
        expect(column).toBe(winnerColumnName);
      }
    }
    expect(found).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R5 — порядок внутри колонки/группы: по (frac, id).
// ---------------------------------------------------------------------------

describe("R5: порядок внутри колонки и группы — по (frac, id)", () => {
  it("REQ-026: стикеры в колонке отсортированы по frac по возрастанию, независимо от порядка слияния дельт", () => {
    const c1 = createSticker(empty(), newClock("a1"), {
      column: "start",
      frac: "3",
      text: "third",
      color: "yellow",
    });
    const c2 = createSticker(empty(), newClock("a2"), {
      column: "start",
      frac: "1",
      text: "first",
      color: "green",
    });
    const c3 = createSticker(empty(), newClock("a3"), {
      column: "start",
      frac: "2",
      text: "second",
      color: "blue",
    });

    const forward = merge(merge(merge(empty(), c1.delta), c2.delta), c3.delta);
    const backward = merge(merge(merge(empty(), c3.delta), c2.delta), c1.delta);

    for (const state of [forward, backward]) {
      const items = materialize(state).columns.get("start") ?? [];
      expect(items.map((i) => (i as CardView).text[0])).toEqual(["first", "second", "third"]);
    }
  });

  it("R5: при равных frac порядок решает Dot (лексикографически по actor, затем counter)", () => {
    const late = createSticker(empty(), newClock("zz"), {
      column: "start",
      frac: "m",
      text: "Z",
      color: "yellow",
    });
    const early = createSticker(empty(), newClock("aa"), {
      column: "start",
      frac: "m",
      text: "A",
      color: "green",
    });
    // Слияние в порядке "поздний по dot создан первым" не должно влиять на итоговый порядок.
    const state = merge(merge(empty(), late.delta), early.delta);
    const items = materialize(state).columns.get("start") ?? [];
    expect(items.map((i) => (i as CardView).text[0])).toEqual(["A", "Z"]);
  });

  it("R5: стикеры внутри группы тоже отсортированы по (frac, id), а не по порядку setGroup", () => {
    const group = createGroup(empty(), newClock("owner"), {
      column: "start",
      frac: "g1",
      title: "G",
    });
    let state = merge(empty(), group.delta);
    const groupId = dotKey(group.dot);

    const s1 = createSticker(state, newClock("a1"), {
      column: "start",
      frac: "2",
      text: "second",
      color: "yellow",
    });
    state = merge(state, s1.delta);
    const s2 = createSticker(state, newClock("a2"), {
      column: "start",
      frac: "1",
      text: "first",
      color: "green",
    });
    state = merge(state, s2.delta);

    // setGroup применяется в порядке "second, затем first" — обратном ожидаемому порядку отображения.
    const g1 = setGroup(state, s1.clock, dotKey(s1.dot), groupId);
    state = merge(state, g1.delta);
    const g2 = setGroup(state, s2.clock, dotKey(s2.dot), groupId);
    state = merge(state, g2.delta);

    const items = materialize(state).columns.get("start") ?? [];
    const groupView = items.find(isGroup);
    if (!groupView) throw new Error("ожидалась группа в колонке start");
    expect(groupView.cards.map((c) => c.text[0])).toEqual(["first", "second"]);
  });
});

// ---------------------------------------------------------------------------
// R6 — счётчик голосов.
// ---------------------------------------------------------------------------

describe("R6 / REQ-015 кр.5: счётчик голосов", () => {
  it("R6: votes = число активных голосов; отозванные не считаются", () => {
    const created = createSticker(empty(), newClock("owner"), {
      column: "start",
      frac: "1",
      text: "A",
      color: "yellow",
    });
    let state = merge(empty(), created.delta);
    const id = dotKey(created.dot);

    const v1 = vote(state, newClock("actor-1"), id, "user-1");
    state = merge(state, v1.delta);
    const v2 = vote(state, newClock("actor-2"), id, "user-2");
    state = merge(state, v2.delta);

    let card = first(materialize(state).columns.get("start") ?? []) as CardView;
    expect(card.votes).toBe(2);

    const un = unvote(state, v1.dot, id);
    state = merge(state, un);
    card = first(materialize(state).columns.get("start") ?? []) as CardView;
    expect(card.votes).toBe(1);
  });

  it("REQ-015 кр.5: голоса разных участников за одну сущность суммируются в общий счётчик", () => {
    const created = createSticker(empty(), newClock("owner"), {
      column: "start",
      frac: "1",
      text: "A",
      color: "yellow",
    });
    let state = merge(empty(), created.delta);
    const id = dotKey(created.dot);

    for (const [actor, user] of [
      ["actor-1", "user-1"],
      ["actor-2", "user-2"],
      ["actor-3", "user-3"],
    ] as const) {
      const v = vote(state, newClock(actor), id, user);
      state = merge(state, v.delta);
    }

    const card = first(materialize(state).columns.get("start") ?? []) as CardView;
    expect(card.votes).toBe(3);
  });

  it("REQ-015 кр.5: CardView не раскрывает, кто именно проголосовал — только суммарный счётчик", () => {
    const created = createSticker(empty(), newClock("owner"), {
      column: "start",
      frac: "1",
      text: "A",
      color: "yellow",
    });
    let state = merge(empty(), created.delta);
    const id = dotKey(created.dot);
    const v1 = vote(state, newClock("actor-1"), id, "user-1");
    state = merge(state, v1.delta);
    const v2 = vote(state, newClock("actor-2"), id, "user-2");
    state = merge(state, v2.delta);

    const card = first(materialize(state).columns.get("start") ?? []) as CardView;
    expect(card.votes).toBe(2);
    // Форма CardView (§ 4) не содержит поля со списком/идентификаторами
    // проголосовавших — только id/text/conflict/color/votes.
    expect(Object.keys(card).sort()).toEqual(["color", "conflict", "id", "text", "votes"]);
  });

  it("R6: голоса за удалённый стикер не показываются нигде во View, но остаются действующими (I2.5)", () => {
    const created = createSticker(empty(), newClock("owner"), {
      column: "start",
      frac: "1",
      text: "A",
      color: "yellow",
    });
    let state = merge(empty(), created.delta);
    const id = dotKey(created.dot);

    const v1 = vote(state, newClock("actor-1"), id, "user-1");
    state = merge(state, v1.delta);

    const del = deleteEntity(state, created.clock, id);
    state = merge(state, del.delta);

    const view = materialize(state);
    expect(view.trash).toEqual([id]);
    expect(view.columns.get("start") ?? []).toEqual([]);
    // Голос физически остаётся действующим на уровне состояния — просто негде
    // его показать, раз стикер в корзине (R6, § 8 I2.5).
    expect(activeVotes(state, id)).toHaveLength(1);
  });

  it("REQ-015 кр.1,5 / ADR-0006: голосование за группу — GroupView.votes считает активные голоса, unvote уменьшает счётчик", () => {
    const group = createGroup(empty(), newClock("owner"), {
      column: "start",
      frac: "g1",
      title: "G",
    });
    let state = merge(empty(), group.delta);
    const groupId = dotKey(group.dot);

    const v1 = vote(state, newClock("actor-1"), groupId, "user-1");
    state = merge(state, v1.delta);
    const v2 = vote(state, newClock("actor-2"), groupId, "user-2");
    state = merge(state, v2.delta);

    let item = first(materialize(state).columns.get("start") ?? []);
    if (!isGroup(item)) throw new Error("ожидалась группа в колонке start");
    expect(item.votes).toBe(2);

    const un = unvote(state, v1.dot, groupId);
    state = merge(state, un);
    item = first(materialize(state).columns.get("start") ?? []);
    if (!isGroup(item)) throw new Error("ожидалась группа в колонке start");
    expect(item.votes).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R7 — trash и actions отсортированы по id.
// ---------------------------------------------------------------------------

describe("R7: trash и actions отсортированы по id", () => {
  it("R7: корзина (стикеры и группы вперемешку) отсортирована по id, а не по порядку/времени удаления", () => {
    const s1 = createSticker(empty(), newClock("zz"), {
      column: "start",
      frac: "1",
      text: "Z-sticker",
      color: "yellow",
    });
    let state = merge(empty(), s1.delta);
    const g1 = createGroup(state, newClock("mm"), { column: "start", frac: "2", title: "M-group" });
    state = merge(state, g1.delta);
    const s2 = createSticker(state, newClock("aa"), {
      column: "start",
      frac: "3",
      text: "A-sticker",
      color: "green",
    });
    state = merge(state, s2.delta);

    const idZ = dotKey(s1.dot);
    const idM = dotKey(g1.dot);
    const idA = dotKey(s2.dot);

    // Удаляем в порядке Z, M, A — не совпадающем ни с алфавитным, ни с обратным порядком id.
    const delZ = deleteEntity(state, s1.clock, idZ);
    state = merge(state, delZ.delta);
    const delM = deleteEntity(state, g1.clock, idM);
    state = merge(state, delM.delta);
    const delA = deleteEntity(state, s2.clock, idA);
    state = merge(state, delA.delta);

    const view = materialize(state);
    expect(new Set(view.trash)).toEqual(new Set([idZ, idM, idA]));
    expect(view.trash).toEqual([...view.trash].sort());
  });

  it("R7: actions отсортированы по id", () => {
    const a1 = createAction(empty(), newClock("zz"), { text: "Z" });
    let state = merge(empty(), a1.delta);
    const a2 = createAction(state, newClock("aa"), { text: "A" });
    state = merge(state, a2.delta);
    const a3 = createAction(state, newClock("mm"), { text: "M" });
    state = merge(state, a3.delta);

    const view = materialize(state);
    const ids = view.actions.map((a) => a.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// REQ-026 / I3 — materialize не зависит от порядка сборки состояния.
// ---------------------------------------------------------------------------

describe("REQ-026 / I3: materialize не зависит от порядка, в котором state собирали", () => {
  it("REQ-026: один и тот же набор дельт, слитый в разных порядках и разными пачками, даёт одинаковый View", () => {
    const group = createGroup(empty(), newClock("owner"), {
      column: "start",
      frac: "g1",
      title: "Group",
    });
    let world = merge(empty(), group.delta);
    const groupId = dotKey(group.dot);
    const deltas: Delta[] = [group.delta];

    const s1 = createSticker(world, newClock("a1"), {
      column: "start",
      frac: "1",
      text: "one",
      color: "yellow",
    });
    world = merge(world, s1.delta);
    deltas.push(s1.delta);

    const s2 = createSticker(world, newClock("a2"), {
      column: "stop",
      frac: "2",
      text: "two",
      color: "green",
    });
    world = merge(world, s2.delta);
    deltas.push(s2.delta);

    const setG = setGroup(world, s1.clock, dotKey(s1.dot), groupId);
    world = merge(world, setG.delta);
    deltas.push(setG.delta);

    const voted = vote(world, newClock("voter-1"), dotKey(s2.dot), "user-1");
    world = merge(world, voted.delta);
    deltas.push(voted.delta);

    const del = deleteEntity(world, s2.clock, dotKey(s2.dot));
    world = merge(world, del.delta);
    deltas.push(del.delta);

    const client1 = foldDeltas(deltas);
    const client2 = foldDeltas([...deltas].reverse());
    const half = Math.ceil(deltas.length / 2);
    const batchA = foldDeltas(deltas.slice(0, half));
    const batchB = foldDeltas(deltas.slice(half));
    const client3 = merge(batchB, batchA); // другое разбиение на пачки И другой порядок их слияния

    const expected = viewSnapshot(materialize(client1));
    expect(viewSnapshot(materialize(client2))).toEqual(expected);
    expect(viewSnapshot(materialize(client3))).toEqual(expected);
  });

  it("REQ-026 / I3: property — для случайных сценариев T-001/T-002 materialize не зависит от порядка/группировки merge дельт", () => {
    fc.assert(
      fc.property(
        scenarioArb("materialize-i3", { minOps: 1, maxOps: 12 }).chain((scenario) =>
          fc.tuple(
            fc.constant(scenario),
            fc.shuffledSubarray([...scenario.deltas], {
              minLength: scenario.deltas.length,
              maxLength: scenario.deltas.length,
            }),
          ),
        ),
        ([scenario, shuffled]) => {
          const expected = viewSnapshot(materialize(scenario.merged));
          const reordered = viewSnapshot(materialize(foldDeltas(shuffled)));
          const doubled = viewSnapshot(
            materialize(foldDeltas([...scenario.deltas, ...scenario.deltas])),
          );
          expect(reordered).toEqual(expected);
          expect(doubled).toEqual(expected);
        },
      ),
      { numRuns: 50 },
    );
  });
});
