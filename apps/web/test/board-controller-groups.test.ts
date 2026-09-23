// T-016 § 2 — группы в контроллере доски поверх настоящего createSyncClient.
// REQ-011 (кр. 1-3), REQ-012, REQ-013.

import { createMemoryOutboxStore, createSyncClient } from "@retro/client-core";
import {
  type CardView,
  type Column,
  createGroup,
  createSticker,
  empty,
  type GroupView,
  type Item,
  move,
  newClock,
  type State,
  setField,
  toWire,
  type WireDelta,
} from "@retro/crdt";
import { type BoardMeta, serverMessageSchema } from "@retro/protocol";
import { describe, expect, it } from "vitest";
import { createBoardController } from "../src/board-controller.js";

const BOARD = "22222222-2222-4222-8222-222222222222";
const ME = "11111111-1111-4111-8111-111111111111";
const ACTOR_X = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTOR_Y = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const META: BoardMeta = {
  boardId: BOARD,
  title: "Ретро",
  phase: "group",
  revealed: true,
  voteLimit: 3,
  timer: null,
  authors: {},
};

const msg = (m: unknown) => JSON.stringify(serverMessageSchema.parse(m));
const opMsg = (seq: number, delta: WireDelta) => msg({ type: "op", seq, delta });

function setup(ops: { seq: number; delta: WireDelta }[] = []) {
  const client = createSyncClient(
    { boardId: BOARD, guestId: "guest-1", displayName: "Аня" },
    { newActorId: () => ME, newCommandId: () => "cmd", outbox: createMemoryOutboxStore() },
  );
  const sent: string[] = [];
  const controller = createBoardController({
    client,
    send: (lines) => {
      sent.push(...lines);
    },
  });
  client.connected();
  client.receive(
    msg({
      type: "welcome",
      role: "participant",
      voterToken: "voter-1",
      meta: META,
      snapshot: null,
      ops,
    }),
  );
  controller.refresh();
  const items = (column: Column): Item[] =>
    [...(controller.store.getState().view.columns.get(column) ?? [])] as Item[];
  const isGroup = (item: Item): item is GroupView => "cards" in item;
  const groups = (column: Column) => items(column).filter(isGroup);
  const cards = (column: Column) => items(column).filter((i): i is CardView => !isGroup(i));
  const groupTitles = (column: Column) => groups(column).map((g) => g.title.join("|"));
  return { client, controller, sent, items, groups, cards, groupTitles };
}

function remoteGroup(title = "G", column: Column = "start") {
  const created = createGroup(empty(), newClock(ACTOR_X), { column, frac: "a", title });
  return {
    state: created.delta as State,
    id: [...created.delta.created.values()][0]?.id as string,
    wire: toWire(created.delta),
  };
}

function remoteSticker(text = "A", column: Column = "start") {
  const created = createSticker(empty(), newClock(ACTOR_X), {
    column,
    frac: "a",
    text,
    color: "yellow",
  });
  return {
    state: created.delta as State,
    id: [...created.delta.created.values()][0]?.id as string,
    wire: toWire(created.delta),
  };
}

