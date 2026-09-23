// T-016 (docs/design/T-016-groups.md § 1): права на создание/переименование
// группы при приёме операций через createBoardServer + MemoryBoardStore.

import type { EntityId, State } from "@retro/crdt";
import { createGroup, dotKey, empty, newClock, setField, toWire } from "@retro/crdt";
import type { Command, ServerMessage } from "@retro/protocol";
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

function types(outgoing: readonly Outgoing[], to: string): ServerMessage[] {
  return outgoing
    .filter((entry) => entry.to === to)
    .map((entry) => serverMessageSchema.parse(JSON.parse(entry.raw)));
}

function verdict(outgoing: readonly Outgoing[], to: string): string {
  for (const message of types(outgoing, to)) {
    if (message.type === "ack") return "ack";
    if (message.type === "reject") return `reject:${message.reason}`;
  }
  return "none";
}

async function setup(phase: "collect" | "group") {
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
  if (phase === "group") {
    await server.receive("owner", command("ph", { type: "setPhase", phase: "group" }));
  }
  return { server };
}

function createGroupMsg(actor: string) {
  const created = createGroup(empty(), newClock(actor), {
    column: "start",
    frac: "m",
    title: "Group",
  });
  const raw = JSON.stringify(
    clientMessageSchema.parse({ type: "op", delta: toWire(created.delta) }),
  );
  return { raw, created, groupId: dotKey(created.dot) as EntityId };
}

function renameMsg(actor: string, created: ReturnType<typeof createGroupMsg>["created"]) {
  // Часы принадлежат тому, кто переименовывает: его dot = (actor, 1) или следующий.
  const clock = actor === created.dot.actor ? created.clock : newClock(actor);
  const edit = setField(
    created.delta as State,
    clock,
    { entity: dotKey(created.dot) as EntityId, field: "title" },
    "Renamed",
  );
  return JSON.stringify(clientMessageSchema.parse({ type: "op", delta: toWire(edit.delta) }));
}

describe("REQ-012: права на создание и переименование группы (T-016)", () => {
  it("REQ-012: participant в фазе group создаёт и переименовывает группу — ack", async () => {
    const { server } = await setup("group");
    const g = createGroupMsg(ACTOR_P);
    const first = await server.receive("p", g.raw);
    expect(verdict(first.outgoing, "p")).toBe("ack");
    const second = await server.receive("p", renameMsg(ACTOR_P, g.created));
    expect(verdict(second.outgoing, "p")).toBe("ack");
  });

  it("REQ-012: participant в фазе collect не создаёт группу — reject wrong_phase", async () => {
    const { server } = await setup("collect");
    const result = await server.receive("p", createGroupMsg(ACTOR_P).raw);
    expect(verdict(result.outgoing, "p")).toBe("reject:wrong_phase");
  });

  it("REQ-012: participant в collect не переименовывает существующую группу — reject wrong_phase", async () => {
    const { server } = await setup("collect");
    const g = createGroupMsg(ACTOR_OWNER);
    expect(verdict((await server.receive("owner", g.raw)).outgoing, "owner")).toBe("ack");
    const result = await server.receive("p", renameMsg(ACTOR_P, g.created));
    expect(verdict(result.outgoing, "p")).toBe("reject:wrong_phase");
  });

  it.each<"collect" | "group">(["collect", "group"])(
    "REQ-012: viewer в фазе %s не создаёт группу — reject forbidden",
    async (phase) => {
      const { server } = await setup(phase);
      const result = await server.receive("v", createGroupMsg(ACTOR_V).raw);
      expect(verdict(result.outgoing, "v")).toBe("reject:forbidden");
    },
  );

  it("REQ-013: viewer не переименовывает группу — reject forbidden", async () => {
    const { server } = await setup("group");
    const g = createGroupMsg(ACTOR_OWNER);
    await server.receive("owner", g.raw);
    const result = await server.receive("v", renameMsg(ACTOR_V, g.created));
    expect(verdict(result.outgoing, "v")).toBe("reject:forbidden");
  });

  it.each<"collect" | "group">(["collect", "group"])(
    "REQ-012: owner в фазе %s создаёт и переименовывает группу — ack",
    async (phase) => {
      const { server } = await setup(phase);
      const g = createGroupMsg(ACTOR_OWNER);
      expect(verdict((await server.receive("owner", g.raw)).outgoing, "owner")).toBe("ack");
      const rename = await server.receive("owner", renameMsg(ACTOR_OWNER, g.created));
      expect(verdict(rename.outgoing, "owner")).toBe("ack");
    },
  );
});
