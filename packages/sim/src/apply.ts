// Применение одного события — единственное место, где мир меняется
// (docs/design/T-005-simulator.md § 5.2/5.3). `applyEvent` сам не решает,
// нарушено ли какое-то свойство — только сообщает, что произошло; проверки
// (checks.ts) вызывает run.ts/drain.ts на основе этого наблюдения (см.
// комментарий в run.ts к `step`).

import type { Intent } from "@retro/client-core";
import type { Dot, EntityId } from "@retro/crdt";
import type { RejectReason } from "@retro/protocol";
import type { OpRow } from "@retro/server-core";
import type {
  AckObservation,
  ErrorObservation,
  OutgoingObservation,
  RejectObservation,
} from "./checks.js";
import { noteMessageBytes, recordServerStep, type SentFacts } from "./coverage.js";
import type { Event } from "./events.js";
import { createConnection, type Direction } from "./network.js";
import type { ClientState, World } from "./world.js";
import { createClientCore, touchRecent } from "./world.js";

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

/**
 * Поля сообщения сервера, нужные учёту. `welcome` может весить сотни килобайт, а нужно
 * знать только «со снапшотом или нет» — поле `snapshot` идёт сразу после малого `meta`,
 * так что хватает поиска в начале строки, без разбора всего JSON.
 */
function sentFactsOf(raw: string): SentFacts {
  if (raw.startsWith('{"type":"welcome"')) {
    const head = raw.slice(0, 4096);
    return { type: "welcome", snapshot: head.includes('"snapshot":null') ? null : {} };
  }
  return JSON.parse(raw) as SentFacts;
}

/** Индекс соединения по id (`conn-<индекс>`, см. applyConnect) — O(1) вместо линейного поиска. */
function connectionIndexOf(world: World, id: string): number {
  const index = Number(id.slice("conn-".length));
  return world.connections[index]?.id === id ? index : -1;
}

