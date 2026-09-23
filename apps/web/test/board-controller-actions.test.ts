// T-019 § 2 — action items в контроллере доски поверх настоящего createSyncClient.
// REQ-017 (кр. 1-2), REQ-018, REQ-019 (кр. 1).

import { createMemoryOutboxStore, createSyncClient } from "@retro/client-core";
import {
  type ActionView,
  assign,
  type Clock,
  createAction,
  empty,
  newClock,
  type OpResult,
  type State,
  setDone,
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
const GUEST_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GUEST_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const META: BoardMeta = {
  boardId: BOARD,
  title: "Ретро",
  phase: "actions",
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
  const actions = (): readonly ActionView[] => controller.store.getState().view.actions;
  return { client, controller, sent, actions };
}

function remoteAction(text = "Сделать") {
  const created = createAction(empty(), newClock(ACTOR_X), { text });
  return {
    state: created.delta as State,
    id: [...created.delta.created.values()][0]?.id as string,
    wire: toWire(created.delta),
  };
}

/** Цепочка правок удалённого актора Y: возвращает дельты и итоговое состояние. */
function chainY(base: State, makers: ((s: State, c: Clock) => OpResult)[]) {
  let clock = newClock(ACTOR_Y);
  const state = base;
  const wires: WireDelta[] = [];
  for (const make of makers) {
    const op = make(state, clock);
    clock = op.clock;
    wires.push(toWire(op.delta));
  }
  return wires;
}

function deliver(s: ReturnType<typeof setup>, from: number, wires: WireDelta[]) {
  wires.forEach((w, i) => {
    s.client.receive(opMsg(from + i, w));
  });
  s.controller.refresh();
}

describe("BoardController: action items", () => {
  it("REQ-017 кр.1: createAction добавляет action item без ответственного, отправляет op", () => {
    const s = setup();
    const before = s.sent.length;
    expect(s.controller.createAction("Позвонить клиенту").ok).toBe(true);
    expect(s.sent.length).toBe(before + 1);
    expect(s.actions()).toHaveLength(1);
    const a = s.actions()[0] as ActionView;
    expect(a.text).toEqual(["Позвонить клиенту"]);
    expect(a.assignee).toBeNull();
    expect(a.done).toBe(false);
    expect(a.conflict).toBe(false);
  });

  it("REQ-017: текст обрезается по краям", () => {
    const s = setup();
    s.controller.createAction("  Дело \n");
    expect(s.actions()[0]?.text).toEqual(["Дело"]);
  });

  it("REQ-017: пустой текст — invalid_intent, send не вызывается", () => {
    const s = setup();
    for (const t of ["", "  ", "\n\t"]) {
      expect(s.controller.createAction(t)).toEqual({ ok: false, reason: "invalid_intent" });
    }
    expect(s.sent).toHaveLength(0);
    expect(s.client.inspect().pending).toHaveLength(0);
    expect(s.actions()).toHaveLength(0);
  });

  it("REQ-017 кр.2: editAction меняет текст; пустой — invalid_intent без send", () => {
    const s = setup();
    s.controller.createAction("Старое");
    const id = (s.actions()[0] as ActionView).id;
    expect(s.controller.editAction(id, " Новое ").ok).toBe(true);
    expect(s.actions()[0]?.text).toEqual(["Новое"]);
    const before = s.sent.length;
    expect(s.controller.editAction(id, "   ")).toEqual({ ok: false, reason: "invalid_intent" });
    expect(s.sent).toHaveLength(before);
    expect(s.actions()[0]?.text).toEqual(["Новое"]);
  });

  it("REQ-017 кр.2: конкурентная правка текста двумя акторами — оба варианта, conflict=true; editAction разрешает", () => {
    const remote = remoteAction("Исходное");
    const s = setup([{ seq: 1, delta: remote.wire }]);
    s.controller.editAction(remote.id, "B");
    deliver(
      s,
      2,
      chainY(remote.state, [(st, c) => setField(st, c, { entity: remote.id, field: "text" }, "C")]),
    );

    const a = s.actions()[0] as ActionView;
    expect(a.conflict).toBe(true);
    expect([...a.text].sort()).toEqual(["B", "C"]);

    s.controller.editAction(remote.id, "C");
    const resolved = s.actions()[0] as ActionView;
    expect(resolved.conflict).toBe(false);
    expect(resolved.text).toEqual(["C"]);
  });

  it("REQ-018 кр.1: assign назначает ответственного, assign(null) снимает", () => {
    const s = setup();
    s.controller.createAction("Дело");
    const id = (s.actions()[0] as ActionView).id;
    expect(s.controller.assign(id, GUEST_A).ok).toBe(true);
    expect(s.actions()[0]?.assignee).toBe(GUEST_A);
    expect(s.controller.assign(id, null).ok).toBe(true);
    expect(s.actions()[0]?.assignee).toBeNull();
  });

  it("REQ-018 кр.3: setDone отмечает выполненным и возвращает обратно", () => {
    const s = setup();
    s.controller.createAction("Дело");
    const id = (s.actions()[0] as ActionView).id;
    expect(s.controller.setDone(id, true).ok).toBe(true);
    expect(s.actions()[0]?.done).toBe(true);
    expect(s.controller.setDone(id, false).ok).toBe(true);
    expect(s.actions()[0]?.done).toBe(false);
  });

  it("REQ-018 кр.2: конкурентное назначение — побеждает большая метка (удалённая с большим lamport)", () => {
    const remote = remoteAction();
    const s = setup([{ seq: 1, delta: remote.wire }]);
    s.controller.assign(remote.id, GUEST_A);
    // Y делает три записи подряд: lamport третьей заведомо больше локального.
    deliver(
      s,
      2,
      chainY(remote.state, [
        (st, c) => setDone(st, c, remote.id, true),
        (st, c) => setDone(st, c, remote.id, false),
        (st, c) => assign(st, c, remote.id, GUEST_B),
      ]),
    );
    expect(s.actions()[0]?.assignee).toBe(GUEST_B);
  });

  it("REQ-018 кр.2: конкурентное назначение — локальное с большей меткой побеждает", () => {
    const remote = remoteAction();
    const s = setup([{ seq: 1, delta: remote.wire }]);
    // Локально несколько записей подряд, у удалённого — одна.
    s.controller.setDone(remote.id, true);
    s.controller.setDone(remote.id, false);
    s.controller.assign(remote.id, GUEST_A);
    deliver(s, 2, chainY(remote.state, [(st, c) => assign(st, c, remote.id, GUEST_B)]));
    expect(s.actions()[0]?.assignee).toBe(GUEST_A);
  });

  it("REQ-019 кр.1: remove убирает action item из view.actions", () => {
    const s = setup();
    s.controller.createAction("Первое");
    s.controller.createAction("Второе");
    const first = (s.actions()[0] as ActionView).id;
    expect(s.controller.remove(first).ok).toBe(true);
    expect(s.actions().map((a) => a.id)).not.toContain(first);
    expect(s.actions()).toHaveLength(1);
    expect(s.controller.store.getState().trash).toEqual([]);
  });
});
