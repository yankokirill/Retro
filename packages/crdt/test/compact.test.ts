// T-004 — «Компактизация»: приёмочные тесты для `compact : State → State`
// (docs/spec/consistency-model.md § 6, теорема Т5 ⇒ I4; теорема Т6 ⇒ I5) и
// связанных критериев REQ-025 (кр. 1 — принятая операция не теряется молча)
// и REQ-027 (кр. 1 — перезапуск сервера не меняет видимую доску, проверено
// здесь на уровне состояния: `materialize(compact(X_S(m)) ⊔ хвост) =
// materialize(X_S(n))`, без Postgres — поход в БД остаётся за T-008).
//
// `compact` в `src/index.ts` сейчас — заглушка: `throw new
// Error("compact: not implemented")`. Каждый вызов `compact(...)` ниже
// поэтому бросает эту ошибку — тесты падают из-за отсутствия реализации, а
// не из-за ошибки в самом тесте. Состояния собираются ТОЛЬКО через
// публичный API `src/index.ts` (через `scenarioArb`/`runScenario`/
// `voteScenarioArb`/`foldDeltas` из `./arbitraries.ts`, которые сами строят
// достижимые состояния публичными конструкторами операций T-001/T-002) —
// внутренности `packages/crdt/src`, кроме `index.ts`/`types.ts`, не читались.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CardView, GroupView, Item, View } from "../src/index.js";
import {
  activeVotes,
  compact,
  createSticker,
  deleteEntity,
  dotKey,
  type Entry,
  editText,
  empty,
  equals,
  type Key,
  materialize,
  merge,
  move,
  newClock,
  restoreEntity,
  type State,
  visible,
  vote,
} from "../src/index.js";
import { COLUMNS, foldDeltas, scenarioArb, voteScenarioArb } from "./arbitraries.js";

// ---------------------------------------------------------------------------
// Снимок View как обычных данных для сравнения (см. тот же паттерн в
// materialize.test.ts) — не часть публичного API пакета, локальный помощник
// теста.
// ---------------------------------------------------------------------------

function isGroup(item: Item): item is GroupView {
  return "cards" in item;
}

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

/** Комбинирует независимо сгенерированные состояния сущностей и голосов в одно достижимое состояние. */
function combined(entities: State, votesState: State): State {
  return merge(entities, votesState);
}

// ---------------------------------------------------------------------------
// I4: materialize(compact(X) ⊔ Y) == materialize(X ⊔ Y) (§ 8, Т5)
// ---------------------------------------------------------------------------

