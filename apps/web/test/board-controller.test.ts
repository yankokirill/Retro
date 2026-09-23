// T-015 § 4 — контроллер доски поверх настоящего createSyncClient.

import { createMemoryOutboxStore, createSyncClient, type SyncClient } from "@retro/client-core";
import {
  type CardView,
  type Column,
  createSticker,
  editText,
  move,
  newClock,
  type State,
  toWire,
  type WireDelta,
  winner,
} from "@retro/crdt";
import {
  type BoardMeta,
  clientMessageSchema,
  type RejectReason,
  serverMessageSchema,
} from "@retro/protocol";
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

function welcome(ops: { seq: number; delta: WireDelta }[] = []) {
  return msg({
    type: "welcome",
    role: "participant",
    voterToken: "voter-1",
    meta: META,
    snapshot: null,
    ops,
  });
}
const opMsg = (seq: number, delta: WireDelta) => msg({ type: "op", seq, delta });
const rejectMsg = (dot: { actor: string; counter: number }, reason: RejectReason) =>
  msg({ type: "reject", dot, reason, message: "отклонено" });

function setup(ops: { seq: number; delta: WireDelta }[] = []) {
  const client: SyncClient = createSyncClient(
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
  client.receive(welcome(ops));
  controller.refresh();
  const view = () => controller.store.getState().view;
  const items = (column: Column): CardView[] => (view().columns.get(column) ?? []) as CardView[];
  const texts = (column: Column) => items(column).map((c) => c.text.join("|"));
  return { client, controller, sent, view, items, texts };
}

/** Стикер, созданный другим актором; возвращает состояние, которое он видел. */
function remoteSticker(text = "A", column: Column = "start") {
  const created = createSticker(
    {
      created: new Map(),
      entries: new Map(),
      supersedes: new Map(),
      votes: new Map(),
      unvotes: new Map(),
    },
    newClock(ACTOR_X),
    { column, frac: "a", text, color: "yellow" },
  );
  return {
    state: created.delta as State,
    id: [...created.delta.created.values()][0]?.id as string,
    wire: toWire(created.delta),
  };
}

describe("createBoardController", () => {
  it("REQ-005: addSticker кладёт стикер в конец колонки с текстом и цветом, отправляет op", () => {
    const { controller, sent, items } = setup();
    const res = controller.addSticker("start", "первый", "green");
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(clientMessageSchema.parse(JSON.parse(sent[0] as string)).type).toBe("op");
    expect(items("start")).toHaveLength(1);
    expect(items("start")[0]?.text).toEqual(["первый"]);
    expect(items("start")[0]?.color).toBe("green");
  });

  it("REQ-005: несколько addSticker сохраняют порядок добавления", () => {
    const { controller, texts } = setup();
    for (const t of ["a", "b", "c", "d"]) controller.addSticker("stop", t, "yellow");
    expect(texts("stop")).toEqual(["a", "b", "c", "d"]);
  });

  it("REQ-005: текст обрезается по краям", () => {
    const { controller, texts } = setup();
    controller.addSticker("start", "  привет \n", "blue");
    expect(texts("start")).toEqual(["привет"]);
  });

  it("REQ-005: пустой/пробельный текст — invalid_intent, send не вызывается, pending не растёт", () => {
    const { controller, sent, client, items } = setup();
    for (const t of ["", "   ", "\n\t"]) {
      expect(controller.addSticker("start", t, "yellow")).toEqual({
        ok: false,
        reason: "invalid_intent",
      });
    }
    expect(sent).toHaveLength(0);
    expect(client.inspect().pending).toHaveLength(0);
    expect(items("start")).toHaveLength(0);
  });

  it("REQ-005: состояние стора отражает status, role, meta, pendingCount", () => {
    const { controller } = setup();
    controller.addSticker("start", "x", "pink");
    const s = controller.store.getState();
    expect(s.status).toBe("welcomed");
    expect(s.role).toBe("participant");
    expect(s.meta?.phase).toBe("group");
    expect(s.pendingCount).toBe(1);
  });

  it("REQ-007: editText меняет текст стикера", () => {
    const { controller, items } = setup();
    controller.addSticker("start", "было", "yellow");
    const id = (items("start")[0] as CardView).id;
    expect(controller.editText(id, "стало").ok).toBe(true);
    expect(items("start")[0]?.text).toEqual(["стало"]);
  });

  it("REQ-007: editText с пустым текстом — invalid_intent", () => {
    const { controller, items, sent } = setup();
    controller.addSticker("start", "было", "yellow");
    const before = sent.length;
    const id = (items("start")[0] as CardView).id;
    expect(controller.editText(id, "  ")).toEqual({ ok: false, reason: "invalid_intent" });
    expect(sent).toHaveLength(before);
  });

  it("REQ-010: setColor меняет цвет", () => {
    const { controller, items } = setup();
    controller.addSticker("start", "x", "yellow");
    const id = (items("start")[0] as CardView).id;
    controller.setColor(id, "purple");
    expect(items("start")[0]?.color).toBe("purple");
  });

  it("REQ-009: remove убирает стикер из колонки в корзину, restore возвращает на то же место", () => {
    const { controller, items, texts } = setup();
    for (const t of ["a", "b", "c"]) controller.addSticker("start", t, "yellow");
    const id = (items("start")[1] as CardView).id;
    controller.remove(id);
    expect(texts("start")).toEqual(["a", "c"]);
    expect(controller.store.getState().trash).toEqual([{ id, text: ["b"] }]);
    controller.restore(id);
    expect(controller.store.getState().trash).toEqual([]);
    expect(texts("start")).toEqual(["a", "b", "c"]);
  });

  it("REQ-009: чужая конкурентная правка не теряется при удалении", () => {
    const remote = remoteSticker("A");
    const s = setup([{ seq: 1, delta: remote.wire }]);
    const id = (s.items("start")[0] as CardView).id;
    s.controller.remove(id);
    const edit = editText(remote.state, newClock(ACTOR_Y), id, "правка");
    s.client.receive(opMsg(2, toWire(edit.delta)));
    s.controller.refresh();
    const trash = s.controller.store.getState().trash;
    expect(trash).toHaveLength(1);
    expect(trash[0]?.id).toBe(id);
    expect(trash[0]?.text).toContain("правка");
    expect(s.items("start")).toHaveLength(0);
  });

  it("REQ-008: moveTo с индексом между соседями", () => {
    const { controller, items, texts } = setup();
    for (const t of ["a", "b", "c"]) controller.addSticker("start", t, "yellow");
    const [a, , c] = items("start") as [CardView, CardView, CardView];
    controller.moveTo(c.id, "start", 0);
    expect(texts("start")).toEqual(["c", "a", "b"]);
    controller.moveTo(a.id, "start", 2);
    // индекс считается без самого a: [c, b] -> a в конец
    expect(texts("start")).toEqual(["c", "b", "a"]);
    controller.moveTo(a.id, "start", 1);
    expect(texts("start")).toEqual(["c", "a", "b"]);
  });

  it("REQ-008: moveTo в другую колонку", () => {
    const { controller, items, texts } = setup();
    controller.addSticker("start", "a", "yellow");
    controller.addSticker("stop", "x", "yellow");
    controller.addSticker("stop", "y", "yellow");
    const a = (items("start")[0] as CardView).id;
    controller.moveTo(a, "stop", 1);
    expect(texts("start")).toEqual([]);
    expect(texts("stop")).toEqual(["x", "a", "y"]);
    controller.moveTo(a, "continue", 0);
    expect(texts("continue")).toEqual(["a"]);
    expect(texts("stop")).toEqual(["x", "y"]);
  });

  it("REQ-008: конкурентное перемещение — стикер ровно в одной колонке, побеждает большая метка", () => {
    const remote = remoteSticker("A", "start");
    const s = setup([{ seq: 1, delta: remote.wire }]);
    const id = remote.id;
    s.controller.moveTo(id, "stop", 0);
    const theirs = move(remote.state, newClock(ACTOR_Y), id, { column: "continue", frac: "a" });
    s.client.receive(opMsg(2, toWire(theirs.delta)));
    s.controller.refresh();

    const where = (["start", "stop", "continue"] as Column[]).filter((c) =>
      s.items(c).some((card) => card.id === id),
    );
    expect(where).toHaveLength(1);
    const win = winner(s.client.inspect().full, { entity: id, field: "place" });
    expect(win && (win.value as { column: Column }).column).toBe(where[0]);
  });

  it("REQ-007: конкурентное редактирование текста — оба варианта, conflict=true; editText разрешает", () => {
    const remote = remoteSticker("A");
    const s = setup([{ seq: 1, delta: remote.wire }]);
    const id = remote.id;
    s.controller.editText(id, "B");
    const theirs = editText(remote.state, newClock(ACTOR_Y), id, "C");
    s.client.receive(opMsg(2, toWire(theirs.delta)));
    s.controller.refresh();

    const card = s.items("start")[0] as CardView;
    expect(card.conflict).toBe(true);
    expect([...card.text].sort()).toEqual(["B", "C"]);

    s.controller.editText(id, "C");
    const resolved = s.items("start")[0] as CardView;
    expect(resolved.conflict).toBe(false);
    expect(resolved.text).toEqual(["C"]);
  });

  it("REQ-024: reject даёт notice с непустым текстом; повторный refresh не дублирует", () => {
    const s = setup();
    s.controller.addSticker("start", "x", "yellow");
    const dot = s.client.inspect().pending[0]?.dot as { actor: string; counter: number };
    s.client.receive(rejectMsg(dot, "wrong_phase"));
    s.controller.refresh();
    s.controller.refresh();
    const { notices } = s.controller.store.getState();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text.trim().length).toBeGreaterThan(0);
    expect(s.items("start")).toHaveLength(0);

    s.controller.addSticker("start", "y", "yellow");
    const dot2 = s.client.inspect().pending[0]?.dot as { actor: string; counter: number };
    s.client.receive(rejectMsg(dot2, "forbidden"));
    s.controller.refresh();
    expect(s.controller.store.getState().notices).toHaveLength(2);
  });

  it("REQ-024: dismissNotice убирает уведомление", () => {
    const s = setup();
    s.controller.addSticker("start", "x", "yellow");
    const dot = s.client.inspect().pending[0]?.dot as { actor: string; counter: number };
    s.client.receive(rejectMsg(dot, "forbidden"));
    s.controller.refresh();
    const id = (s.controller.store.getState().notices[0] as { id: number }).id;
    (s.controller as unknown as { dismissNotice(id: number): void }).dismissNotice(id);
    expect(s.controller.store.getState().notices).toHaveLength(0);
  });

  it("REQ-023: до welcome addSticker кладётся в очередь, send не получает строк", () => {
    const client = createSyncClient(
      { boardId: BOARD, guestId: "guest-1", displayName: "Аня" },
      { newActorId: () => ME, newCommandId: () => "cmd", outbox: createMemoryOutboxStore() },
    );
    const sent: string[] = [];
    const controller = createBoardController({ client, send: (l) => void sent.push(...l) });
    expect(controller.addSticker("start", "офлайн", "yellow").ok).toBe(true);
    expect(sent).toHaveLength(0);
    expect(controller.store.getState().pendingCount).toBe(1);
    expect((controller.store.getState().view.columns.get("start") ?? []).length).toBe(1);
  });
});
