// T-004 — «Проводной формат»: приёмочные тесты для `toWire`/`fromWire`
// (docs/spec/consistency-model.md § 6; `WireDelta` в `packages/crdt/src/types.ts`,
// использован в `packages/protocol/src/wire.ts` как `wireDeltaSchema` — этот
// файл не трогает protocol, проверяет только контракт из JSDoc в
// `packages/crdt/src/index.ts`: `toWire`/`fromWire` — взаимно обратные
// проекции `State` (пять Map) в `WireDelta` (пять массивов) и назад, без
// потери/добавления элементов, порядок массивов не значим).
//
// `toWire`/`fromWire` в `src/index.ts` сейчас — заглушки: каждая бросает
// `Error("...: not implemented")`. Каждый вызов ниже поэтому падает по этой
// причине, а не из-за ошибки в самом тесте. Состояния строятся ТОЛЬКО через
// публичный API (`createSticker`/`editText`/`move`/`vote`/`unvote`/`merge`
// напрямую и `scenarioArb`/`voteScenarioArb`/`foldDeltas` из
// `./arbitraries.ts`).

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createSticker,
  editText,
  empty,
  equals,
  fromWire,
  merge,
  newClock,
  type State,
  toWire,
  unvote,
  vote,
} from "../src/index.js";
import { scenarioArb, voteScenarioArb } from "./arbitraries.js";

function combined(entities: State, votesState: State): State {
  return merge(entities, votesState);
}

describe("toWire/fromWire: round-trip (§ 6 — проводной формат State ↔ WireDelta)", () => {
  it("toWire/fromWire round-trip: пустое состояние", () => {
    const wire = toWire(empty());
    expect(equals(fromWire(wire), empty())).toBe(true);
  });

  it("toWire/fromWire round-trip: один стикер, одна конкурентная правка текста, один голос, один отозванный голос", () => {
    let world: State = empty();

    const created = createSticker(world, newClock("actor-1"), {
      column: "start",
      frac: "1",
      text: "исходный",
      color: "yellow",
    });
    world = merge(world, created.delta);
    const id = [...created.delta.created.values()][0]?.id;
    if (id === undefined) throw new Error("не удалось создать стикер");

    // Конкурентная правка — не видела created (другой актор), поэтому
    // оставляет в состоянии конфликт (обе записи text видимы) — упражняет
    // и supersedes (перекрытие своей же предыдущей правки не происходит
    // здесь, но пара supersedes всё равно появляется у edit2 ниже).
    const edit1 = editText(world, newClock("actor-2"), id, "конкурентная правка");
    world = merge(world, edit1.delta);

    // Правка от автора, который edit1 уже видел — создаёт запись в supersedes.
    const edit2 = editText(world, created.clock, id, "правка автора");
    world = merge(world, edit2.delta);

    const voted = vote(world, newClock("voter-1"), id, "user-1");
    world = merge(world, voted.delta);

    const unvoted = unvote(world, voted.dot, id);
    world = merge(world, unvoted);

    const wire = toWire(world);
    expect(equals(fromWire(wire), world)).toBe(true);
  });

  it("toWire/fromWire round-trip: property — произвольные достижимые состояния (сущности + голоса)", () => {
    fc.assert(
      fc.property(
        scenarioArb("wire-entities", { minOps: 1, maxOps: 16 }),
        voteScenarioArb("wire-votes", { minOps: 0, maxOps: 8 }),
        (entities, votesScenario) => {
          const state = combined(entities.merged, votesScenario.merged);
          const wire = toWire(state);
          const back = fromWire(wire);
          expect(equals(back, state)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("toWire: возвращает пять массивов (не Map), по размеру равных соответствующим компонентам state", () => {
    let world: State = empty();
    const created = createSticker(world, newClock("actor-1"), {
      column: "continue",
      frac: "1",
      text: "hello",
      color: "green",
    });
    world = merge(world, created.delta);
    const id = [...created.delta.created.values()][0]?.id;
    if (id === undefined) throw new Error("не удалось создать стикер");
    const voted = vote(world, newClock("voter-1"), id, "user-1");
    world = merge(world, voted.delta);

    const wire = toWire(world);

    expect(Array.isArray(wire.created)).toBe(true);
    expect(Array.isArray(wire.entries)).toBe(true);
    expect(Array.isArray(wire.supersedes)).toBe(true);
    expect(Array.isArray(wire.votes)).toBe(true);
    expect(Array.isArray(wire.unvotes)).toBe(true);

    expect(wire.created).toHaveLength(world.created.size);
    expect(wire.entries).toHaveLength(world.entries.size);
    expect(wire.supersedes).toHaveLength(world.supersedes.size);
    expect(wire.votes).toHaveLength(world.votes.size);
    expect(wire.unvotes).toHaveLength(world.unvotes.size);
  });

  it("fromWire: не зависит от порядка элементов в массивах WireDelta (I3-подобное свойство для проводного формата)", () => {
    fc.assert(
      fc.property(
        scenarioArb("wire-order-entities", { minOps: 2, maxOps: 14 }),
        voteScenarioArb("wire-order-votes", { minOps: 0, maxOps: 6 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (entities, votesScenario, seed) => {
          const state = combined(entities.merged, votesScenario.merged);
          const wire = toWire(state);

          // Детерминированная перестановка каждого массива по seed —
          // без внешних зависимостей на shuffle, устойчиво воспроизводимо.
          const shuffle = <T>(items: readonly T[], salt: number): T[] => {
            const copy = [...items];
            let s = seed + salt + 1;
            for (let i = copy.length - 1; i > 0; i--) {
              s = (s * 1103515245 + 12345) & 0x7fffffff;
              const j = s % (i + 1);
              const tmp = copy[i] as T;
              copy[i] = copy[j] as T;
              copy[j] = tmp;
            }
            return copy;
          };

          const shuffledWire = {
            created: shuffle(wire.created, 1),
            entries: shuffle(wire.entries, 2),
            supersedes: shuffle(wire.supersedes, 3),
            votes: shuffle(wire.votes, 4),
            unvotes: shuffle(wire.unvotes, 5),
          };

          expect(equals(fromWire(shuffledWire), state)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
