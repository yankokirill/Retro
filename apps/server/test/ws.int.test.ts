// T-009 — «WS-синхронизация»: приёмочные тесты для контракта
// `apps/server/src/app.ts` (маршрут `GET /api/boards/:boardId/ws`) и
// `BoardHub`, написанные ДО реализации (docs/spec/protocol.md § 4–6;
// docs/spec/requirements.md REQ-022, REQ-023 кр. 3).
//
// Ключевая функция сборки `welcome` сейчас — заглушка (`welcomeData: not
// implemented`, см. задачу T-009): каждый сценарий ниже должен падать
// именно из-за этого, а не из-за ошибки в самом тесте.
//
// Все дельты собираются ТОЛЬКО через публичный API `@retro/crdt`
// (`empty`, `newClock`, `createSticker`, `toWire`) и провалидированы через
// реальные zod-схемы `@retro/protocol` (`clientMessageSchema` косвенно —
// сервер сам валидирует то, что мы посылаем). Внутренности `apps/server/src`
// (кроме `app.ts`/`boards/service.ts`, чей контракт дан в задаче verbatim) и
// `packages/crdt/src/ops/**` не читались.

import type { EntityId } from "@retro/crdt";
import { createSticker, empty, newClock, setColor, toWire } from "@retro/crdt";
import type { ServerMessage } from "@retro/protocol";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { createBoard, joinByLink } from "../src/boards/service.js";
import * as schema from "../src/db/schema.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let app: FastifyInstance;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  app = buildApp({ db, voterTokenSecret: "test-secret" });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

const newGuestId = () => crypto.randomUUID();
const newActorId = () => crypto.randomUUID();

/** Открывает WS-соединение к доске без реального сетевого порта (injectWS). */
async function connect(boardId: string): Promise<WebSocket> {
  return app.injectWS(`/api/boards/${boardId}/ws`);
}

/** Читает сообщения `ws` по одному, в порядке доставки, независимо от таймингов. */
function messageReader(ws: WebSocket) {
  const queue: ServerMessage[] = [];
  const waiters: Array<(msg: ServerMessage) => void> = [];

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as ServerMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });

  return {
    async next(): Promise<ServerMessage> {
      const queued = queue.shift();
      if (queued) return queued;
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function sendHello(
  ws: WebSocket,
  params: { guestId: string; displayName: string; actorId: string; lastSeq?: number | null },
) {
  ws.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      guestId: params.guestId,
      displayName: params.displayName,
      actorId: params.actorId,
      lastSeq: params.lastSeq ?? null,
    }),
  );
}

async function newBoardWithOwner(): Promise<{
  boardId: string;
  ownerId: string;
  participantLink: string;
}> {
  const ownerId = newGuestId();
  const { boardId, participantLink } = await createBoard(db, {
    title: "T-009 test board",
    displayName: "Owner",
    voteLimit: 3,
    ownerId,
  });
  return { boardId, ownerId, participantLink };
}

// ---------------------------------------------------------------------------
// REQ-022 — сходимость: одна и та же принятая операция доходит до автора
// (ack) и до другого участника (broadcast op) с одним и тем же seq.
// ---------------------------------------------------------------------------

describe("REQ-022: сходимость независимо от порядка и повторов доставки", () => {
  it("REQ-022: welcome на hello содержит role/voterToken/meta/snapshot=null/ops=[] для новой доски", async () => {
    const { boardId, ownerId } = await newBoardWithOwner();
    const ws = await connect(boardId);
    const reader = messageReader(ws);

    sendHello(ws, { guestId: ownerId, displayName: "Owner", actorId: newActorId() });
    const welcome = await reader.next();

    expect(welcome.type).toBe("welcome");
    if (welcome.type !== "welcome") throw new Error("expected welcome");
    expect(welcome.role).toBe("owner");
    expect(typeof welcome.voterToken).toBe("string");
    expect(welcome.voterToken.length).toBeGreaterThan(0);
    expect(welcome.meta.boardId).toBe(boardId);
    expect(welcome.snapshot).toBeNull();
    expect(welcome.ops).toEqual([]);

    ws.close();
  });

  it("REQ-022: два участника одной доски получают одну и ту же принятую операцию — автор через ack, другой через op, с одним seq", async () => {
    const { boardId, ownerId, participantLink } = await newBoardWithOwner();
    const participantId = newGuestId();
    const joined = await joinByLink(db, {
      linkToken: participantLink,
      guestId: participantId,
      displayName: "Alice",
    });
    expect(joined?.role).toBe("participant");

    const wsOwner = await connect(boardId);
    const wsParticipant = await connect(boardId);
    const readerOwner = messageReader(wsOwner);
    const readerParticipant = messageReader(wsParticipant);

    const actorOwner = newActorId();
    const actorParticipant = newActorId();
    sendHello(wsOwner, { guestId: ownerId, displayName: "Owner", actorId: actorOwner });
    sendHello(wsParticipant, {
      guestId: participantId,
      displayName: "Alice",
      actorId: actorParticipant,
    });

    const welcomeOwner = await readerOwner.next();
    const welcomeParticipant = await readerParticipant.next();
    expect(welcomeOwner.type).toBe("welcome");
    expect(welcomeParticipant.type).toBe("welcome");

    // Владелец создаёт стикер — ровно одна CRDT-операция (§ 3 protocol.md).
    const created = createSticker(empty(), newClock(actorOwner), {
      column: "start",
      frac: "1",
      text: "hello from owner",
      color: "yellow",
    });
    const wireDelta = toWire(created.delta);

    wsOwner.send(JSON.stringify({ type: "op", delta: wireDelta }));

    const ack = await readerOwner.next();
    expect(ack.type).toBe("ack");
    if (ack.type !== "ack") throw new Error("expected ack");
    expect(ack.dot).toEqual(created.dot);
    expect(typeof ack.seq).toBe("number");

    const broadcast = await readerParticipant.next();
    expect(broadcast.type).toBe("op");
    if (broadcast.type !== "op") throw new Error("expected op broadcast");
    expect(broadcast.seq).toBe(ack.seq);
    expect(broadcast.delta.created).toEqual(wireDelta.created);
    expect(broadcast.delta.entries).toEqual(wireDelta.entries);

    wsOwner.close();
    wsParticipant.close();
  });
});

