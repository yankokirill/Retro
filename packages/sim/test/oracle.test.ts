// SIM-XX — оракул (`packages/sim/src/oracle.ts`), docs/spec/simulator.md § 8
// (преамбула: X_S, proj_u), docs/spec/consistency-model.md § 5 (proj_u),
// REQ-006. Оракул реализован заново по спецификации (SIM-01 кр. 2), поэтому
// «ожидаемое» здесь тоже считается вручную по формуле спецификации, а не
// позаимствовано у `@retro/server-core` (`projectVisible` не импортируется).
//
// `foldLog` уже реализован (не заглушка) — используется как независимый
// эталон свёртки журнала. `foldNewRows`/`proj`/`visibleSame` — заглушки,
// каждый `it`, который их вызывает, падает на `Error("...: not implemented")`.

import type { Created, EntityId, Entry, Kind, State, Supersede, Unvote, Vote } from "@retro/crdt";
import {
  createAction,
  createGroup,
  createSticker,
  empty,
  equals,
  merge,
  newClock,
  toWire,
} from "@retro/crdt";
import type { OpRow } from "@retro/server-core";
import { describe, expect, it } from "vitest";
import type { Phase } from "../src/config.js";
import { createOracleState, foldLog, foldNewRows, proj, visibleSame } from "../src/oracle.js";

const GUEST_1 = "guest-1";
const GUEST_2 = "guest-2";
const GUEST_3 = "guest-3";

interface Fixture {
  readonly rows: readonly OpRow[];
  readonly state: State;
  readonly stickerAuthor: ReadonlyMap<EntityId, string>;
  readonly sticker1: EntityId;
  readonly sticker2: EntityId;
  readonly groupId: EntityId;
  readonly actionId: EntityId;
}

/**
 * Два стикера (по одному на гостя 1 и 2), одна группа и один action item —
 * группа/action не имеют "автора" в модели видимости (только sticker
 * фильтруется, § 5 consistency-model.md), поэтому видны всем даже в collect.
 */
function buildFixture(): Fixture {
  let state: State = empty();
  const rows: OpRow[] = [];
  let seq = 0;

  const c1 = createSticker(state, newClock("actor-1"), {
    column: "start",
    frac: "a",
    text: "from guest1",
    color: "yellow",
  });
  state = merge(state, c1.delta);
  seq += 1;
  rows.push({ seq, delta: toWire(c1.delta) });
  const sticker1 = [...c1.delta.created.values()][0]?.id;
  if (!sticker1) throw new Error("buildFixture: sticker1 missing");

  const c2 = createSticker(state, newClock("actor-2"), {
    column: "start",
    frac: "b",
    text: "from guest2",
    color: "green",
  });
  state = merge(state, c2.delta);
  seq += 1;
  rows.push({ seq, delta: toWire(c2.delta) });
  const sticker2 = [...c2.delta.created.values()][0]?.id;
  if (!sticker2) throw new Error("buildFixture: sticker2 missing");

  // Продолжаем часы actor-1 (c1.clock), а не newClock("actor-1") заново —
  // иначе счётчик actor-1 обнулялся бы на каждой операции, и dot группы
  // совпал бы с dot'ом sticker1 (оба стали бы "actor-1:1", один id на две
  // разные сущности). Найдено при реализации oracle.ts (2026-09-16): тест
  // требовал видимости группы и action item независимо от sticker1, но
  // коллизия id значила, что группа физически подменяла sticker1 в
  // state.created при merge.
  const g = createGroup(state, c1.clock, { column: "start", frac: "c", title: "group" });
  state = merge(state, g.delta);
  seq += 1;
  rows.push({ seq, delta: toWire(g.delta) });
  const groupId = [...g.delta.created.values()][0]?.id;
  if (!groupId) throw new Error("buildFixture: groupId missing");

  const a = createAction(state, g.clock, { text: "do it" });
  state = merge(state, a.delta);
  seq += 1;
  rows.push({ seq, delta: toWire(a.delta) });
  const actionId = [...a.delta.created.values()][0]?.id;
  if (!actionId) throw new Error("buildFixture: actionId missing");

  const stickerAuthor = new Map<EntityId, string>([
    [sticker1, GUEST_1],
    [sticker2, GUEST_2],
  ]);

  return { rows, state, stickerAuthor, sticker1, sticker2, groupId, actionId };
}

/** Ожидаемая proj_u вручную по формуле § 5 consistency-model.md / § 8 simulator.md. */
function expectedProj(
  state: State,
  phase: Phase,
  stickerAuthor: ReadonlyMap<EntityId, string>,
  guestId: string,
): State {
  const kindOf = new Map<EntityId, Kind>();
  for (const c of state.created.values()) kindOf.set(c.id, c.kind);

  const visible = (id: EntityId): boolean => {
    if (phase !== "collect") return true;
    if (kindOf.get(id) !== "sticker") return true;
    return stickerAuthor.get(id) === guestId;
  };

  const created = new Map<string, Created>();
  for (const [k, v] of state.created) if (visible(v.id)) created.set(k, v);
  const entries = new Map<string, Entry>();
  for (const [k, v] of state.entries) if (visible(v.key.entity)) entries.set(k, v);
  const supersedes = new Map<string, Supersede>();
  for (const [k, v] of state.supersedes) if (visible(v.key.entity)) supersedes.set(k, v);
  const votes = new Map<string, Vote>();
  for (const [k, v] of state.votes) if (visible(v.target)) votes.set(k, v);
  const unvotes = new Map<string, Unvote>();
  for (const [k, v] of state.unvotes) if (visible(v.target)) unvotes.set(k, v);

  return { created, entries, supersedes, votes, unvotes };
}

