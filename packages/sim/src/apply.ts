// Применение одного события — единственное место, где мир меняется
// (docs/design/T-005-simulator.md § 5.2/5.3). `applyEvent` сам не решает,
// нарушено ли какое-то свойство — только сообщает, что произошло; проверки
// (checks.ts) вызывает run.ts/drain.ts на основе этого наблюдения (см.
// комментарий в run.ts к `step`).

import { createMemoryOutboxStore, createSyncClient, type Intent } from "@retro/client-core";
import type { Dot, EntityId } from "@retro/crdt";
import type { RejectReason } from "@retro/protocol";
import type { OpRow } from "@retro/server-core";
import type {
  AckObservation,
  ErrorObservation,
  OutgoingObservation,
  RejectObservation,
} from "./checks.js";
import type { Event } from "./events.js";
import { createConnection, type Direction } from "./network.js";
import type { Prng } from "./prng.js";
import type { ClientState, World } from "./world.js";
import { touchRecent } from "./world.js";

export interface StepObservation {
  /** Новые строки журнала, появившиеся за это событие (обычно 0 или 1 — только `deliver toServer`, принявший операцию). */
  readonly newLogRows: readonly OpRow[];
  readonly acks: readonly AckObservation[];
  readonly rejects: readonly (RejectObservation | ErrorObservation)[];
  /** Сообщения «сервер → клиент», ушедшие в каналы за это событие — для S10, с фазой на момент отправки. */
  readonly outgoing: readonly OutgoingObservation[];
  /** Каждая строка, реально пересланная по сети за это событие — для S11 (обе стороны). */
  readonly sentRaw: readonly { readonly direction: Direction; readonly raw: string }[];
}

const EMPTY: StepObservation = { newLogRows: [], acks: [], rejects: [], outgoing: [], sentRaw: [] };

function intentTarget(intent: Intent): EntityId | undefined {
  switch (intent.type) {
    case "editText":
    case "setColor":
    case "move":
    case "setGroup":
    case "delete":
    case "restore":
    case "renameGroup":
    case "editAction":
    case "assign":
    case "setDone":
      return intent.id;
    case "vote":
    case "unvote":
      return intent.target;
    default:
      return undefined;
  }
}

function findClientByConnection(world: World, connectionIndex: number): ClientState | undefined {
  return world.clients.find((c) => c.connection === connectionIndex);
}

function lastSeqOf(rows: readonly OpRow[]): number {
  const last = rows[rows.length - 1];
  return last ? last.seq : 0;
}

export async function applyEvent(world: World, event: Event, prng: Prng): Promise<StepObservation> {
  switch (event.kind) {
    case "act":
      return applyAct(world, event.client, event.intent);
    case "deliver":
      return event.direction === "toServer"
        ? applyDeliverToServer(world, event.connection)
        : applyDeliverToClient(world, event.connection);
    case "cut":
      return applyCut(world, event.connection);
    case "serverNotice":
      return applyServerNotice(world, event.connection);
    case "connect":
      return applyConnect(world, event.client);
    case "reload":
      return applyReload(world, event.client, prng);
    case "command":
      return applyCommand(world, event.client, event.command);
    case "snapshot":
      return applySnapshot(world);
    case "storeFault":
      world.store.failNextTransaction(event.afterWrites);
      world.pendingStoreFault = true;
      return EMPTY;
    default:
      return EMPTY;
  }
}

function applyAct(
  world: World,
  clientIndex: number,
  intent: Extract<Event, { kind: "act" }>["intent"],
): StepObservation {
  const client = world.clients[clientIndex];
  if (!client) return EMPTY;
  world.acts += 1;

  const result = client.core.act(intent);
  if (!result.ok) {
    world.stats.rejectedByReason[result.reason] =
      (world.stats.rejectedByReason[result.reason] ?? 0) + 1;
    return EMPTY;
  }

  world.stats.actsByIntent[intent.type] = (world.stats.actsByIntent[intent.type] ?? 0) + 1;

  if (client.connection !== null) {
    const connection = world.connections[client.connection];
    if (connection?.alive) {
      for (const raw of result.send) connection.toServer.push(raw);
    }
  }

  const lastPending = client.core.inspect().pending.at(-1);
  const createdId = lastPending?.delta.created[0]?.id;
  const touched = intentTarget(intent) ?? createdId;
  if (touched) touchRecent(world, touched);

  if (intent.type === "createSticker" && createdId) {
    const guest = world.guests[client.guestIndex];
    if (guest) world.oracle.stickerAuthor.set(createdId, guest.id);
  }

  return EMPTY;
}

