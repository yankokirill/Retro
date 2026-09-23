// SIM-08 — проверки S2–S11 (`packages/sim/src/checks.ts`), docs/spec/simulator.md
// § 8 (таблица свойств), § 13 ВС-6/ВС-7 (перепроверка 2026-09-16).
//
// Мир строится из настоящих компонент — `@retro/server-core` (createBoardServer,
// createMemoryBoardStore), `@retro/client-core` (createSyncClient) — и
// проводится через реальный протокол (`@retro/protocol` схемы), как в
// `packages/server-core/test/board-server.memory.test.ts`. Там, где нужно
// намеренно нарушить свойство (S2, S6 и т.п.), делается это через легитимные
// публичные порты (`store.transaction`, форджинг ответа сервера клиенту
// «как будто» сеть подменила сообщение — ровно то, что делают мутанты M1–M7,
// § 10.2 simulator.md), а не через внутренние структуры.
//
// Ожидаемый результат ПРЯМО СЕЙЧАС: все функции `checks.ts` (S2–S11) —
// заглушки, бросающие `Error("...: not implemented")`. Каждый `it` падает на
// этом вызове.
//
// Находка контракта (см. отчёт агента): `checkVoteLimit`/`checkAck`/
// `checkClientsMatchOracle`/… объявлены СИНХРОННЫМИ (`Violation | null`, не
// `Promise`), но единственный источник `voteLimit` — `BoardStore.board()`,
// который асинхронный. Тесты ниже кладут `voteLimit` в `store.createBoard`,
// как и должно быть у настоящей доски; как именно синхронная функция его
// прочитает — решение реализации, не тестов.

import type { Intent } from "@retro/client-core";
import { createMemoryOutboxStore, createSyncClient } from "@retro/client-core";
import type { Dot, State, WireDelta } from "@retro/crdt";
import {
  compact,
  createSticker,
  empty,
  equals,
  materialize,
  merge,
  newClock,
  toWire,
  vote,
} from "@retro/crdt";
import type { Command, RejectReason } from "@retro/protocol";
import { clientMessageSchema, serverMessageSchema } from "@retro/protocol";
import type { BoardServer, MemoryBoardStore, Outgoing } from "@retro/server-core";
import { createBoardServer, createMemoryBoardStore } from "@retro/server-core";
import { describe, expect, it } from "vitest";
import {
  type AckObservation,
  checkAck,
  checkAckedOpsPersist,
  checkClientsMatchOracle,
  checkMessageSchema,
  checkNoAuthorLeak,
  checkNoRejectedResidue,
  checkReject,
  checkScreensAgree,
  checkSnapshotConsistency,
  checkVoteLimit,
  type ErrorObservation,
  type OutgoingObservation,
  type RejectObservation,
  type SnapshotObservation,
} from "../src/checks.js";
import { buildConfig } from "../src/config.js";
import { createOracleState, foldLog } from "../src/oracle.js";
import { createStats } from "../src/stats.js";
import type { World } from "../src/world.js";

// ---------------------------------------------------------------------------
// Идентификаторы — как в board-server.memory.test.ts: валидные UUID-строки
// (dotSchema.actor = z.uuid()), разные для каждой роли/актора.