describe("SIM-XX: oracle.foldNewRows — сходится к тому же, что foldLog, независимо от разбиения на партии", () => {
  it("SIM-XX / I1.1: foldLog на перестановке строк даёт то же состояние, что и в порядке seq", () => {
    const { rows } = buildFixture();
    const inOrder = foldLog(rows);
    const reversed = foldLog([...rows].reverse());
    expect(equals(inOrder, reversed)).toBe(true);
  });

  it("SIM-XX: foldNewRows, вызванный несколькими партиями, сходится к foldLog(весь журнал)", () => {
    const { rows } = buildFixture();
    const oracle = createOracleState();
    foldNewRows(oracle, rows.slice(0, 2));
    foldNewRows(oracle, rows.slice(2));

    const expected = foldLog(rows);
    expect(equals(oracle.x, expected)).toBe(true);
    const lastRow = rows[rows.length - 1];
    expect(oracle.lastFoldedSeq).toBe(lastRow?.seq);
  });
});

describe("SIM-XX / proj: REQ-006 — видимость стикеров в collect, группы/action всегда видны", () => {
  it("SIM-XX / proj: в collect автор видит все компоненты своего стикера", () => {
    const { state, stickerAuthor, sticker1 } = buildFixture();
    const actual = proj(state, "collect", stickerAuthor, GUEST_1);
    const expected = expectedProj(state, "collect", stickerAuthor, GUEST_1);
    expect(equals(actual, expected)).toBe(true);
    // sticker1 (свой) виден: есть хотя бы одна запись created с этим id.
    expect([...actual.created.values()].some((c) => c.id === sticker1)).toBe(true);
  });

  it("SIM-XX / proj: в collect чужой стикер не виден вовсе (ни created, ни entries)", () => {
    const { state, stickerAuthor, sticker2 } = buildFixture();
    const actual = proj(state, "collect", stickerAuthor, GUEST_1);
    expect([...actual.created.values()].some((c) => c.id === sticker2)).toBe(false);
    expect([...actual.entries.values()].some((e) => e.key.entity === sticker2)).toBe(false);
  });

  it("SIM-XX / proj: в collect группа и action item видны гостю, не создававшему стикеров вовсе", () => {
    const { state, stickerAuthor, groupId, actionId } = buildFixture();
    const actual = proj(state, "collect", stickerAuthor, GUEST_3);
    expect([...actual.created.values()].some((c) => c.id === groupId)).toBe(true);
    expect([...actual.created.values()].some((c) => c.id === actionId)).toBe(true);
    const expected = expectedProj(state, "collect", stickerAuthor, GUEST_3);
    expect(equals(actual, expected)).toBe(true);
  });

  it("SIM-XX / proj: после смены фазы на group оба гостя видят всё (P2 — видимость только расширяется)", () => {
    const { state, stickerAuthor, sticker1, sticker2 } = buildFixture();
    const forGuest1 = proj(state, "group", stickerAuthor, GUEST_1);
    const forGuest2 = proj(state, "group", stickerAuthor, GUEST_2);
    expect(equals(forGuest1, state)).toBe(true);
    expect(equals(forGuest2, state)).toBe(true);
    expect([...forGuest1.created.values()].some((c) => c.id === sticker2)).toBe(true);
    expect([...forGuest2.created.values()].some((c) => c.id === sticker1)).toBe(true);
  });
});

describe("SIM-XX / visibleSame: proj_a(X) equals proj_b(X) — S5", () => {
  it("SIM-XX / visibleSame: два гостя, ни один не автор ни одного стикера — одинаковая видимость (true)", () => {
    const { state, stickerAuthor } = buildFixture();
    // GUEST_3 не создавал стикеров; сравниваем с другим "чистым" гостем.
    expect(visibleSame(state, "collect", stickerAuthor, GUEST_3, "guest-4")).toBe(true);
  });

  it("SIM-XX / visibleSame: автор стикера и не-автор при наличии скрытого стикера — разная видимость (false)", () => {
    const { state, stickerAuthor } = buildFixture();
    // GUEST_1 видит свой sticker1 (скрытый от остальных); GUEST_3 — нет.
    expect(visibleSame(state, "collect", stickerAuthor, GUEST_1, GUEST_3)).toBe(false);
  });

  it("SIM-XX / visibleSame: после reveal (фаза ≠ collect) видимость одинакова у всех", () => {
    const { state, stickerAuthor } = buildFixture();
    expect(visibleSame(state, "group", stickerAuthor, GUEST_1, GUEST_3)).toBe(true);
    expect(visibleSame(state, "group", stickerAuthor, GUEST_1, GUEST_2)).toBe(true);
  });
});