export async function applyEvent(world: World, event: Event): Promise<StepObservation> {
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
      return applyReload(world, event.client, event.actorId);
    case "command":
      return applyCommand(world, event.client, event.command, event.commandId);
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
  if (!result.ok) return EMPTY;

  world.stats.actsByIntent[intent.type] = (world.stats.actsByIntent[intent.type] ?? 0) + 1;

  if (client.connection !== null) {
    const connection = world.connections[client.connection];
    if (connection?.alive) {
      for (const raw of result.send) {
        connection.toServer.push(raw);
        noteMessageBytes(world, "toServer", raw);
      }
    }
  }

  const pendingNow = client.core.inspect().pending;
  if (pendingNow.length > world.stats.maxPending) world.stats.maxPending = pendingNow.length;
  const lastPending = pendingNow.at(-1);
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

  const rowsBefore = world.store.logSize(world.boardId);
  const phaseBefore = world.store.boardSync(world.boardId)?.phase ?? "collect";
  const result = await world.server.receive(connection.id, raw);
  const newLogRows = world.store.logFrom(world.boardId, rowsBefore);
  // Фаза ПОСЛЕ receive(), не до: setPhase и рассылка catch-up-строк reveal
  // происходят внутри одного и того же вызова (handlers/command.ts —
  // sendRevealCatchup вызывается сразу после обновления фазы), поэтому
  // «момент отправки» для всех сообщений этого receive() — уже новая фаза.
  // Для обычной op-рассылки (фаза не меняется этим вызовом) результат тот
  // же, что и «до» — различие проявляется только у самого setPhase.
  const phaseAtSend = world.store.boardSync(world.boardId)?.phase ?? "collect";

  const outgoing: OutgoingObservation[] = [];
  const rejects: (RejectObservation | ErrorObservation)[] = [];
  const sentFacts: SentFacts[] = [];

  for (const out of result.outgoing) {
    const sent = sentFactsOf(out.raw);
    sentFacts.push(sent);
    const targetIndex = connectionIndexOf(world, out.to);
    if (targetIndex === -1) continue;
    const target = world.connections[targetIndex];
    if (!target || !target.alive) {
      if (target && !target.serverClosed) target.addressedAfterCut += 1;
      world.stats.lostAfterCut += 1;
      continue;
    }
    target.toClient.push(out.raw);
    noteMessageBytes(world, "toClient", out.raw);

    const recipientClient = findClientByConnection(world, targetIndex);
    const recipientGuestId = recipientClient
      ? world.guests[recipientClient.guestIndex]?.id
      : undefined;
    if (recipientGuestId) outgoing.push({ raw: out.raw, recipientGuestId, phaseAtSend });

    // Только «error forbidden» после E9: схему проверяет S11, здесь достаточно полей.
    if (sent.type === "error" && sent.reason === "forbidden") {
      rejects.push({ kind: "error", afterStoreFault: world.pendingStoreFault });
      world.pendingStoreFault = false;
    }
  }

  recordServerStep(world, {
    connectionIndex,
    incoming: JSON.parse(raw),
    sent: sentFacts,
    newLogRows: newLogRows.length,
    phaseBefore,
    phaseAfter: phaseAtSend,
  });

  for (const closeId of result.close) {
    const idx = connectionIndexOf(world, closeId);
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
  // `welcome` (может весить сотни КБ) для этих наблюдений не нужен — не разбираем его.
  const message = (raw.startsWith('{"type":"welcome"') ? { type: "welcome" } : JSON.parse(raw)) as {
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
  if (message.type === "reject") {
    // Отказ убрал из очереди не только отклонённую дельту: зависимые удалены каскадом
    // (ADR-0010 а/б, у записи rejections есть `cause`) или пересобраны заново (в, новые dot).
    const after = client.core.inspect();
    const known = new Set(pendingBefore.map((entry) => `${entry.dot.actor}:${entry.dot.counter}`));
    const cascaded =
      after.rejections.some((rejection) => rejection.cause !== undefined) ||
      after.pending.some((entry) => !known.has(`${entry.dot.actor}:${entry.dot.counter}`));
    if (cascaded && pendingBefore.length > 1) {
      world.stats.coverage.opBuiltOnRejectedUnconfirmed = true;
    }
  }
  if (message.type === "error") {
    // error приходит перед закрытием соединения сервером: клиент уходит в офлайн
    client.core.disconnected();
    client.connection = null;
  } else if (connection.serverClosed && connection.toClient.length === 0) {
    clientLearnsClose(world, connectionIndex);
  }
  if (connection.alive) {
    for (const replyRaw of replies) {
      connection.toServer.push(replyRaw);
      noteMessageBytes(world, "toServer", replyRaw);
    }
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
  const client = findClientByConnection(world, connectionIndex);
  if (client && client.core.inspect().pending.length > 0) {
    world.stats.faultCoverage.cutWithNonEmptyPending = true;
  }
  if (connection.toClient.length > 0) world.stats.faultCoverage.cutWithNonEmptyToClient = true;
  connection.alive = false;
  connection.toServer.length = 0;
  connection.toClient.length = 0;
  connection.noticePending = true;
  world.stats.cuts += 1;

  if (client) {
    client.core.disconnected();
    client.connection = null;
  }
  return EMPTY;
}

async function applyServerNotice(world: World, connectionIndex: number): Promise<StepObservation> {
  const connection = world.connections[connectionIndex];
  if (!connection) return EMPTY;
  if (connection.addressedAfterCut > 0)
    world.stats.faultCoverage.noticeAfterAddressedMessage = true;
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

  if (client.core.inspect().lastSeq === null)
    world.stats.faultCoverage.connectWithNullLastSeq = true;
  else world.stats.faultCoverage.connectWithKnownLastSeq = true;
  const [hello] = client.core.connected();
  if (hello) {
    connection.toServer.push(hello);
    noteMessageBytes(world, "toServer", hello);
  }
  return EMPTY;
}

function applyReload(world: World, clientIndex: number, actorId: string): StepObservation {
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
  if (pendingLost > 0) {
    world.stats.coverage.reloadWithNonEmptyPending = true;
    world.stats.faultCoverage.reloadWithNonEmptyPending = true;
  }

  const fresh = createClientCore(world.boardId, guest, actorId);
  client.core = fresh.core;
  client.outbox = fresh.outbox;
  client.commandIds = fresh.commandIds;
  client.connection = null;
  world.stats.reloads += 1;
  return EMPTY;
}

function applyCommand(
  world: World,
  clientIndex: number,
  command: Extract<Event, { kind: "command" }>["command"],
  commandId: string,
): StepObservation {
  const client = world.clients[clientIndex];
  if (!client || client.connection === null) return EMPTY;
  const connection = world.connections[client.connection];
  if (!connection?.alive) return EMPTY;

  if (client.commandIds) client.commandIds.next = commandId;
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
