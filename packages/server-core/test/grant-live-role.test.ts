// REQ-003 кр. 2 (T-030), находка e2e T-022: роль подписчика кэшировалась на время соединения
// (`Subscriber.role` из `hello`), поэтому назначенный «на лету» фасилитатор продолжал получать
// `forbidden`/`wrong_phase` на правки, пока не переподключится — хотя клиенту `meta.role` уже
// показал новые права.

import { createAction, empty, newClock, toWire } from "@retro/crdt";
import type { Command, ServerMessage } from "@retro/protocol";
import { clientMessageSchema, PROTOCOL_VERSION, serverMessageSchema } from "@retro/protocol";
import type { Outgoing } from "@retro/server-core";
import { createBoardServer, createMemoryBoardStore } from "@retro/server-core";
import { describe, expect, it } from "vitest";

const uuid = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
const BOARD_ID = uuid("b1");
const OWNER = uuid("01");
const ACTOR_OWNER = uuid("02");
const GUEST_P = uuid("0a");
const ACTOR_P = uuid("0b");

const hello = (actorId: string, guestId: string) =>
  JSON.stringify(
    clientMessageSchema.parse({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      guestId,
      displayName: "Guest",
      actorId,
      lastSeq: null,
    }),
  );
const command = (id: string, cmd: Command) =>
  JSON.stringify(clientMessageSchema.parse({ type: "command", id, command: cmd }));

function verdict(outgoing: readonly Outgoing[], to: string): string {
  for (const entry of outgoing.filter((e) => e.to === to)) {
    const message: ServerMessage = serverMessageSchema.parse(JSON.parse(entry.raw));
    if (message.type === "ack") return "ack";
    if (message.type === "reject") return `reject:${message.reason}`;
  }
  return "none";
}

describe("REQ-003: роль, выданная grantFacilitator, действует на уже открытом соединении", () => {
  it("REQ-003: участник получает wrong_phase, после grantFacilitator тот же сокет — ack", async () => {
    const store = createMemoryBoardStore();
    store.createBoard({
      id: BOARD_ID,
      title: "Retro",
      ownerId: OWNER,
      ownerName: "Owner",
      voteLimit: 3,
    });
    store.addMember(BOARD_ID, GUEST_P, "participant", "Alice");
    const server = createBoardServer({ store, voterToken: (_b: string, g: string) => `vt:${g}` });
    server.open("owner", BOARD_ID);
    await server.receive("owner", hello(ACTOR_OWNER, OWNER));
    server.open("p", BOARD_ID);
    await server.receive("p", hello(ACTOR_P, GUEST_P));
    await server.receive("owner", command("ph", { type: "setPhase", phase: "group" }));

    // Фаза group: participant не может создавать action item (только discuss/actions).
    const first = createAction(empty(), newClock(ACTOR_P), { text: "Один" });
    const before = await server.receive(
      "p",
      JSON.stringify({ type: "op", delta: toWire(first.delta) }),
    );
    expect(verdict(before.outgoing, "p")).toBe("reject:wrong_phase");

    await server.receive("owner", command("g", { type: "grantFacilitator", guestId: GUEST_P }));

    const second = createAction(empty(), first.clock, { text: "Два" });
    const after = await server.receive(
      "p",
      JSON.stringify({ type: "op", delta: toWire(second.delta) }),
    );
    expect(verdict(after.outgoing, "p")).toBe("ack");
  });
});