describe("I4 / REQ-025: безопасность компактизации", () => {
  it("I4: materialize(compact(X) ⊔ Y) равен materialize(X ⊔ Y) для достижимых X и произвольного Y", () => {
    fc.assert(
      fc.property(
        scenarioArb("compact-x-entities", { minOps: 1, maxOps: 10 }),
        voteScenarioArb("compact-x-votes", { minOps: 0, maxOps: 6 }),
        scenarioArb("compact-y-entities", { minOps: 0, maxOps: 10 }),
        voteScenarioArb("compact-y-votes", { minOps: 0, maxOps: 6 }),
        (xEntities, xVotes, yEntities, yVotes) => {
          const x = combined(xEntities.merged, xVotes.merged);
          const y = combined(yEntities.merged, yVotes.merged);

          const withoutCompact = viewSnapshot(materialize(merge(x, y)));
          const withCompact = viewSnapshot(materialize(merge(compact(x), y)));

          expect(withCompact).toEqual(withoutCompact);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("I4: частный случай Y = ⊥ — materialize(compact(X)) равен materialize(X)", () => {
    fc.assert(
      fc.property(
        scenarioArb("compact-only-entities", { minOps: 1, maxOps: 12 }),
        voteScenarioArb("compact-only-votes", { minOps: 0, maxOps: 6 }),
        (entities, votesScenario) => {
          const x = combined(entities.merged, votesScenario.merged);
          expect(viewSnapshot(materialize(compact(x)))).toEqual(viewSnapshot(materialize(x)));
          // и явно относительно ⊥, как записано в § 8:
          expect(viewSnapshot(materialize(merge(compact(x), empty())))).toEqual(
            viewSnapshot(materialize(merge(x, empty()))),
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// REQ-027 / I5: снапшот + хвост журнала эквивалентен полному replay (§ 6, Т6)
// ---------------------------------------------------------------------------

describe("REQ-027 / I5: снапшот и журнал согласованы (без Postgres — уровень состояния)", () => {
  it("REQ-027: property — для случайного m, materialize(compact(X_S(m)) ⊔ хвост) равен materialize(X_S(n))", () => {
    fc.assert(
      fc.property(
        scenarioArb("replay-m", { minOps: 1, maxOps: 16 }).chain((scenario) =>
          fc.tuple(fc.constant(scenario), fc.integer({ min: 0, max: scenario.deltas.length })),
        ),
        ([scenario, m]) => {
          const full = viewSnapshot(materialize(scenario.merged));
          const before = foldDeltas(scenario.deltas.slice(0, m));
          const after = foldDeltas(scenario.deltas.slice(m));
          const replayed = viewSnapshot(materialize(merge(compact(before), after)));
          expect(replayed).toEqual(full);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("REQ-027: границы — m=0 (снапшот пуст) и m=длина журнала (хвост пуст) дают то же, что полный replay", () => {
    // Явный детерминированный сценарий, а не только property: сходится с
    // критерием приёмки REQ-009 кр.3 — одновременная правка текста и удаление
    // одного стикера не теряются при снапшоте.
    let world: State = empty();
    const deltas = [];

    const created = createSticker(world, newClock("actor-1"), {
      column: "start",
      frac: "1",
      text: "исходный текст",
      color: "yellow",
    });
    world = merge(world, created.delta);
    deltas.push(created.delta);
    const id = [...created.delta.created.values()][0]?.id;
    if (id === undefined) throw new Error("не удалось создать стикер");

    // Конкурентная правка текста от второго актора, не видевшего первую.
    const edit1 = editText(world, newClock("actor-2"), id, "правка от actor-2");
    world = merge(world, edit1.delta);
    deltas.push(edit1.delta);

    const moved = move(world, created.clock, id, { column: "stop", frac: "1" });
    world = merge(world, moved.delta);
    deltas.push(moved.delta);

    const voted = vote(world, newClock("voter-1"), id, "user-1");
    world = merge(world, voted.delta);
    deltas.push(voted.delta);

    const deleted = deleteEntity(world, moved.clock, id);
    world = merge(world, deleted.delta);
    deltas.push(deleted.delta);

    const restored = restoreEntity(world, deleted.clock, id);
    world = merge(world, restored.delta);
    deltas.push(restored.delta);

    const n = deltas.length;
    const full = viewSnapshot(materialize(foldDeltas(deltas)));

    for (const m of [0, Math.floor(n / 2), n]) {
      const before = foldDeltas(deltas.slice(0, m));
      const after = foldDeltas(deltas.slice(m));
      const replayed = viewSnapshot(materialize(merge(compact(before), after)));
      expect(replayed).toEqual(full);
    }
  });
});

// ---------------------------------------------------------------------------
// SIM ВС-6 (docs/spec/simulator.md § 13): equals(compact(X), compact(Y)) —
// точное (не только materialize) сравнение состояний, у одного из которых,
// возможно, уже прошла компактизация (клиент получил снапшот), а у другого
// ещё нет (оракульный X_S — полный журнал без снапшотов). Т5 в
// `consistency-model.md` § 6/8 доказывает только материализованное
// равенство после ⊔ (снапшот + хвост «≈ равны после materialize», строка
// «восстановление» § 6) — структурное равенство после повторной
// компактизации обеих сторон нигде не доказано и не является следствием I4.
// Симулятору (S4) нужно именно оно: `equals` дешевле и строже, чем сравнение
// View через `materialize` (ловит расхождения в скрытых компонентах —
// голосах, supersedes,— которых materialize не показывает).
// ---------------------------------------------------------------------------

describe("SIM ВС-6: equals(compact(X), compact(Y)) как замена equals(X, Y) при снапшоте", () => {
  it("equals: compact(merge(compact(X), Y)) равен compact(merge(X, Y)) для достижимых X, Y", () => {
    fc.assert(
      fc.property(
        scenarioArb("vs6-x-entities", { minOps: 1, maxOps: 10 }),
        voteScenarioArb("vs6-x-votes", { minOps: 0, maxOps: 6 }),
        scenarioArb("vs6-y-entities", { minOps: 0, maxOps: 10 }),
        voteScenarioArb("vs6-y-votes", { minOps: 0, maxOps: 6 }),
        (xEntities, xVotes, yEntities, yVotes) => {
          const x = combined(xEntities.merged, xVotes.merged);
          const y = combined(yEntities.merged, yVotes.merged);

          const viaPreCompact = compact(merge(compact(x), y));
          const direct = compact(merge(x, y));

          expect(equals(viaPreCompact, direct)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("equals: compact — идемпотентна (compact(compact(X)) равен compact(X))", () => {
    fc.assert(
      fc.property(
        scenarioArb("vs6-idem-entities", { minOps: 1, maxOps: 12 }),
        voteScenarioArb("vs6-idem-votes", { minOps: 0, maxOps: 6 }),
        (entities, votesScenario) => {
          const x = combined(entities.merged, votesScenario.merged);
          expect(equals(compact(compact(x)), compact(x))).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// compact не искажает состав: created/supersedes/unvotes неизменны, ни одна
// видимая запись/активный голос не пропадает физически (§ 6, Т3+Т5); объём
// entries/votes не растёт. Не требует конкретного числа удалённых записей —
// только сохранение видимого (I2.1, I2.3, I2.5).
// ---------------------------------------------------------------------------

describe("compact: сохраняет видимый состав, не увеличивает объём", () => {
  it("compact: created/supersedes/unvotes не меняются; entries/votes не растут; видимые записи и активные голоса сохранены как множество", () => {
    fc.assert(
      fc.property(
        scenarioArb("preserve-entities", { minOps: 1, maxOps: 16 }),
        voteScenarioArb("preserve-votes", { minOps: 0, maxOps: 8 }),
        (entities, votesScenario) => {
          const before = combined(entities.merged, votesScenario.merged);
          const after = compact(before);

          expect(after.created).toEqual(before.created);
          expect(after.supersedes).toEqual(before.supersedes);
          expect(after.unvotes).toEqual(before.unvotes);
          expect(after.entries.size).toBeLessThanOrEqual(before.entries.size);
          expect(after.votes.size).toBeLessThanOrEqual(before.votes.size);

          // Для каждой ячейки, встречавшейся в состоянии, множество видимых
          // dot'ов (vis_k) не меняется компактизацией (Т5 в применении к X, ⊥).
          const keys = new Map<string, Key>();
          for (const entry of before.entries.values()) {
            keys.set(`${entry.key.entity} ${entry.key.field}`, entry.key);
          }
          for (const key of keys.values()) {
            const dotsBefore = new Set(visible(before, key).map((e: Entry) => dotKey(e.dot)));
            const dotsAfter = new Set(visible(after, key).map((e: Entry) => dotKey(e.dot)));
            expect(dotsAfter).toEqual(dotsBefore);
          }

          // Активные голоса (active(X)) сохраняются как множество (dot + target).
          const activeBefore = new Set(
            activeVotes(before).map((v) => `${dotKey(v.dot)}|${v.target}`),
          );
          const activeAfter = new Set(
            activeVotes(after).map((v) => `${dotKey(v.dot)}|${v.target}`),
          );
          expect(activeAfter).toEqual(activeBefore);
        },
      ),
      { numRuns: 100 },
    );
  });
});
