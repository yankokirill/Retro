// T-019 (docs/design/T-019-action-items.md § 1): права на action items при приёме
// операций через createBoardServer + MemoryBoardStore. REQ-017 (кр. 1-2), REQ-018, REQ-019 (кр. 1).

import type { Clock, EntityId, OpResult, State } from "@retro/crdt";
import {
  assign,
  createAction,
  deleteEntity,
  dotKey,
  empty,
  merge,
  newClock,
  setDone,
  setField,
  toWire,
} from "@retro/crdt";
import type { Command, Phase, ServerMessage } from "@retro/protocol";
import { clientMessageSchema, PROTOCOL_VERSION, serverMessageSchema } from "@retro/protocol";
import type { Outgoing } from "@retro/server-core";
import { createBoardServer, createMemoryBoardStore } from "@retro/server-core";
import { describe, expect, it } from "vitest";

function uuid(tail: string): string {
  return `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
}

const BOARD_ID = uuid("b1");
const OWNER_ID = uuid("01");
const ACTOR_OWNER = uuid("02");
const GUEST_P = uuid("0a");
const ACTOR_P = uuid("0b");
const GUEST_V = uuid("0c");
const ACTOR_V = uuid("0d");

function hello(actorId: string, guestId: string): string {
  return JSON.stringify(
    clientMessageSchema.parse({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      guestId,
      displayName: "Guest",
      actorId,
      lastSeq: null,
    }),
  );
}

function command(id: string, cmd: Command): string {
  return JSON.stringify(clientMessageSchema.parse({ type: "command", id, command: cmd }));
}

function verdict(outgoing: readonly Outgoing[], to: string): string {
  for (const entry of outgoing.filter((e) => e.to === to)) {
    const message: ServerMessage = serverMessageSchema.parse(JSON.parse(entry.raw));
    if (message.type === "ack") return "ack";
    if (message.type === "reject") return `reject:${message.reason}`;
  }
  return "none";
}

async function setup(phase: Phase) {
  const store = createMemoryBoardStore();
  store.createBoard({
    id: BOARD_ID,
    title: "Retro",
    ownerId: OWNER_ID,
    ownerName: "Owner",
    voteLimit: 3,
  });
  store.addMember(BOARD_ID, GUEST_P, "participant", "Alice");
  store.addMember(BOARD_ID, GUEST_V, "viewer", "Vera");
  const server = createBoardServer({
    store,
    voterToken: (_b: string, guestId: string) => `vt:${guestId}`,
  });
  server.open("owner", BOARD_ID);
  await server.receive("owner", hello(ACTOR_OWNER, OWNER_ID));
  server.open("p", BOARD_ID);
  await server.receive("p", hello(ACTOR_P, GUEST_P));
  server.open("v", BOARD_ID);
  await server.receive("v", hello(ACTOR_V, GUEST_V));
  const path: Phase[] = ["group", "vote", "discuss", "actions"];
  if (phase !== "collect") {
    for (const next of path.slice(0, path.indexOf(phase) + 1)) {
      await server.receive("owner", command(`ph-${next}`, { type: "setPhase", phase: next }));
    }
  }
  return { server };
}

const wire = (delta: Parameters<typeof toWire>[0]) =>
  JSON.stringify(clientMessageSchema.parse({ type: "op", delta: toWire(delta) }));

type Maker = (state: State, clock: Clock) => OpResult;

/** Последовательно шлёт правки от одного актора, протаскивая его часы и состояние; возвращает вердикты. */
async function sendChain(
  server: Awaited<ReturnType<typeof setup>>["server"],
  conn: string,
  actor: string,
  base: State,
  makers: readonly Maker[],
): Promise<string[]> {
  let clock = newClock(actor);
  let state = base;
  const verdicts: string[] = [];
  for (const make of makers) {
    const op = make(state, clock);
    clock = op.clock;
    state = merge(state, op.delta as State);
    verdicts.push(verdict((await server.receive(conn, wire(op.delta))).outgoing, conn));
  }
  return verdicts;
}

const editMakers = (id: EntityId, guest: string): Maker[] => [
  (s, c) => setField(s, c, { entity: id, field: "text" }, "Иначе"),
  (s, c) => assign(s, c, id, guest),
  (s, c) => setDone(s, c, id, true),
  (s, c) => deleteEntity(s, c, id),
];

/** Владелец создаёт action item (в любой фазе), возвращает состояние и id. */
async function ownerCreates(server: Awaited<ReturnType<typeof setup>>["server"]) {
  const created = createAction(empty(), newClock(ACTOR_OWNER), { text: "Сделать" });
  const res = await server.receive("owner", wire(created.delta));
  expect(verdict(res.outgoing, "owner")).toBe("ack");
  return {
    state: created.delta as State,
    clock: created.clock,
    id: dotKey(created.dot) as EntityId,
  };
}

describe("REQ-017/REQ-018/REQ-019: права на action items (T-019)", () => {
  it.each<Phase>(["discuss", "actions"])(
    "REQ-017 кр.1: participant в фазе %s создаёт action item — ack",
    async (phase) => {
      const { server } = await setup(phase);
      const created = createAction(empty(), newClock(ACTOR_P), { text: "Сделать" });
      expect(verdict((await server.receive("p", wire(created.delta))).outgoing, "p")).toBe("ack");
    },
  );

  it.each<Phase>(["discuss", "actions"])(
    "REQ-017 кр.2/REQ-018/REQ-019 кр.1: participant в фазе %s редактирует, назначает, отмечает и удаляет — ack",
    async (phase) => {
      const { server } = await setup(phase);
      const item = await ownerCreates(server);
      const verdicts = await sendChain(
        server,
        "p",
        ACTOR_P,
        item.state,
        editMakers(item.id, GUEST_P),
      );
      expect(verdicts).toEqual(["ack", "ack", "ack", "ack"]);
    },
  );

  it.each<Phase>(["group", "vote"])(
    "REQ-017: participant в фазе %s не создаёт action item — reject wrong_phase",
    async (phase) => {
      const { server } = await setup(phase);
      const created = createAction(empty(), newClock(ACTOR_P), { text: "Сделать" });
      const res = await server.receive("p", wire(created.delta));
      expect(verdict(res.outgoing, "p")).toBe("reject:wrong_phase");
    },
  );

  it.each<Phase>(["group", "vote"])(
    "REQ-017/REQ-018/REQ-019: participant в фазе %s не правит, не назначает, не отмечает и не удаляет — reject wrong_phase",
    async (phase) => {
      const { server } = await setup(phase);
      const item = await ownerCreates(server);
      const makers = editMakers(item.id, GUEST_P).map(
        (make): Maker =>
          (_s, c) =>
            // состояние не растёт: каждое отклонение независимо
            make(item.state, c),
      );
      const verdicts = await sendChain(server, "p", ACTOR_P, item.state, makers);
      expect(verdicts).toEqual(Array(4).fill("reject:wrong_phase"));
    },
  );

  it.each<Phase>(["collect", "group", "vote", "discuss", "actions"])(
    "REQ-017/REQ-018/REQ-019: viewer в фазе %s не создаёт и не меняет action item — reject forbidden",
    async (phase) => {
      const { server } = await setup(phase);
      const item = await ownerCreates(server);
      const makers: Maker[] = [
        (_s, c) => createAction(empty(), c, { text: "Сделать" }),
        ...editMakers(item.id, GUEST_V).map(
          (make): Maker =>
            (_s, c) =>
              make(item.state, c),
        ),
      ];
      const verdicts = await sendChain(server, "v", ACTOR_V, empty(), makers);
      expect(verdicts).toEqual(Array(5).fill("reject:forbidden"));
    },
  );

  it.each<Phase>(["collect", "group", "vote", "discuss", "actions"])(
    "REQ-017/REQ-018/REQ-019: owner в фазе %s создаёт, правит, назначает, отмечает и удаляет — ack",
    async (phase) => {
      const { server } = await setup(phase);
      const created = createAction(empty(), newClock(ACTOR_OWNER), { text: "Сделать" });
      expect(verdict((await server.receive("owner", wire(created.delta))).outgoing, "owner")).toBe(
        "ack",
      );
      const id = dotKey(created.dot) as EntityId;
      // продолжаем часы владельца после createAction
      let clock = created.clock;
      let state = created.delta as State;
      for (const make of editMakers(id, GUEST_P)) {
        const op = make(state, clock);
        clock = op.clock;
        state = merge(state, op.delta as State);
        const res = await server.receive("owner", wire(op.delta));
        expect(verdict(res.outgoing, "owner")).toBe("ack");
      }
    },
  );
});