async function applyDeliverToServer(
  world: World,
  connectionIndex: number,
): Promise<StepObservation> {
  const connection = world.connections[connectionIndex];
  if (!connection) return EMPTY;
  const raw = connection.toServer.shift();
  if (raw === undefined) return EMPTY;

  const beforeSeq = lastSeqOf(world.store.log(world.boardId));
  const result = await world.server.receive(connection.id, raw);
  const afterRows = world.store.log(world.boardId);
  const newLogRows = afterRows.filter((r) => r.seq > beforeSeq);
  // Фаза ПОСЛЕ receive(), не до: setPhase и рассылка catch-up-строк reveal
  // происходят внутри одного и того же вызова (handlers/command.ts —
  // sendRevealCatchup вызывается сразу после обновления фазы), поэтому
  // «момент отправки» для всех сообщений этого receive() — уже новая фаза.
  // Для обычной op-рассылки (фаза не меняется этим вызовом) результат тот
  // же, что и «до» — различие проявляется только у самого setPhase.
  const phaseAtSend = world.store.boardSync(world.boardId)?.phase ?? "collect";

  const outgoing: OutgoingObservation[] = [];
  const rejects: (RejectObservation | ErrorObservation)[] = [];

  for (const out of result.outgoing) {
    const targetIndex = world.connections.findIndex((c) => c.id === out.to);
    if (targetIndex === -1) continue;
    const target = world.connections[targetIndex];
    if (!target || !target.alive) {
      world.stats.lostAfterCut += 1;
      continue;
    }
    target.toClient.push(out.raw);

    const recipientClient = findClientByConnection(world, targetIndex);
    const recipientGuestId = recipientClient
      ? world.guests[recipientClient.guestIndex]?.id
      : undefined;
    if (recipientGuestId) outgoing.push({ raw: out.raw, recipientGuestId, phaseAtSend });

    // Только «error forbidden» после E9: схему проверяет S11, здесь достаточно полей.
    const sent = JSON.parse(out.raw) as { type?: string; reason?: string };
    if (sent.type === "error" && sent.reason === "forbidden") {
      rejects.push({ kind: "error", afterStoreFault: world.pendingStoreFault });
      world.pendingStoreFault = false;
    }
  }

  for (const closeId of result.close) {
    const idx = world.connections.findIndex((c) => c.id === closeId);
    const target = idx === -1 ? undefined : world.connections[idx];
    if (target) {
      target.alive = false;
      target.serverClosed = true;
      target.toServer.length = 0; // сервер закрыл — отправленное клиентом уже не прочтёт
      await world.server.close(target.id);
      if (target.toClient.length === 0) clientLearnsClose(world, idx);
    }
  }

  return { newLogRows, acks: [], rejects, outgoing, sentRaw: [{ direction: "toServer", raw }] };
}

function applyDeliverToClient(world: World, connectionIndex: number): StepObservation {
  const connection = world.connections[connectionIndex];
  if (!connection) return EMPTY;
  const raw = connection.toClient.shift();
  if (raw === undefined) return EMPTY;

  const client = findClientByConnection(world, connectionIndex);
  if (!client)
    return {
      newLogRows: [],
      acks: [],
      rejects: [],
      outgoing: [],
      sentRaw: [{ direction: "toClient", raw }],
    };

  const pendingBefore = client.core.inspect().pending;
  const acks: AckObservation[] = [];
  const rejects: (RejectObservation | ErrorObservation)[] = [];

  // Схему сообщения проверяет S11 при постановке в канал, ядро клиента валидирует
  // входящее само — здесь достаточно полей для наблюдений.
  const message = JSON.parse(raw) as {
    type?: string;
    dot: Dot;
    seq: number;
    reason: RejectReason;
  };
  if (message.type === "ack") {
    const match = pendingBefore.find(
      (p) => p.dot.actor === message.dot.actor && p.dot.counter === message.dot.counter,
    );
    acks.push({
      seq: message.seq,
      dot: message.dot,
      kind: match?.kind ?? "op",
      target: match?.kind === "unvote" ? match.delta.unvotes[0]?.target : undefined,
    });
  } else if (message.type === "reject") {
    const wasPending = pendingBefore.some(
      (p) => p.dot.actor === message.dot.actor && p.dot.counter === message.dot.counter,
    );
    rejects.push({
      kind: "reject",
      dot: message.dot,
      reason: message.reason,
      wasPending,
      logGrew: false,
    });
  }

  const replies = client.core.receive(raw);
  if (message.type === "error") {
    // error приходит перед закрытием соединения сервером: клиент уходит в офлайн
    client.core.disconnected();
    client.connection = null;
  } else if (connection.serverClosed && connection.toClient.length === 0) {
    clientLearnsClose(world, connectionIndex);
  }
  if (connection.alive) {
    for (const replyRaw of replies) connection.toServer.push(replyRaw);
  }

  return { newLogRows: [], acks, rejects, outgoing: [], sentRaw: [{ direction: "toClient", raw }] };
}

