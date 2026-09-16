// T-025 (docs/design/T-005-simulator.md § 3.4, docs/spec/simulator.md
// E9/M5, § 12 H1, docs/spec/protocol.md § 6): приёмочные тесты для
// `createBoardServer` соединённого с настоящим (пока не реализованным)
// `MemoryBoardStore` — полный жизненный цикл через реальный протокол
// (`hello`/`op`/`command`), не через прямые вызовы `store`, кроме мест,
// где напрямую проще и честнее проверить, что именно осталось в
// хранилище (`store.log`/`store.authors`/`store.currentState` — тоже
// обычный публичный порт, не внутренности).
//
// Ожидаемый результат ПРЯМО СЕЙЧАС: каждый `it` падает РОВНО на
// `createMemoryBoardStore()` с сообщением "createMemoryBoardStore: not
// implemented" — не из-за ошибки в построении сценария/сообщений.

import type { WireDelta } from "@retro/crdt";
import { activeVotes } from "@retro/crdt";
import type { Command, ServerMessage } from "@retro/protocol";
import { clientMessageSchema, PROTOCOL_VERSION, serverMessageSchema } from "@retro/protocol";
import type { Outgoing, ServerCorePorts } from "@retro/server-core";
import { createBoardServer, createMemoryBoardStore } from "@retro/server-core";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Идентификаторы — как в store-contract.ts: валидные UUID-строки (z.uuid()),
// разные для каждой роли/актора, чтобы сценарии было легко читать.