function uuid(tail: string): string {
  return `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
}

const BOARD_ID = uuid("b1");
const OWNER_ID = uuid("01");
const ACTOR_OWNER = uuid("02");
const GUEST_B = uuid("0b");
const ACTOR_B = uuid("0c");

function voterTokenOf(guestId: string): string {
  return `vt:${guestId}`;
}

function makeStoreWithBoard(voteLimit = 3): MemoryBoardStore {
  const store = createMemoryBoardStore();
  store.createBoard({
    id: BOARD_ID,
    title: "Retro",
    ownerId: OWNER_ID,
    ownerName: "Owner",
    voteLimit,
  });
  return store;
}

function makeServer(store: MemoryBoardStore): BoardServer {
  return createBoardServer({ store, voterToken: (_b: string, g: string) => voterTokenOf(g) });
}

/** Минимальный, но честный `World`: реальные store/server, всё остальное — нейтральные значения по умолчанию. */
function baseWorld(
  store: MemoryBoardStore,
  server: BoardServer,
  overrides: Partial<World> = {},
): World {
  const configResult = buildConfig({ seed: 1, clients: 2, ops: 10 });
  if (!configResult.ok) throw new Error(`baseWorld: buildConfig failed: ${configResult.error}`);
  return {
    config: configResult.config,
    boardId: BOARD_ID,
    guests: [],
    clients: [],
    connections: [],
    store,
    server,
    acts: 0,
    recent: [],
    stats: createStats(),
    oracle: createOracleState(),
    // world.ts § шаг 4б: поля добавлены при реализации apply.ts (накопление
    // наблюдений между E8/E9 и следующей контрольной точкой) — checks.ts их
    // не читает сам (S8 берёт snapshots явным параметром), нейтральные
    // значения по умолчанию здесь ничего не меняют в тестах S2–S11.
    snapshotsObserved: [],
    pendingStoreFault: false,
    ...overrides,
  };
}

function oracleFromStore(store: MemoryBoardStore) {
  const rows = store.log(BOARD_ID);
  const last = rows[rows.length - 1];
  return {
    x: foldLog(rows),
    lastFoldedSeq: last ? last.seq : 0,
    stickerAuthor: new Map<string, string>(),
  };
}

async function appendDirect(
  store: MemoryBoardStore,
  dot: Dot | null,
  lamport: number | null,
  delta: WireDelta,
): Promise<void> {
  await store.transaction(async (tx) => {
    await tx.appendOp({ boardId: BOARD_ID, dot, lamport, delta });
  });
}

// ---------------------------------------------------------------------------
// Мини-сеть между реальными SyncClient и реальным BoardServer — тот же
// протокол, что моделирует § 4 simulator.md, но без потерь/перестановок (это
// не предмет данных тестов): каждое сообщение доставляется немедленно всем
// адресатам, рекурсивно (ответы клиента тоже доставляются).

interface Peer {
  readonly connId: string;
  readonly guestId: string;
  readonly client: ReturnType<typeof createSyncClient>;
  readonly outbox: ReturnType<typeof createMemoryOutboxStore>;
}

function makePeer(connId: string, guestId: string, actorId: string, displayName: string): Peer {
  const outbox = createMemoryOutboxStore();
  const client = createSyncClient(
    { boardId: BOARD_ID, guestId, displayName },
    { newActorId: () => actorId, newCommandId: () => `cmd-${actorId}`, outbox },
  );
  return { connId, guestId, client, outbox };
}

async function deliverAll(
  server: BoardServer,
  peers: readonly Peer[],
  outgoing: readonly Outgoing[],
): Promise<void> {
  for (const out of outgoing) {
    const peer = peers.find((p) => p.connId === out.to);
    if (!peer) continue;
    const replies = peer.client.receive(out.raw);
    for (const raw of replies) {
      const res = await server.receive(peer.connId, raw);
      await deliverAll(server, peers, res.outgoing);
    }
  }
}

async function connectPeer(server: BoardServer, peers: readonly Peer[], peer: Peer): Promise<void> {
  server.open(peer.connId, BOARD_ID);
  const [hello] = peer.client.connected();
  if (!hello) throw new Error("connectPeer: connected() did not return hello");
  const res = await server.receive(peer.connId, hello);
  await deliverAll(server, peers, res.outgoing);
}

async function act(
  server: BoardServer,
  peers: readonly Peer[],
  actor: Peer,
  intent: Intent,
): Promise<void> {
  const result = actor.client.act(intent);
  if (!result.ok) throw new Error(`act failed: ${result.reason}`);
  for (const raw of result.send) {
    const res = await server.receive(actor.connId, raw);
    await deliverAll(server, peers, res.outgoing);
  }
}

async function sendCommand(
  server: BoardServer,
  peers: readonly Peer[],
  actor: Peer,
  cmd: Command,
): Promise<void> {
  const [raw] = actor.client.command(cmd);
  if (!raw) return;
  const res = await server.receive(actor.connId, raw);
  await deliverAll(server, peers, res.outgoing);
}

function clientStateOf(peer: Peer, guestIndex: number) {
  return { guestIndex, core: peer.client, outbox: peer.outbox, connection: null as number | null };
}

// ---------------------------------------------------------------------------
// S2 — checkVoteLimit: I6, activeVotes(X_S) сгруппировано по voterToken ≤ voteLimit.
// ---------------------------------------------------------------------------

describe("SIM-08 / S2: checkVoteLimit — I6", () => {
  it("SIM-08 / S2: 3 активных голоса одного voterToken при voteLimit=2 — нарушение", async () => {
    const store = makeStoreWithBoard(2);
    let state: State = empty();

    const created = createSticker(state, newClock(uuid("a1")), {
      column: "start",
      frac: "m",
      text: "target",
      color: "yellow",
    });
    state = merge(state, created.delta);
    const [entity] = [...created.delta.created.values()];
    if (!entity) throw new Error("expected created sticker");
    const stickerLamport = [...created.delta.entries.values()][0]?.stamp.lamport ?? 1;
    await appendDirect(store, created.dot, stickerLamport, toWire(created.delta));

    const voterToken = "vt:over-limit-guest";
    for (let i = 0; i < 3; i++) {
      const v = vote(state, newClock(uuid(`v${i}`)), entity.id, voterToken);
      state = merge(state, v.delta);
      await appendDirect(store, v.dot, null, toWire(v.delta));
    }

    const server = makeServer(store);
    const world = baseWorld(store, server, { oracle: oracleFromStore(store) });

    const violation = checkVoteLimit(world, 1);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S2");
  });

  it("SIM-08 / S2: 2 активных голоса одного voterToken при voteLimit=2 — нет нарушения", async () => {
    const store = makeStoreWithBoard(2);
    let state: State = empty();

    const created = createSticker(state, newClock(uuid("a1")), {
      column: "start",
      frac: "m",
      text: "target",
      color: "yellow",
    });
    state = merge(state, created.delta);
    const [entity] = [...created.delta.created.values()];
    if (!entity) throw new Error("expected created sticker");
    const stickerLamport = [...created.delta.entries.values()][0]?.stamp.lamport ?? 1;
    await appendDirect(store, created.dot, stickerLamport, toWire(created.delta));

    const voterToken = "vt:within-limit-guest";
    for (let i = 0; i < 2; i++) {
      const v = vote(state, newClock(uuid(`w${i}`)), entity.id, voterToken);
      state = merge(state, v.delta);
      await appendDirect(store, v.dot, null, toWire(v.delta));
    }

    const server = makeServer(store);
    const world = baseWorld(store, server, { oracle: oracleFromStore(store) });

    expect(checkVoteLimit(world, 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S3 — checkAck: журнал содержит строку seq с этим dot; нет повторов (actor,counter).
// ---------------------------------------------------------------------------

describe("SIM-08 / S3: checkAck", () => {
  async function setupOwnerCreatesSticker(): Promise<{
    store: MemoryBoardStore;
    server: BoardServer;
    seq: number;
    dot: Dot;
  }> {
    const store = makeStoreWithBoard();
    const server = makeServer(store);
    const owner = makePeer("c-owner", OWNER_ID, ACTOR_OWNER, "Owner");
    await connectPeer(server, [owner], owner);

    const actResult = owner.client.act({
      type: "createSticker",
      column: "start",
      frac: "m",
      text: "hi",
      color: "yellow",
    });
    if (!actResult.ok) throw new Error(`act failed: ${actResult.reason}`);
    let ackSeq: number | undefined;
    for (const raw of actResult.send) {
      const res = await server.receive(owner.connId, raw);
      for (const out of res.outgoing) {
        if (out.to !== owner.connId) continue;
        const msg = serverMessageSchema.parse(JSON.parse(out.raw));
        if (msg.type === "ack") ackSeq = msg.seq;
      }
    }
    if (ackSeq === undefined) throw new Error("expected an ack for the created sticker");
    return { store, server, seq: ackSeq, dot: { actor: ACTOR_OWNER, counter: 1 } };
  }

  it("SIM-08 / S3: ack с seq и dot, реально записанными в журнал — нет нарушения", async () => {
    const { store, server, seq, dot } = await setupOwnerCreatesSticker();
    const world = baseWorld(store, server, { oracle: oracleFromStore(store) });
    const ack: AckObservation = { seq, dot, kind: "op" };
    expect(checkAck(world, ack, 1)).toBeNull();
  });

  it("SIM-08 / S3: ack ссылается на seq, где в журнале лежит другой dot — нарушение", async () => {
    const { store, server, seq } = await setupOwnerCreatesSticker();
    const world = baseWorld(store, server, { oracle: oracleFromStore(store) });
    const forgedAck: AckObservation = { seq, dot: { actor: uuid("ff"), counter: 42 }, kind: "op" };
    const violation = checkAck(world, forgedAck, 1);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S3");
  });
});

// ---------------------------------------------------------------------------
// S4 — checkClientsMatchOracle: equals(compact(X_c(u)), compact(proj_u(X_S))) (ВС-6).
// S5 — checkScreensAgree: клиенты с одинаковой видимостью показывают один materialize.
// S6 — checkAckedOpsPersist: каждый dot, на который клиент получил ack, есть в X_S.
// ---------------------------------------------------------------------------

async function setupTwoPeersInGroupPhaseWithOneSticker(): Promise<{
  store: MemoryBoardStore;
  server: BoardServer;
  owner: Peer;
  bob: Peer;
}> {
  const store = makeStoreWithBoard();
  store.addMember(BOARD_ID, GUEST_B, "participant", "Bob");
  const server = makeServer(store);
  const owner = makePeer("c-owner", OWNER_ID, ACTOR_OWNER, "Owner");
  const bob = makePeer("c-bob", GUEST_B, ACTOR_B, "Bob");
  const peers = [owner, bob];
  await connectPeer(server, peers, owner);
  await connectPeer(server, peers, bob);
  await sendCommand(server, peers, owner, { type: "setPhase", phase: "group" });
  await act(server, peers, owner, {
    type: "createSticker",
    column: "start",
    frac: "m",
    text: "visible to all",
    color: "yellow",
  });
  return { store, server, owner, bob };
}

describe("SIM-08 / S4: checkClientsMatchOracle", () => {
  it("SIM-08 / S4: в покое, фаза group — confirmed клиента совпадает с oracle.proj (обычное совпадение)", async () => {
    const { store, server, owner, bob } = await setupTwoPeersInGroupPhaseWithOneSticker();
    const world = baseWorld(store, server, {
      guests: [
        { id: OWNER_ID, role: "owner", displayName: "Owner" },
        { id: GUEST_B, role: "participant", displayName: "Bob" },
      ],
      clients: [clientStateOf(owner, 0), clientStateOf(bob, 1)],
      oracle: oracleFromStore(store),
    });

    expect(checkClientsMatchOracle(world, 1)).toBeNull();
  });

  it("SIM-08 / S4: явное расхождение — клиенту не доставлен op, оракул расходится с X_c — нарушение", async () => {
    const store = makeStoreWithBoard();
    store.addMember(BOARD_ID, GUEST_B, "participant", "Bob");
    const server = makeServer(store);
    const owner = makePeer("c-owner", OWNER_ID, ACTOR_OWNER, "Owner");
    const bob = makePeer("c-bob", GUEST_B, ACTOR_B, "Bob");
    const peers = [owner, bob];
    await connectPeer(server, peers, owner);
    await connectPeer(server, peers, bob);
    await sendCommand(server, peers, owner, { type: "setPhase", phase: "group" });

    // Вторую операцию доставляем только автору — как потеря в канале
    // "сервер → клиент" (§ 4.3 simulator.md), а не через внутренние структуры.
    const actResult = owner.client.act({
      type: "createSticker",
      column: "start",
      frac: "n",
      text: "lost for bob",
      color: "green",
    });
    if (!actResult.ok) throw new Error(`act failed: ${actResult.reason}`);
    for (const raw of actResult.send) {
      const res = await server.receive(owner.connId, raw);
      const onlyToOwner = res.outgoing.filter((out) => out.to === owner.connId);
      await deliverAll(server, peers, onlyToOwner);
    }

    const world = baseWorld(store, server, {
      guests: [
        { id: OWNER_ID, role: "owner", displayName: "Owner" },
        { id: GUEST_B, role: "participant", displayName: "Bob" },
      ],
      clients: [clientStateOf(owner, 0), clientStateOf(bob, 1)],
      oracle: oracleFromStore(store),
    });

    const violation = checkClientsMatchOracle(world, 1);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S4");
  });

  it("SIM-08 / S4 (ВС-6): совпадение только после compact — клиент получил уже сжатый снапшот, оракул — нет", async () => {
    const store = makeStoreWithBoard();
    const server = makeServer(store);
    const owner = makePeer("c-owner", OWNER_ID, ACTOR_OWNER, "Owner");
    await connectPeer(server, [owner], owner);
    await sendCommand(server, [owner], owner, { type: "setPhase", phase: "group" });
    await act(server, [owner], owner, {
      type: "createSticker",
      column: "start",
      frac: "m",
      text: "a",
      color: "yellow",
    });
    const stickerId = `${ACTOR_OWNER}:1`;
    await act(server, [owner], owner, { type: "editText", id: stickerId, text: "b" });

    // E8: хранилище сохраняет compact(X_S) на текущем seq.
    store.saveSnapshot(BOARD_ID);

    // "Перезагрузка": новый экземпляр клиента подключается с lastSeq=null и
    // получает welcome со снапшотом (уже compact) вместо полного журнала.
    const reloaded = makePeer("c-owner-2", OWNER_ID, uuid("03"), "Owner");
    await connectPeer(server, [reloaded], reloaded);

    const world = baseWorld(store, server, {
      guests: [{ id: OWNER_ID, role: "owner", displayName: "Owner" }],
      clients: [clientStateOf(reloaded, 0)],
      oracle: oracleFromStore(store),
    });

    const confirmed = reloaded.client.inspect().confirmed;
    // Документирует сам феномен ВС-6: сырое сравнение разное представление
    // одного и того же видимого множества, compact — совпадает.
    expect(equals(confirmed, world.oracle.x)).toBe(false);
    expect(equals(compact(confirmed), compact(world.oracle.x))).toBe(true);

    expect(checkClientsMatchOracle(world, 1)).toBeNull();
  });
});

describe("SIM-08 / S5: checkScreensAgree", () => {
  it("SIM-08 / S5: одинаковая видимость (фаза group) — materialize совпадает у обоих клиентов", async () => {
    const { store, server, owner, bob } = await setupTwoPeersInGroupPhaseWithOneSticker();
    const world = baseWorld(store, server, {
      guests: [
        { id: OWNER_ID, role: "owner", displayName: "Owner" },
        { id: GUEST_B, role: "participant", displayName: "Bob" },
      ],
      clients: [clientStateOf(owner, 0), clientStateOf(bob, 1)],
      oracle: oracleFromStore(store),
    });

    expect(materialize(owner.client.inspect().confirmed)).toEqual(
      materialize(bob.client.inspect().confirmed),
    );
    expect(checkScreensAgree(world, 1)).toBeNull();
  });

  it("SIM-08 / S5: клиенту не доставлен op — экраны расходятся — нарушение", async () => {
    const store = makeStoreWithBoard();
    store.addMember(BOARD_ID, GUEST_B, "participant", "Bob");
    const server = makeServer(store);
    const owner = makePeer("c-owner", OWNER_ID, ACTOR_OWNER, "Owner");
    const bob = makePeer("c-bob", GUEST_B, ACTOR_B, "Bob");
    const peers = [owner, bob];
    await connectPeer(server, peers, owner);
    await connectPeer(server, peers, bob);
    await sendCommand(server, peers, owner, { type: "setPhase", phase: "group" });

    const actResult = owner.client.act({
      type: "createSticker",
      column: "start",
      frac: "n",
      text: "lost for bob",
      color: "green",
    });
    if (!actResult.ok) throw new Error(`act failed: ${actResult.reason}`);
    for (const raw of actResult.send) {
      const res = await server.receive(owner.connId, raw);
      const onlyToOwner = res.outgoing.filter((out) => out.to === owner.connId);
      await deliverAll(server, peers, onlyToOwner);
    }

    const world = baseWorld(store, server, {
      guests: [
        { id: OWNER_ID, role: "owner", displayName: "Owner" },
        { id: GUEST_B, role: "participant", displayName: "Bob" },
      ],
      clients: [clientStateOf(owner, 0), clientStateOf(bob, 1)],
      oracle: oracleFromStore(store),
    });

    const violation = checkScreensAgree(world, 1);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S5");
  });
});

describe("SIM-08 / S6: checkAckedOpsPersist", () => {
  it("SIM-08 / S6: dot, подтверждённый настоящим ack сервера, присутствует в X_S — нет нарушения", async () => {
    const { store, server, owner } = await setupTwoPeersInGroupPhaseWithOneSticker();
    const world = baseWorld(store, server, {
      guests: [{ id: OWNER_ID, role: "owner", displayName: "Owner" }],
      clients: [clientStateOf(owner, 0)],
      oracle: oracleFromStore(store),
    });

    expect(checkAckedOpsPersist(world, 1)).toBeNull();
  });

  it("SIM-08 / S6: клиент получил подделанный ack (сеть превратила reject в ack, мутант M2) — нарушение", () => {
    const store = makeStoreWithBoard();
    const server = makeServer(store);
    const outbox = createMemoryOutboxStore();
    const client = createSyncClient(
      { boardId: BOARD_ID, guestId: OWNER_ID, displayName: "Owner" },
      { newActorId: () => ACTOR_OWNER, newCommandId: () => "cmd", outbox },
    );

    const actResult = client.act({
      type: "createSticker",
      column: "start",
      frac: "m",
      text: "ghost",
      color: "yellow",
    });
    if (!actResult.ok) throw new Error(`act failed: ${actResult.reason}`);
    const pendingDot = client.inspect().pending[0]?.dot;
    if (!pendingDot) throw new Error("expected a pending entry after act()");

    // Сервер НИКОГДА не видел эту дельту — журнал пуст. Подделываем ack.
    client.receive(JSON.stringify({ type: "ack", dot: pendingDot, seq: 999 }));
    expect(client.inspect().pending).toHaveLength(0);

    const world = baseWorld(store, server, {
      guests: [{ id: OWNER_ID, role: "owner", displayName: "Owner" }],
      clients: [clientStateOf({ connId: "c1", guestId: OWNER_ID, client, outbox }, 0)],
      oracle: oracleFromStore(store),
    });

    const violation = checkAckedOpsPersist(world, 1);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S6");
  });
});

// ---------------------------------------------------------------------------
// S7 — checkReject: сопоставленный/устаревший отказ, разрешённые причины
// (ВС-7, ADR-0010, § 13 simulator.md).
// ---------------------------------------------------------------------------

describe("SIM-08 / S7: checkReject", () => {
  function minimalWorld(): World {
    const store = makeStoreWithBoard();
    const server = makeServer(store);
    return baseWorld(store, server, { oracle: oracleFromStore(store) });
  }

  const someDot: Dot = { actor: uuid("aa"), counter: 1 };

  it("SIM-08 / S7: сопоставленный отказ с разрешённой причиной (wrong_phase) — нет нарушения", () => {
    const world = minimalWorld();
    const observation: RejectObservation = {
      kind: "reject",
      dot: someDot,
      reason: "wrong_phase",
      wasPending: true,
      logGrew: false,
    };
    expect(checkReject(world, observation, 1)).toBeNull();
  });

  it("SIM-08 / S7 (ВС-8, H7): сопоставленный отказ с stale_dot — нет нарушения", () => {
    // H7 (T-005, разобрана 2026-09-16): честный клиент получает stale_dot на
    // dot, ещё лежащий в P, если ЕГО ЖЕ предыдущий отказ (обычно wrong_phase)
    // был потерян при разрыве до доставки (§ 4.3), а пока клиент был офлайн,
    // другие операции того же актора продвинули счётчик выше этого dot —
    // при пересылке всей P после реконнекта V1 (stale_dot) отклоняет его
    // раньше, чем V6 успел бы снова дать исходную причину. docs/spec/
    // simulator.md § 13 ВС-8.
    const world = minimalWorld();
    const observation: RejectObservation = {
      kind: "reject",
      dot: someDot,
      reason: "stale_dot",
      wasPending: true,
      logGrew: false,
    };
    expect(checkReject(world, observation, 1)).toBeNull();
  });

  it("SIM-08 / S7: сопоставленный отказ с запрещённой причиной (invalid_stamp) — нарушение", () => {
    const world = minimalWorld();
    const observation: RejectObservation = {
      kind: "reject",
      dot: someDot,
      reason: "invalid_stamp" as RejectReason,
      wasPending: true,
      logGrew: false,
    };
    const violation = checkReject(world, observation, 1);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S7");
  });

  it("SIM-08 / S7 (ADR-0010): устаревший отказ с причиной из тройки (unjustified_supersede) — нет нарушения", () => {
    const world = minimalWorld();
    const observation: RejectObservation = {
      kind: "reject",
      dot: someDot,
      reason: "unjustified_supersede",
      wasPending: false,
      logGrew: false,
    };
    expect(checkReject(world, observation, 1)).toBeNull();
  });

  it("SIM-08 / S7 (ВС-8, H7): устаревший отказ с wrong_phase (дубликат — сервер мог дать её и на первую, и на повторную попытку) — нет нарушения", () => {
    // H7: разделение множества причин по сопоставленный/устаревший снято —
    // честный дубликат одного и того же dot, отправленный повторно после
    // потери первого ответа, может прийти как устаревший с ЛЮБОЙ причиной
    // из общего множества, не только с тройкой ADR-0010. docs/spec/
    // simulator.md § 13 ВС-8.
    const world = minimalWorld();
    const observation: RejectObservation = {
      kind: "reject",
      dot: someDot,
      reason: "wrong_phase",
      wasPending: false,
      logGrew: false,
    };
    expect(checkReject(world, observation, 1)).toBeNull();
  });

  it("SIM-08 / S7: устаревший отказ с запрещённой причиной (invalid_stamp) — нарушение", () => {
    const world = minimalWorld();
    const observation: RejectObservation = {
      kind: "reject",
      dot: someDot,
      reason: "invalid_stamp" as RejectReason,
      wasPending: false,
      logGrew: false,
    };
    const violation = checkReject(world, observation, 1);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S7");
  });

  it("SIM-08 / S7 (ВС-8, H7): устаревший отказ с stale_dot (дубликат на уже убранный dot) — нет нарушения", () => {
    // Продолжение H7: тот же dot мог пережить несколько циклов разрыв→
    // переподключение до первого ответа — каждая копия независимо получает
    // stale_dot от сервера (findOpSeq никогда его не находит), первая
    // доставленная убирает dot из P, следующие дубликаты приходят уже на
    // устаревший dot. docs/spec/simulator.md § 13 ВС-8.
    const world = minimalWorld();
    const observation: RejectObservation = {
      kind: "reject",
      dot: someDot,
      reason: "stale_dot",
      wasPending: false,
      logGrew: false,
    };
    expect(checkReject(world, observation, 1)).toBeNull();
  });

  it("SIM-08 / S7: logGrew=true — нарушение независимо от причины", () => {
    const world = minimalWorld();
    const observation: RejectObservation = {
      kind: "reject",
      dot: someDot,
      reason: "unknown_target",
      wasPending: true,
      logGrew: true,
    };
    const violation = checkReject(world, observation, 1);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S7");
  });

  it("SIM-08 / S7: error сразу после E9 (afterStoreFault=true) — нет нарушения", () => {
    const world = minimalWorld();
    const observation: ErrorObservation = { kind: "error", afterStoreFault: true };
    expect(checkReject(world, observation, 1)).toBeNull();
  });

  it("SIM-08 / S7: error без предшествующего E9 (afterStoreFault=false) — нарушение", () => {
    const world = minimalWorld();
    const observation: ErrorObservation = { kind: "error", afterStoreFault: false };
    const violation = checkReject(world, observation, 1);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S7");
  });
});

describe("SIM-08 / S7: checkNoRejectedResidue — в покое dot из rejections не должен быть в confirmed/pending", () => {
  it("SIM-08 / S7: настоящий reject настоящего клиента не оставляет резидуа — нет нарушения", async () => {
    const store = makeStoreWithBoard();
    const server = makeServer(store);
    const outbox = createMemoryOutboxStore();
    const client = createSyncClient(
      { boardId: BOARD_ID, guestId: OWNER_ID, displayName: "Owner" },
      { newActorId: () => ACTOR_OWNER, newCommandId: () => "cmd", outbox },
    );
    const actResult = client.act({
      type: "createSticker",
      column: "start",
      frac: "m",
      text: "hi",
      color: "yellow",
    });
    if (!actResult.ok) throw new Error(`act failed: ${actResult.reason}`);
    const dot = client.inspect().pending[0]?.dot;
    if (!dot) throw new Error("expected a pending entry");
    client.receive(
      JSON.stringify({
        type: "reject",
        dot,
        reason: "wrong_phase",
        message: "wrong phase for test",
      }),
    );
    expect(client.inspect().pending).toHaveLength(0);
    expect(client.inspect().rejections).toHaveLength(1);

    const world = baseWorld(store, server, {
      guests: [{ id: OWNER_ID, role: "owner", displayName: "Owner" }],
      clients: [clientStateOf({ connId: "c1", guestId: OWNER_ID, client, outbox }, 0)],
      oracle: oracleFromStore(store),
    });

    expect(checkNoRejectedResidue(world, 1)).toBeNull();
  });

  it("SIM-08 / S7: клиент-мутант держит confirmed запись отклонённого dot — нарушение", () => {
    const store = makeStoreWithBoard();
    const server = makeServer(store);

    // Настоящий конструктор, а не собранный вручную created-без-entries: W4
    // (well-formed.ts) требует, чтобы created сопровождался записями во всех
    // обязательных полях вида — без этого materialize() ниже падает
    // (findWinner листает entries поля place, которых тут не было), а
    // фикстура должна быть валидным CRDT-состоянием, невалиден только сам
    // "мутант" (SyncClient, держащий отклонённый dot), не форма данных.
    const created = createSticker(empty(), newClock(ACTOR_OWNER), {
      column: "start",
      frac: "m",
      text: "ghost",
      color: "yellow",
    });
    const rejectedDot: Dot = created.dot;
    const residueState: State = merge(empty(), created.delta);

    // Минимальный фейковый SyncClient (мутант на границе ядра, § 10.2 —
    // "адаптер подменяет поведение на границе ядра") — единственный
    // легитимный способ смоделировать баг client-core, не трогая исходники.
    const fakeClient = {
      connected: () => [],
      receive: () => [],
      disconnected: () => {},
      act: () => ({ ok: false as const, reason: "invalid_intent" as const }),
      command: () => [],
      inspect: () => ({
        actorId: ACTOR_OWNER,
        confirmed: residueState,
        pending: [],
        full: residueState,
        view: materialize(residueState),
        lastSeq: null,
        status: "welcomed" as const,
        role: "owner" as const,
        meta: null,
        voterToken: null,
        commandFailures: [],
        rejections: [{ dot: rejectedDot, reason: "wrong_phase" as RejectReason }],
      }),
    };

    const world = baseWorld(store, server, {
      guests: [{ id: OWNER_ID, role: "owner", displayName: "Owner" }],
      clients: [
        {
          guestIndex: 0,
          core: fakeClient,
          outbox: createMemoryOutboxStore() as never,
          connection: null,
        },
      ],
      oracle: oracleFromStore(store),
    });

    const violation = checkNoRejectedResidue(world, 1);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S7");
  });
});

describe("SIM-08 / S7: остаток отклонённого голоса и ADR-0010 (dot unvote = dot голоса)", () => {
  function worldWithVote(inJournal: boolean) {
    const store = makeStoreWithBoard();
    const server = makeServer(store);
    const sticker = createSticker(empty(), newClock(ACTOR_OWNER), {
      column: "start",
      frac: "m",
      text: "s",
      color: "yellow",
    });
    const voted = vote(
      sticker.delta,
      sticker.clock,
      sticker.dot.actor + ":" + sticker.dot.counter,
      OWNER_ID,
    );
    const known: State = merge(sticker.delta, voted.delta);
    const fakeClient = {
      connected: () => [],
      receive: () => [],
      disconnected: () => {},
      act: () => ({ ok: false as const, reason: "invalid_intent" as const }),
      command: () => [],
      inspect: () => ({
        actorId: ACTOR_OWNER,
        confirmed: known,
        pending: [],
        full: known,
        view: materialize(known),
        lastSeq: null,
        status: "welcomed" as const,
        role: "owner" as const,
        meta: null,
        voterToken: null,
        // отказ на unvote этого голоса несёт dot самого голоса (ADR-0010)
        commandFailures: [],
        rejections: [{ dot: voted.dot, reason: "wrong_phase" as RejectReason }],
      }),
    };
    return baseWorld(store, server, {
      guests: [{ id: OWNER_ID, role: "owner", displayName: "Owner" }],
      clients: [
        {
          guestIndex: 0,
          core: fakeClient,
          outbox: createMemoryOutboxStore() as never,
          connection: null,
        },
      ],
      oracle: { x: inJournal ? known : sticker.delta, lastFoldedSeq: 0, stickerAuthor: new Map() },
    });
  }

  it("SIM-08 / S7: отказ на unvote при подтверждённом (в журнале) голосе того же dot — нет нарушения", () => {
    expect(checkNoRejectedResidue(worldWithVote(true), 1)).toBeNull();
  });

  it("SIM-08 / S7: голос с dot из rejections в confirmed, но не в журнале (выдуманный ack) — нарушение", () => {
    const violation = checkNoRejectedResidue(worldWithVote(false), 1);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S7");
  });
});

// ---------------------------------------------------------------------------
// S8 — checkSnapshotConsistency: I5.
// ---------------------------------------------------------------------------

describe("SIM-08 / S8: checkSnapshotConsistency", () => {
  it("SIM-08 / S8: настоящий снапшот на верном uptoSeq — materialize(snapshot ⊔ хвост) = materialize(X_S)", async () => {
    const store = makeStoreWithBoard();
    const server = makeServer(store);
    const owner = makePeer("c-owner", OWNER_ID, ACTOR_OWNER, "Owner");
    await connectPeer(server, [owner], owner);
    await act(server, [owner], owner, {
      type: "createSticker",
      column: "start",
      frac: "m",
      text: "a",
      color: "yellow",
    });
    const uptoSeqAtSnapshot = store.log(BOARD_ID).length; // одна операция = одна строка
    store.saveSnapshot(BOARD_ID);
    await act(server, [owner], owner, {
      type: "createSticker",
      column: "start",
      frac: "n",
      text: "b",
      color: "green",
    });

    const world = baseWorld(store, server, { oracle: oracleFromStore(store) });
    const snapshots: SnapshotObservation[] = [{ uptoSeq: uptoSeqAtSnapshot }];
    expect(checkSnapshotConsistency(world, snapshots, 1)).toBeNull();
  });

  it("SIM-08 / S8: наблюдение с неверным uptoSeq (не совпадает с реальным снапшотом) — нарушение", async () => {
    const store = makeStoreWithBoard();
    const server = makeServer(store);
    const owner = makePeer("c-owner", OWNER_ID, ACTOR_OWNER, "Owner");
    await connectPeer(server, [owner], owner);
    await act(server, [owner], owner, {
      type: "createSticker",
      column: "start",
      frac: "m",
      text: "a",
      color: "yellow",
    });
    store.saveSnapshot(BOARD_ID); // настоящий снапшот, uptoSeq = 1
    await act(server, [owner], owner, {
      type: "createSticker",
      column: "start",
      frac: "n",
      text: "b",
      color: "green",
    });

    const world = baseWorld(store, server, { oracle: oracleFromStore(store) });
    // Наблюдение утверждает, что снапшот был сделан ПОСЛЕ второй операции —
    // это не так (реальный store.latestSnapshot() отвечает uptoSeq=1).
    const snapshots: SnapshotObservation[] = [{ uptoSeq: 2 }];
    const violation = checkSnapshotConsistency(world, snapshots, 1);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S8");
  });
});

// ---------------------------------------------------------------------------
// S10 — checkNoAuthorLeak: пока фаза collect в момент отправки, сообщение
// гостю u не содержит элементов, принадлежащих стикерам других гостей.
// ---------------------------------------------------------------------------

describe("SIM-08 / S10: checkNoAuthorLeak", () => {
  function opMessageFor(entityId: string): string {
    const dot = { actor: uuid("aa"), counter: 1 };
    const stamp = { lamport: 1, actor: uuid("aa") };
    const message = serverMessageSchema.parse({
      type: "op",
      seq: 1,
      delta: {
        created: [{ id: entityId, kind: "sticker" }],
        entries: [
          { key: { entity: entityId, field: "text" }, dot, stamp, value: "secret" },
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

  it("SIM-08 / S10: в collect сообщение о чужом стикере другому гостю — нарушение", () => {
    const store = makeStoreWithBoard();
    const server = makeServer(store);
    const stickerId = `${uuid("aa")}:1`;
    const world = baseWorld(store, server, {
      oracle: {
        x: empty(),
        lastFoldedSeq: 0,
        stickerAuthor: new Map([[stickerId, OWNER_ID]]),
      },
    });
    const observation: OutgoingObservation = {
      raw: opMessageFor(stickerId),
      recipientGuestId: GUEST_B, // не автор
      phaseAtSend: "collect",
    };
    const violation = checkNoAuthorLeak(world, observation, 1);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S10");
  });

  it("SIM-08 / S10: в collect сообщение о своём стикере автору — нет нарушения", () => {
    const store = makeStoreWithBoard();
    const server = makeServer(store);
    const stickerId = `${uuid("aa")}:1`;
    const world = baseWorld(store, server, {
      oracle: {
        x: empty(),
        lastFoldedSeq: 0,
        stickerAuthor: new Map([[stickerId, OWNER_ID]]),
      },
    });
    const observation: OutgoingObservation = {
      raw: opMessageFor(stickerId),
      recipientGuestId: OWNER_ID, // сам автор
      phaseAtSend: "collect",
    };
    expect(checkNoAuthorLeak(world, observation, 1)).toBeNull();
  });

  it("SIM-08 / S10: фаза при отправке уже не collect (reveal) — утечки не может быть по определению — нет нарушения", () => {
    const store = makeStoreWithBoard();
    const server = makeServer(store);
    const stickerId = `${uuid("aa")}:1`;
    const world = baseWorld(store, server, {
      oracle: {
        x: empty(),
        lastFoldedSeq: 0,
        stickerAuthor: new Map([[stickerId, OWNER_ID]]),
      },
    });
    const observation: OutgoingObservation = {
      raw: opMessageFor(stickerId),
      recipientGuestId: GUEST_B,
      phaseAtSend: "group",
    };
    expect(checkNoAuthorLeak(world, observation, 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S11 — checkMessageSchema: серверные/клиентские схемы + лимит 16 KiB на вход.
// ---------------------------------------------------------------------------

describe("SIM-08 / S11: checkMessageSchema", () => {
  it("SIM-08 / S11: валидное сообщение сервер→клиент проходит схему — нет нарушения", () => {
    const message = serverMessageSchema.parse({
      type: "ack",
      dot: { actor: uuid("aa"), counter: 1 },
      seq: 1,
    });
    expect(checkMessageSchema("toClient", JSON.stringify(message), 1)).toBeNull();
  });

  it("SIM-08 / S11: сообщение сервер→клиент, не прошедшее схему, — нарушение", () => {
    const raw = JSON.stringify({ type: "ack", dot: { actor: "not-a-uuid", counter: 1 } }); // нет seq
    const violation = checkMessageSchema("toClient", raw, 1);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S11");
  });

  it("SIM-08 / S11: валидное сообщение клиент→сервер небольшого размера — нет нарушения", () => {
    const message = clientMessageSchema.parse({
      type: "hello",
      protocol: 1,
      guestId: uuid("01"),
      displayName: "Owner",
      actorId: uuid("02"),
      lastSeq: null,
    });
    expect(checkMessageSchema("toServer", JSON.stringify(message), 1)).toBeNull();
  });

  it("SIM-08 / S11: сообщение клиент→сервер длиннее 16 KiB — нарушение", () => {
    const message = clientMessageSchema.parse({
      type: "hello",
      protocol: 1,
      guestId: uuid("01"),
      displayName: "Owner",
      actorId: uuid("02"),
      lastSeq: null,
    });
    // Раздуваем строку до > 16 KiB паддингом внутри валидного JSON-объекта,
    // не трогая схему — просто добавляем лишнее поле, которое схема отбросит
    // при парсинге, но байтовый размер строки на проводе от этого не меняется.
    const raw = `${JSON.stringify(message).slice(0, -1)},"padding":"${"x".repeat(17 * 1024)}"}`;
    expect(raw.length).toBeGreaterThan(16 * 1024);
    const violation = checkMessageSchema("toServer", raw, 1);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S11");
  });

  it("SIM-08 / S11: сообщение сервер→клиент длиннее 16 KiB — лимит на это направление не распространяется", () => {
    // ВС-5 (simulator.md § 13): лимит 16 KiB — только на входящие (к серверу);
    // welcome с длинным журналом законно превышает его. Строим валидный, но
    // заведомо большой welcome через много "ops".
    const bigOps = Array.from({ length: 400 }, (_, i) => ({
      seq: i + 1,
      delta: { created: [], entries: [], supersedes: [], votes: [], unvotes: [] },
    }));
    const big = serverMessageSchema.parse({
      type: "welcome",
      role: "owner",
      voterToken: "vt:owner",
      meta: {
        boardId: BOARD_ID,
        title: "Retro",
        phase: "collect",
        revealed: false,
        voteLimit: 3,
        timer: null,
        authors: {},
      },
      snapshot: null,
      ops: bigOps,
    });
    const bigRaw = JSON.stringify(big);
    expect(bigRaw.length).toBeGreaterThan(16 * 1024);
    expect(checkMessageSchema("toClient", bigRaw, 1)).toBeNull();
  });
});