// ---------------------------------------------------------------------------
// REQ-023 кр. 3 — повторно отправленная операция применяется один раз:
// второй `op` с тем же dot возвращает тот же seq, что и первый.
// ---------------------------------------------------------------------------

describe("REQ-023 кр.3: повторно отправленная операция применяется один раз", () => {
  it("REQ-023 кр.3: тот же op-message, отправленный дважды подряд, получает ack с одним и тем же seq оба раза", async () => {
    const { boardId, ownerId } = await newBoardWithOwner();
    const ws = await connect(boardId);
    const reader = messageReader(ws);

    const actorId = newActorId();
    sendHello(ws, { guestId: ownerId, displayName: "Owner", actorId });
    const welcome = await reader.next();
    expect(welcome.type).toBe("welcome");

    const created = createSticker(empty(), newClock(actorId), {
      column: "start",
      frac: "1",
      text: "duplicate me",
      color: "green",
    });
    const wireDelta = toWire(created.delta);
    const opMessage = JSON.stringify({ type: "op", delta: wireDelta });

    ws.send(opMessage);
    const firstAck = await reader.next();
    expect(firstAck.type).toBe("ack");
    if (firstAck.type !== "ack") throw new Error("expected ack");

    ws.send(opMessage);
    const secondAck = await reader.next();
    expect(secondAck.type).toBe("ack");
    if (secondAck.type !== "ack") throw new Error("expected ack");

    expect(secondAck.dot).toEqual(firstAck.dot);
    expect(secondAck.seq).toBe(firstAck.seq);

    ws.close();
  });
});

// ---------------------------------------------------------------------------
// REQ-002 — не член доски: `hello` от постороннего guestId (не owner, не
// присоединялся по ссылке) отклоняется без welcome, соединение закрывается.
// ---------------------------------------------------------------------------

describe("REQ-002: hello постороннего guestId отклоняется на уровне WS", () => {
  it("REQ-002: guestId без записи в members получает error вместо welcome, соединение закрывается", async () => {
    const { boardId } = await newBoardWithOwner();
    const strangerId = newGuestId();

    const ws = await connect(boardId);
    const reader = messageReader(ws);

    let closed = false;
    ws.on("close", () => {
      closed = true;
    });

    sendHello(ws, { guestId: strangerId, displayName: "Stranger", actorId: newActorId() });

    const response = await reader.next();
    expect(response.type).toBe("error");

    await new Promise<void>((resolve) => {
      if (closed) return resolve();
      ws.on("close", () => resolve());
      setTimeout(resolve, 2000);
    });
    expect(closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REQ-024 — правило приёма V3 сквозь весь пайплайн: семантически некорректная
// операция (правка несуществующей сущности) возвращается автору как `reject`
// с reason "unknown_target" по настоящему WS-соединению, а не просто из
// чистой функции `validateOp` (это уже покрыто validate.test.ts). Отклонённая
// операция не должна портить остальную сессию соединения (REQ-024 кр. 1).
// ---------------------------------------------------------------------------

describe("REQ-024: reject доходит до клиента по WS и не ломает соединение", () => {
  it("REQ-024: write в несуществующую сущность получает reject с reason unknown_target и тем же dot", async () => {
    const { boardId, ownerId } = await newBoardWithOwner();
    const ws = await connect(boardId);
    const reader = messageReader(ws);

    const actorId = newActorId();
    sendHello(ws, { guestId: ownerId, displayName: "Owner", actorId });
    const welcome = await reader.next();
    expect(welcome.type).toBe("welcome");

    // Дельта формально валидна (одна операция, значение в домене поля), но
    // ссылается на сущность, которой нет ни в снапшоте, ни в этой же дельте.
    const missing = `${crypto.randomUUID()}:1` as EntityId;
    const edit = setColor(empty(), newClock(actorId), missing, "green");
    const wireDelta = toWire(edit.delta);

    ws.send(JSON.stringify({ type: "op", delta: wireDelta }));

    const rejected = await reader.next();
    expect(rejected.type).toBe("reject");
    if (rejected.type !== "reject") throw new Error("expected reject");
    expect(rejected.dot).toEqual(edit.dot);
    expect(rejected.reason).toBe("unknown_target");
    expect(rejected.message.length).toBeGreaterThan(0);

    // Соединение остаётся рабочим: следующая, уже корректная операция
    // принимается как обычно.
    const created = createSticker(empty(), newClock(actorId), {
      column: "start",
      frac: "1",
      text: "still alive after reject",
      color: "yellow",
    });
    ws.send(JSON.stringify({ type: "op", delta: toWire(created.delta) }));

    const ack = await reader.next();
    expect(ack.type).toBe("ack");
    if (ack.type !== "ack") throw new Error("expected ack");
    expect(ack.dot).toEqual(created.dot);

    ws.close();
  });
});