function uuid(tail: string): string {
  return `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
}

const BOARD_ID = uuid("b1");
const OWNER_ID = uuid("01");
const ACTOR_OWNER = uuid("02");
const GUEST_A = uuid("0a");
const ACTOR_A = uuid("0b");
const GUEST_B = uuid("0c");
const ACTOR_B = uuid("0d");

function voterToken(guestId: string): string {
  return `vt:${guestId}`;
}

function makePorts(store: ReturnType<typeof createMemoryBoardStore>): ServerCorePorts {
  return {
    store,
    voterToken: (_boardId: string, guestId: string) => voterToken(guestId),
  };
}

// ---------------------------------------------------------------------------
// Сообщения клиента — через честные zod-схемы @retro/protocol (тот же
// паттерн, что и board-server.test.ts: helloRaw/opRaw/commandRaw).

function helloRaw(actorId: string, guestId: string, lastSeq: number | null = null): string {
  const message = clientMessageSchema.parse({
    type: "hello",
    protocol: PROTOCOL_VERSION,
    guestId,
    displayName: "Guest",
    actorId,
    lastSeq,
  });
  return JSON.stringify(message);
}

/** Создание стикера — единственная операция под dot {actor, counter}. */
function createStickerRaw(actorId: string, counter = 1, text = "hello"): string {
  const dot = { actor: actorId, counter };
  const stamp = { lamport: counter, actor: actorId };
  const entityId = `${actorId}:${counter}`;
  const message = clientMessageSchema.parse({
    type: "op",
    delta: {
      created: [{ id: entityId, kind: "sticker" }],
      entries: [
        { key: { entity: entityId, field: "text" }, dot, stamp, value: text },
        { key: { entity: entityId, field: "color" }, dot, stamp, value: "yellow" },
        {
          key: { entity: entityId, field: "place" },
          dot,
          stamp,
          value: { column: "start", frac: "m" },
        },
        { key: { entity: entityId, field: "group" }, dot, stamp, value: null },
        { key: { entity: entityId, field: "deleted" }, dot, stamp, value: false },
      ],
      supersedes: [],
      votes: [],
      unvotes: [],
    },
  });
  return JSON.stringify(message);
}

/** Правка текста уже созданного стикера — перекрывает его запись, созданную dot {actor, counter: 1}. */
function editTextRaw(
  actorId: string,
  entityId: string,
  counter: number,
  lamport: number,
  text: string,
): string {
  const dot = { actor: actorId, counter };
  const stamp = { lamport, actor: actorId };
  const [createActor, createCounterRaw] = entityId.split(":");
  if (createActor === undefined || createCounterRaw === undefined) {
    throw new Error(`editTextRaw: malformed entityId ${entityId}`);
  }
  const message = clientMessageSchema.parse({
    type: "op",
    delta: {
      created: [],
      entries: [{ key: { entity: entityId, field: "text" }, dot, stamp, value: text }],
      supersedes: [
        {
          key: { entity: entityId, field: "text" },
          dot: { actor: createActor, counter: Number(createCounterRaw) },
        },
      ],
      votes: [],
      unvotes: [],
    },
  });
  return JSON.stringify(message);
}

function voteRaw(actorId: string, counter: number, guestId: string, target: string): string {
  const dot = { actor: actorId, counter };
  const message = clientMessageSchema.parse({
    type: "op",
    delta: {
      created: [],
      entries: [],
      supersedes: [],
      votes: [{ dot, user: voterToken(guestId), target }],
      unvotes: [],
    },
  });
  return JSON.stringify(message);
}

function commandRaw(id: string, command: Command): string {
  const message = clientMessageSchema.parse({ type: "command", id, command });
  return JSON.stringify(message);
}

// ---------------------------------------------------------------------------
// Разбор исходящих сообщений — те же честные zod-схемы, что и на входе.

interface ParsedOutgoing {
  readonly to: string;
  readonly message: ServerMessage;
}

function parseOutgoing(outgoing: readonly Outgoing[]): ParsedOutgoing[] {
  return outgoing.map((entry) => ({
    to: entry.to,
    message: serverMessageSchema.parse(JSON.parse(entry.raw)),
  }));
}

function hasEntity(delta: WireDelta, entityId: string): boolean {
  return (
    delta.created.some((created) => created.id === entityId) ||
    delta.entries.some((entry) => entry.key.entity === entityId)
  );
}

/** Множество id сущностей, видимых клиенту в его `welcome` (снапшот + хвост). */
function welcomeEntities(message: ServerMessage): Set<string> {
  const ids = new Set<string>();
  if (message.type !== "welcome") return ids;
  if (message.snapshot) {
    for (const created of message.snapshot.state.created) ids.add(created.id);
    for (const entry of message.snapshot.state.entries) ids.add(entry.key.entity);
  }
  for (const row of message.ops) {
    for (const created of row.delta.created) ids.add(created.id);
    for (const entry of row.delta.entries) ids.add(entry.key.entity);
  }
  return ids;
}

// ---------------------------------------------------------------------------

describe("T-025: createBoardServer на настоящем MemoryBoardStore", () => {
  it("T-025 E9: сбойная транзакция при создании стикера — error и закрытие соединения, ничего не осталось в store", async () => {
    const store = createMemoryBoardStore();
    store.createBoard({
      id: BOARD_ID,
      title: "Retro",
      ownerId: OWNER_ID,
      ownerName: "Owner",
      voteLimit: 3,
    });
    store.addMember(BOARD_ID, GUEST_A, "participant", "Alice");
    const server = createBoardServer(makePorts(store));

    const conn = "conn-1";
    server.open(conn, BOARD_ID);
    await server.receive(conn, helloRaw(ACTOR_A, GUEST_A));

    store.failNextTransaction(0);
    const result = await server.receive(conn, createStickerRaw(ACTOR_A));

    expect(result.close).toContain(conn);
    const messages = parseOutgoing(result.outgoing);
    expect(messages.some((entry) => entry.message.type === "error")).toBe(true);

    expect(store.log(BOARD_ID)).toHaveLength(0);
    expect((await store.authors(BOARD_ID)).size).toBe(0);
  });

  it(
    "T-025 M5: повтор той же дельты после переподключения получает ack, не forbidden — " +
      "сущность реально создана ровно один раз (не в сбойной попытке)",
    async () => {
      const store = createMemoryBoardStore();
      store.createBoard({
        id: BOARD_ID,
        title: "Retro",
        ownerId: OWNER_ID,
        ownerName: "Owner",
        voteLimit: 3,
      });
      store.addMember(BOARD_ID, GUEST_A, "participant", "Alice");
      const server = createBoardServer(makePorts(store));

      const conn1 = "conn-1";
      server.open(conn1, BOARD_ID);
      await server.receive(conn1, helloRaw(ACTOR_A, GUEST_A));

      store.failNextTransaction(0);
      const failedResult = await server.receive(conn1, createStickerRaw(ACTOR_A));
      // Соединение реально закрывается после сбойной попытки (как в реальном
      // gateway): дальше работаем через новое соединение, как настоящий клиент.
      await server.close(conn1);
      expect(failedResult.close).toContain(conn1);

      const conn2 = "conn-2";
      server.open(conn2, BOARD_ID);
      await server.receive(conn2, helloRaw(ACTOR_A, GUEST_A));

      const retryResult = await server.receive(conn2, createStickerRaw(ACTOR_A));
      const retryMessages = parseOutgoing(retryResult.outgoing);
      const ack = retryMessages.find((entry) => entry.to === conn2 && entry.message.type === "ack");
      expect(ack).toBeDefined();
      expect(retryMessages.some((entry) => entry.message.type === "reject")).toBe(false);

      const entityId = `${ACTOR_A}:1`;
      const editResult = await server.receive(
        conn2,
        editTextRaw(ACTOR_A, entityId, 2, 2, "edited"),
      );
      const editMessages = parseOutgoing(editResult.outgoing);
      const editRejected = editMessages.some(
        (entry) =>
          entry.to === conn2 && (entry.message.type === "reject" || entry.message.type === "error"),
      );
      expect(editRejected).toBe(false);
      expect(editMessages.some((entry) => entry.to === conn2 && entry.message.type === "ack")).toBe(
        true,
      );
    },
  );

  it("T-025 E9: сбойная транзакция resetVotes не оставляет доску наполовину сброшенной", async () => {
    const store = createMemoryBoardStore();
    store.createBoard({
      id: BOARD_ID,
      title: "Retro",
      ownerId: OWNER_ID,
      ownerName: "Owner",
      voteLimit: 3,
    });
    store.addMember(BOARD_ID, GUEST_A, "participant", "Alice");
    store.addMember(BOARD_ID, GUEST_B, "participant", "Bob");
    const server = createBoardServer(makePorts(store));

    const connOwner = "conn-owner";
    server.open(connOwner, BOARD_ID);
    await server.receive(connOwner, helloRaw(ACTOR_OWNER, OWNER_ID));
    await server.receive(connOwner, createStickerRaw(ACTOR_OWNER));
    const target = `${ACTOR_OWNER}:1`;

    // Первый уход из collect — reveal, разрешено в любую из четырёх фаз.
    await server.receive(connOwner, commandRaw("cmd-phase", { type: "setPhase", phase: "vote" }));

    const connA = "conn-a";
    server.open(connA, BOARD_ID);
    await server.receive(connA, helloRaw(ACTOR_A, GUEST_A));
    const connB = "conn-b";
    server.open(connB, BOARD_ID);
    await server.receive(connB, helloRaw(ACTOR_B, GUEST_B));

    const voteAResult = await server.receive(connA, voteRaw(ACTOR_A, 1, GUEST_A, target));
    const voteBResult = await server.receive(connB, voteRaw(ACTOR_B, 1, GUEST_B, target));
    expect(parseOutgoing(voteAResult.outgoing).some((e) => e.message.type === "ack")).toBe(true);
    expect(parseOutgoing(voteBResult.outgoing).some((e) => e.message.type === "ack")).toBe(true);

    const before = await store.currentState(BOARD_ID);
    expect(activeVotes(before.state, target)).toHaveLength(2);

    store.failNextTransaction(0);
    const resetResult = await server.receive(
      connOwner,
      commandRaw("cmd-reset", { type: "resetVotes" }),
    );

    const resetMessages = parseOutgoing(resetResult.outgoing);
    const failedAsExpected = resetMessages.some((entry) => {
      if (entry.message.type === "error") return true;
      if (entry.message.type === "commandResult") {
        return entry.message.id === "cmd-reset" && entry.message.ok === false;
      }
      return false;
    });
    expect(failedAsExpected).toBe(true);

    const after = await store.currentState(BOARD_ID);
    expect(activeVotes(after.state, target)).toHaveLength(2);
  });

  it("T-025 T-013: reveal-рассылка делает ранее скрытый стикер видимым другому участнику", async () => {
    const store = createMemoryBoardStore();
    store.createBoard({
      id: BOARD_ID,
      title: "Retro",
      ownerId: OWNER_ID,
      ownerName: "Owner",
      voteLimit: 3,
    });
    store.addMember(BOARD_ID, GUEST_A, "participant", "Alice");
    store.addMember(BOARD_ID, GUEST_B, "participant", "Bob");
    const server = createBoardServer(makePorts(store));

    const connA = "conn-a";
    server.open(connA, BOARD_ID);
    await server.receive(connA, helloRaw(ACTOR_A, GUEST_A));
    await server.receive(connA, createStickerRaw(ACTOR_A));
    const stickerId = `${ACTOR_A}:1`;

    const connB = "conn-b";
    server.open(connB, BOARD_ID);
    const welcomeBResult = await server.receive(connB, helloRaw(ACTOR_B, GUEST_B));
    const welcomeB = parseOutgoing(welcomeBResult.outgoing).find(
      (entry) => entry.message.type === "welcome",
    );
    if (welcomeB === undefined) throw new Error("expected a welcome message for B");
    // REQ-006: до reveal участник B не видит чужой стикер вовсе.
    expect(welcomeEntities(welcomeB.message).has(stickerId)).toBe(false);

    const connOwner = "conn-owner";
    server.open(connOwner, BOARD_ID);
    await server.receive(connOwner, helloRaw(ACTOR_OWNER, OWNER_ID));
    const revealResult = await server.receive(
      connOwner,
      commandRaw("cmd-reveal", { type: "setPhase", phase: "group" }),
    );

    const toB = parseOutgoing(revealResult.outgoing).filter((entry) => entry.to === connB);
    const sawSticker = toB.some((entry) => {
      if (entry.message.type === "op") return hasEntity(entry.message.delta, stickerId);
      if (entry.message.type === "meta") return entry.message.meta.authors[stickerId] !== undefined;
      return false;
    });
    expect(sawSticker).toBe(true);
  });

  it(
    "T-025 H1: переподключение после reveal с уже продвинутым lastSeq " +
      "не теряет ранее скрытый стикер (досылка через welcome/catchup)",
    async () => {
      const store = createMemoryBoardStore();
      store.createBoard({
        id: BOARD_ID,
        title: "Retro",
        ownerId: OWNER_ID,
        ownerName: "Owner",
        voteLimit: 3,
      });
      store.addMember(BOARD_ID, GUEST_A, "participant", "Alice");
      store.addMember(BOARD_ID, GUEST_B, "participant", "Bob");
      const server = createBoardServer(makePorts(store));

      const connA = "conn-a";
      server.open(connA, BOARD_ID);
      await server.receive(connA, helloRaw(ACTOR_A, GUEST_A));
      await server.receive(connA, createStickerRaw(ACTOR_A));
      const stickerId = `${ACTOR_A}:1`;

      // B подключён ДО reveal, создаёт свой собственный (видимый себе)
      // стикер — его lastSeq продвигается за счёт собственного ack,
      // не за счёт чужой видимой операции.
      const connB1 = "conn-b1";
      server.open(connB1, BOARD_ID);
      await server.receive(connB1, helloRaw(ACTOR_B, GUEST_B));
      const ownStickerResult = await server.receive(connB1, createStickerRaw(ACTOR_B));
      const ackEntry = parseOutgoing(ownStickerResult.outgoing).find(
        (entry) => entry.to === connB1 && entry.message.type === "ack",
      );
      if (ackEntry === undefined || ackEntry.message.type !== "ack") {
        throw new Error("expected B's own sticker to be ack'd");
      }
      const lastSeqB = ackEntry.message.seq;

      // B отключается ДО reveal — не застаёт живую рассылку reveal.
      await server.close(connB1);

      const connOwner = "conn-owner";
      server.open(connOwner, BOARD_ID);
      await server.receive(connOwner, helloRaw(ACTOR_OWNER, OWNER_ID));
      await server.receive(
        connOwner,
        commandRaw("cmd-reveal", { type: "setPhase", phase: "group" }),
      );

      // B переподключается со своим старым (уже продвинутым до reveal) lastSeq.
      const connB2 = "conn-b2";
      server.open(connB2, BOARD_ID);
      const welcomeB2Result = await server.receive(connB2, helloRaw(ACTOR_B, GUEST_B, lastSeqB));
      const welcomeB2 = parseOutgoing(welcomeB2Result.outgoing).find(
        (entry) => entry.message.type === "welcome",
      );
      if (welcomeB2 === undefined)
        throw new Error("expected a welcome message for B's reconnection");

      expect(welcomeEntities(welcomeB2.message).has(stickerId)).toBe(true);
    },
  );
});