/** Клиент узнаёт, что сервер закрыл соединение и в канале больше ничего нет: уходит в офлайн (тогда E5 подключит его заново). */
function clientLearnsClose(world: World, connectionIndex: number): void {
  const client = findClientByConnection(world, connectionIndex);
  if (!client) return;
  client.core.disconnected();
  client.connection = null;
}

function applyCut(world: World, connectionIndex: number): StepObservation {
  const connection = world.connections[connectionIndex];
  if (!connection || !connection.alive) return EMPTY;
  connection.alive = false;
  connection.toServer.length = 0;
  connection.toClient.length = 0;
  connection.noticePending = true;
  world.stats.cuts += 1;

  const client = findClientByConnection(world, connectionIndex);
  if (client) {
    client.core.disconnected();
    client.connection = null;
  }
  return EMPTY;
}

async function applyServerNotice(world: World, connectionIndex: number): Promise<StepObservation> {
  const connection = world.connections[connectionIndex];
  if (!connection) return EMPTY;
  await world.server.close(connection.id);
  connection.noticePending = false;
  return EMPTY;
}

function applyConnect(world: World, clientIndex: number): StepObservation {
  const client = world.clients[clientIndex];
  if (!client || client.connection !== null) return EMPTY;

  const connectionIndex = world.connections.length;
  const connection = createConnection(`conn-${connectionIndex}`, clientIndex);
  world.connections.push(connection);
  world.server.open(connection.id, world.boardId);
  client.connection = connectionIndex;

  const [hello] = client.core.connected();
  if (hello) connection.toServer.push(hello);
  return EMPTY;
}

function applyReload(world: World, clientIndex: number, prng: Prng): StepObservation {
  const client = world.clients[clientIndex];
  if (!client) return EMPTY;
  const guest = world.guests[client.guestIndex];
  if (!guest) return EMPTY;

  if (client.connection !== null) {
    const connection = world.connections[client.connection];
    if (connection?.alive) {
      connection.alive = false;
      connection.toServer.length = 0;
      connection.toClient.length = 0;
      connection.noticePending = true;
    }
  }

  const pendingLost = client.core.inspect().pending.length;
  if (pendingLost > 0) world.stats.coverage.reloadWithNonEmptyPending = true;

  const outbox = createMemoryOutboxStore();
  client.core = createSyncClient(
    { boardId: world.boardId, guestId: guest.id, displayName: guest.displayName },
    { newActorId: () => prng.uuid(), newCommandId: () => prng.uuid(), outbox },
  );
  client.outbox = outbox;
  client.connection = null;
  world.stats.reloads += 1;
  return EMPTY;
}

function applyCommand(
  world: World,
  clientIndex: number,
  command: Extract<Event, { kind: "command" }>["command"],
): StepObservation {
  const client = world.clients[clientIndex];
  if (!client || client.connection === null) return EMPTY;
  const connection = world.connections[client.connection];
  if (!connection?.alive) return EMPTY;

  const [raw] = client.core.command(command);
  if (raw) connection.toServer.push(raw);
  return EMPTY;
}

function applySnapshot(world: World): StepObservation {
  world.store.saveSnapshot(world.boardId);
  const snapshot = world.store.latestSnapshotSync(world.boardId);
  // MemoryBoardStore.saveSnapshot ЗАМЕНЯЕТ снапшот, не копит историю (как и
  // PgBoardStore — одна строка snapshots на доску) — более ранние
  // наблюдения этого чекпоинта больше нечем проверить (latestSnapshotSync
  // всё равно вернёт только последний), поэтому держим не список, а
  // единственное текущее наблюдение.
  world.snapshotsObserved.length = 0;
  if (snapshot) world.snapshotsObserved.push({ uptoSeq: snapshot.uptoSeq });
  return EMPTY;
}