describe("BoardController: группы", () => {
  it("REQ-012: createGroup кладёт группу в конец колонки, без стикеров, отправляет op", () => {
    const s = setup();
    s.controller.addSticker("start", "a", "yellow");
    const before = s.sent.length;
    expect(s.controller.createGroup("start", "Первая").ok).toBe(true);
    expect(s.sent.length).toBe(before + 1);
    s.controller.createGroup("start", "Вторая");
    const items = s.items("start");
    expect(items).toHaveLength(3);
    expect(s.groupTitles("start")).toEqual(["Первая", "Вторая"]);
    expect(s.groups("start")[0]?.cards).toHaveLength(0);
    expect(items.map((i) => ("cards" in i ? i.title.join("") : i.text.join("")))).toEqual([
      "a",
      "Первая",
      "Вторая",
    ]);
  });

  it("REQ-012: название обрезается по краям", () => {
    const s = setup();
    s.controller.createGroup("stop", "  Тема \n");
    expect(s.groupTitles("stop")).toEqual(["Тема"]);
  });

  it("REQ-012: пустое название — invalid_intent, send не вызывается", () => {
    const s = setup();
    for (const t of ["", "  ", "\n\t"]) {
      expect(s.controller.createGroup("start", t)).toEqual({ ok: false, reason: "invalid_intent" });
    }
    expect(s.sent).toHaveLength(0);
    expect(s.client.inspect().pending).toHaveLength(0);
    expect(s.groups("start")).toHaveLength(0);
  });

  it("REQ-012: renameGroup меняет название; пустое — invalid_intent без send", () => {
    const s = setup();
    s.controller.createGroup("start", "Старое");
    const id = (s.groups("start")[0] as GroupView).id;
    expect(s.controller.renameGroup(id, "Новое").ok).toBe(true);
    expect(s.groupTitles("start")).toEqual(["Новое"]);
    const before = s.sent.length;
    expect(s.controller.renameGroup(id, "   ")).toEqual({ ok: false, reason: "invalid_intent" });
    expect(s.sent).toHaveLength(before);
    expect(s.groupTitles("start")).toEqual(["Новое"]);
  });

  it("REQ-012 кр.2: конкурентное переименование — оба варианта, conflict=true; renameGroup разрешает", () => {
    const remote = remoteGroup("G");
    const s = setup([{ seq: 1, delta: remote.wire }]);
    s.controller.renameGroup(remote.id, "B");
    const theirs = setField(
      remote.state,
      newClock(ACTOR_Y),
      { entity: remote.id, field: "title" },
      "C",
    );
    s.client.receive(opMsg(2, toWire(theirs.delta)));
    s.controller.refresh();

    const group = s.groups("start")[0] as GroupView;
    expect(group.conflict).toBe(true);
    expect([...group.title].sort()).toEqual(["B", "C"]);

    s.controller.renameGroup(remote.id, "C");
    const resolved = s.groups("start")[0] as GroupView;
    expect(resolved.conflict).toBe(false);
    expect(resolved.title).toEqual(["C"]);
  });

  it("REQ-011 кр.1/2: setGroup помещает стикер внутрь группы, setGroup(null) возвращает на своё место", () => {
    const s = setup();
    s.controller.addSticker("start", "a", "yellow");
    s.controller.addSticker("start", "b", "yellow");
    s.controller.createGroup("start", "G");
    const g = (s.groups("start")[0] as GroupView).id;
    const a = (s.cards("start")[0] as CardView).id;

    expect(s.controller.setGroup(a, g).ok).toBe(true);
    expect(s.cards("start").map((c) => c.text.join(""))).toEqual(["b"]);
    expect((s.groups("start")[0] as GroupView).cards.map((c) => c.id)).toEqual([a]);

    expect(s.controller.setGroup(a, null).ok).toBe(true);
    expect(s.groups("start")[0]?.cards).toHaveLength(0);
    expect(s.items("start").map((i) => ("cards" in i ? "G" : i.text.join("")))).toEqual([
      "a",
      "b",
      "G",
    ]);
  });

  it("REQ-011 кр.2: возврат из группы — в колонку из собственного place, изменённого пока стикер был в группе", () => {
    const remote = remoteSticker("A", "start");
    const s = setup([{ seq: 1, delta: remote.wire }]);
    s.controller.createGroup("start", "G");
    const g = (s.groups("start")[0] as GroupView).id;
    s.controller.setGroup(remote.id, g);
    const theirs = move(remote.state, newClock(ACTOR_Y), remote.id, {
      column: "stop",
      frac: "a",
    });
    s.client.receive(opMsg(2, toWire(theirs.delta)));
    s.controller.refresh();
    s.controller.setGroup(remote.id, null);
    expect(s.cards("start")).toHaveLength(0);
    expect(s.cards("stop").map((c) => c.id)).toEqual([remote.id]);
  });

  it("REQ-011 кр.3/REQ-013 кр.2: удаление группы — стикер виден в колонке напрямую, группа в корзине с названием", () => {
    const s = setup();
    s.controller.addSticker("start", "a", "yellow");
    s.controller.createGroup("start", "Тема");
    const g = (s.groups("start")[0] as GroupView).id;
    const a = (s.cards("start")[0] as CardView).id;
    s.controller.setGroup(a, g);
    expect(s.cards("start")).toHaveLength(0);

    expect(s.controller.remove(g).ok).toBe(true);
    expect(s.groups("start")).toHaveLength(0);
    expect(s.cards("start").map((c) => c.id)).toEqual([a]);
    expect(s.controller.store.getState().trash).toEqual([{ id: g, text: ["Тема"] }]);

    expect(s.controller.restore(g).ok).toBe(true);
    expect(s.groups("start")).toHaveLength(1);
    expect(s.controller.store.getState().trash).toEqual([]);
  });

  it("REQ-013: moveTo переносит группу между колонками и внутри колонки", () => {
    const s = setup();
    s.controller.createGroup("start", "g1");
    s.controller.createGroup("start", "g2");
    const [g1, g2] = s.groups("start") as [GroupView, GroupView];
    s.controller.moveTo(g2.id, "start", 0);
    expect(s.groupTitles("start")).toEqual(["g2", "g1"]);
    s.controller.moveTo(g1.id, "stop", 0);
    expect(s.groupTitles("start")).toEqual(["g2"]);
    expect(s.groupTitles("stop")).toEqual(["g1"]);
  });

  it("REQ-013 кр.1: конкурентное перемещение группы — ровно в одной колонке", () => {
    const remote = remoteGroup("G", "start");
    const s = setup([{ seq: 1, delta: remote.wire }]);
    s.controller.moveTo(remote.id, "stop", 0);
    const theirs = move(remote.state, newClock(ACTOR_Y), remote.id, {
      column: "continue",
      frac: "a",
    });
    s.client.receive(opMsg(2, toWire(theirs.delta)));
    s.controller.refresh();
    const where = (["start", "stop", "continue"] as Column[]).filter((c) =>
      s.groups(c).some((g) => g.id === remote.id),
    );
    expect(where).toHaveLength(1);
  });
});
