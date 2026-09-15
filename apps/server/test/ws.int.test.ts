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

import type { EntityId, WireDelta } from "@retro/crdt";
import {
  createSticker,
  deleteEntity,
  dotKey,
  empty,
  newClock,
  setColor,
  toWire,
  unvote,
  vote,
} from "@retro/crdt";
import type { ServerMessage } from "@retro/protocol";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
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

/**
 * Ждёт следующее сообщение одного из `types`, пропуская по пути чужие
 * `op`-рассылки. protocol.md § 6: сервер шлёт `op` всем подписчикам доски,
 * кроме автора операции — подписчик, ожидающий ответ на СВОЁ сообщение
 * (`ack`/`reject`/`commandResult`), может получить их вперемешку с чужими
 * `op` (в т.ч. от другой вкладки того же guestId — см. REQ-022 тесты выше).
 * Любой другой незапрошенный тип (`meta`/`welcome`/`error`) — не пропускаем:
 * его появление означает реальную проблему, тест должен упасть на нём явно.
 */
async function nextOfType<T extends ServerMessage["type"]>(
  reader: ReturnType<typeof messageReader>,
  types: readonly T[],
): Promise<Extract<ServerMessage, { type: T }>> {
  for (;;) {
    const msg = await reader.next();
    if ((types as readonly string[]).includes(msg.type)) {
      return msg as Extract<ServerMessage, { type: T }>;
    }
    if (msg.type === "op") continue;
    throw new Error(
      `nextOfType: unexpected message type "${msg.type}", expected one of [${types.join(", ")}]`,
    );
  }
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

    // T-013, REQ-006: в default-фазе collect чужой стикер скрыт — это не то,
    // что здесь проверяется (см. отдельные тесты REQ-006 ниже). Уходим в
    // group, чтобы эта операция была видна обоим и проверялся только сам
    // факт сходимости (REQ-022), не видимость.
    wsOwner.send(
      JSON.stringify({
        type: "command",
        id: "cmd-group",
        command: { type: "setPhase", phase: "group" },
      }),
    );
    // Порядок commandResult/meta для автора командой не фиксирован (см. REQ-004 тест выше).
    await Promise.all([readerOwner.next(), readerOwner.next()]);
    await nextOfType(readerParticipant, ["meta"]);

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
// T-026, H1/H2 (`docs/spec/simulator.md` § 12) — две настоящие ошибки текущего
// кода, найденные анализом (не прогоном) при проектировании T-005. Обе должны
// давать красные тесты ДО исправления апрель-2026.
//
// H2: `hello` ждёт `getBoardForGuest` (async) прежде, чем проставить внутреннее
// состояние подписки соединения; если вторым сообщением того же соединения,
// не дожидаясь `welcome`, сразу отправить `op`, он может попасть на обработчик
// раньше, чем `hello` успеет завершиться — сервер тогда отвечает
// `error {reason: "invalid_shape", message: "first message must be hello"}`
// и закрывает соединение. Правильно: оба сообщения обрабатываются по порядку
// (`hello` → `welcome`, `op` → `ack`/`reject`), соединение не закрывается.
// Гонка не гарантированно проявляется на первой попытке — повторяем на
// нескольких новых соединениях.
// ---------------------------------------------------------------------------

describe("REQ-023 (кр. 2), H2: op сразу после hello (без ожидания welcome) не рвёт соединение", () => {
  it("REQ-023 (кр. 2), H2: op вторым сообщением того же соединения, отправленный без await после hello, получает ack/reject, а не error — соединение остаётся открытым", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { boardId, ownerId } = await newBoardWithOwner();
      const ws = await connect(boardId);
      const reader = messageReader(ws);

      let closedByServer = false;
      ws.on("close", () => {
        closedByServer = true;
      });

      const actorId = newActorId();
      const created = createSticker(empty(), newClock(actorId), {
        column: "start",
        frac: "1",
        text: `H2 attempt ${attempt}`,
        color: "yellow",
      });

      // Ключевое условие гонки: НЕТ `await` между `hello` и `op` — оба уходят
      // в канал друг за другом в одном тике, до какого-либо ответа сервера.
      sendHello(ws, { guestId: ownerId, displayName: "Owner", actorId });
      ws.send(JSON.stringify({ type: "op", delta: toWire(created.delta) }));

      let sawWelcome = false;
      let sawAckOrReject = false;
      for (let i = 0; i < 2; i++) {
        const msg = await reader.next();
        if (msg.type === "welcome") {
          sawWelcome = true;
        } else if (msg.type === "ack" || msg.type === "reject") {
          sawAckOrReject = true;
        } else {
          throw new Error(
            `H2 (attempt ${attempt}): unexpected message "${msg.type}" — ожидались только welcome и ack/reject, не error/закрытие`,
          );
        }
      }
      expect(sawWelcome).toBe(true);
      expect(sawAckOrReject).toBe(true);
      expect(closedByServer).toBe(false);

      // Соединение действительно живо: ещё один валидный op ПОСЛЕ welcome
      // (обычным путём, с ожиданием) тоже получает ack.
      const created2 = createSticker(empty(), created.clock, {
        column: "start",
        frac: "2",
        text: `H2 attempt ${attempt} - proof of life`,
        color: "yellow",
      });
      ws.send(JSON.stringify({ type: "op", delta: toWire(created2.delta) }));
      const proof = await reader.next();
      expect(proof.type).toBe("ack");

      ws.close();
    }
  });
});

// ---------------------------------------------------------------------------
// REQ-024 — правило приёма V3 сквозь весь пайплайн: семантически некорректная
// операция (правка несуществующей сущности) возвращается автору как `reject`
// с reason "unknown_target" по настоящему WS-соединению, а не просто из
// чистой функции `validateOp` (это уже покрыто validate.test.ts). Отклонённая
// операция не должна портить остальную сессию соединения (REQ-024 кр. 1).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T-011 — REQ-004: команда `setPhase` по реальному WS-соединению.
// Контракт `command`/`commandResult`/`meta` — docs/spec/protocol.md § 4–5;
// необратимость `collect` и матрица роль/фаза — docs/security/permissions.md.
// `apps/server/src/boards/service.ts` (кроме сигнатур `createBoard`/
// `joinByLink`, уже используемых выше в этом файле) не читался — только
// протокол определяет ожидаемые reason/ok здесь.
// ---------------------------------------------------------------------------

describe("REQ-004: смена фазы доски через WS-команду setPhase", () => {
  it("REQ-004 кр.1/кр.3: owner может переключить фазу из collect на group — commandResult ok, всем рассылается meta с новой фазой", async () => {
    const { boardId, ownerId } = await newBoardWithOwner();
    const ws = await connect(boardId);
    const reader = messageReader(ws);

    sendHello(ws, { guestId: ownerId, displayName: "Owner", actorId: newActorId() });
    const welcome = await reader.next();
    expect(welcome.type).toBe("welcome");

    ws.send(
      JSON.stringify({
        type: "command",
        id: "cmd-1",
        command: { type: "setPhase", phase: "group" },
      }),
    );

    // commandResult и meta оба приходят автору; порядок между ними протоколом
    // не гарантирован (§ 5 не фиксирует последовательность двух разных типов
    // сообщений), поэтому читаем оба следующих сообщения и сортируем по типу.
    const first = await reader.next();
    const second = await reader.next();
    const commandResult = [first, second].find((msg) => msg.type === "commandResult");
    const meta = [first, second].find((msg) => msg.type === "meta");

    expect(commandResult?.type).toBe("commandResult");
    if (commandResult?.type !== "commandResult") throw new Error("expected commandResult");
    expect(commandResult.id).toBe("cmd-1");
    expect(commandResult.ok).toBe(true);

    expect(meta?.type).toBe("meta");
    if (meta?.type !== "meta") throw new Error("expected meta broadcast");
    expect(meta.meta.phase).toBe("group");

    ws.close();
  });

  it("REQ-004 кр.2: попытка вернуть фазу в collect после ухода из неё отклоняется как irreversible_phase", async () => {
    const { boardId, ownerId } = await newBoardWithOwner();
    const ws = await connect(boardId);
    const reader = messageReader(ws);

    sendHello(ws, { guestId: ownerId, displayName: "Owner", actorId: newActorId() });
    const welcome = await reader.next();
    expect(welcome.type).toBe("welcome");

    // Уходим из collect один раз — доска теперь никогда не сможет туда вернуться.
    ws.send(
      JSON.stringify({
        type: "command",
        id: "cmd-leave-collect",
        command: { type: "setPhase", phase: "group" },
      }),
    );
    // Дренируем commandResult + meta от первого перехода, не полагаясь на порядок.
    await reader.next();
    await reader.next();

    ws.send(
      JSON.stringify({
        type: "command",
        id: "cmd-back-to-collect",
        command: { type: "setPhase", phase: "collect" },
      }),
    );
    const rejected = await reader.next();

    expect(rejected.type).toBe("commandResult");
    if (rejected.type !== "commandResult") throw new Error("expected commandResult");
    expect(rejected.id).toBe("cmd-back-to-collect");
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toBe("irreversible_phase");

    ws.close();
  });

  it("REQ-004 кр.4: participant не может сменить фазу доски — commandResult ok:false, reason forbidden", async () => {
    const { boardId, participantLink } = await newBoardWithOwner();
    const participantId = newGuestId();
    const joined = await joinByLink(db, {
      linkToken: participantLink,
      guestId: participantId,
      displayName: "Alice",
    });
    expect(joined?.role).toBe("participant");

    const ws = await connect(boardId);
    const reader = messageReader(ws);
    sendHello(ws, { guestId: participantId, displayName: "Alice", actorId: newActorId() });
    const welcome = await reader.next();
    expect(welcome.type).toBe("welcome");
    if (welcome.type !== "welcome") throw new Error("expected welcome");
    expect(welcome.role).toBe("participant");

    ws.send(
      JSON.stringify({
        type: "command",
        id: "cmd-forbidden",
        command: { type: "setPhase", phase: "group" },
      }),
    );
    const result = await reader.next();

    expect(result.type).toBe("commandResult");
    if (result.type !== "commandResult") throw new Error("expected commandResult");
    expect(result.id).toBe("cmd-forbidden");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("forbidden");

    ws.close();
  });
});

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

// ---------------------------------------------------------------------------
// T-012 — «Голоса: лимит и сброс (V7)»: приёмочные тесты через реальный WS +
// Postgres, написанные ДО реализации и не глядя в неё (docs/spec/
// requirements.md REQ-014, REQ-015 (кр. 2, 6), REQ-016;
// docs/spec/consistency-model.md § 7 правило V7, § 8 I6;
// docs/spec/protocol.md § 4 command `resetVotes`, § 5 reason `vote_limit`/
// `not_own_vote`). `apps/server/src/boards/service.ts` (кроме уже
// используемых выше `createBoard`/`joinByLink`) и `ws/gateway.ts` не
// читались — только протокол/CLAUDE.md/permissions.md определяют ожидаемое
// поведение ниже (по аналогии с T-011 setPhase-тестами выше в этом файле).
//
// `vote()` (`@retro/crdt`) не пишет `Stamp` в `Vote` — на проводе у голосов
// нет `stamp` (`packages/protocol/src/wire.ts` `voteSchema`), поэтому для
// первого голоса свежего актора можно смело брать `vote(empty(), ...)`:
// таргет проверяется сервером через V3 (существование сущности), не через
// локально переданное состояние.
// ---------------------------------------------------------------------------

/** Создаёт доску с owner'ом и заданным лимитом голосов, возвращает обе ссылки-приглашения. */
async function newBoardWithLinks(voteLimit: number): Promise<{
  boardId: string;
  ownerId: string;
  participantLink: string;
  viewerLink: string;
}> {
  const ownerId = newGuestId();
  const created = await createBoard(db, {
    title: "T-012 test board",
    displayName: "Owner",
    voteLimit,
    ownerId,
  });
  const viewerLink = (created as { viewerLink?: string }).viewerLink;
  if (!viewerLink) throw new Error("createBoard did not return viewerLink");
  return {
    boardId: created.boardId,
    ownerId,
    participantLink: created.participantLink,
    viewerLink,
  };
}

/** Owner создаёт один стикер и переводит доску в фазу `vote`. Возвращает id стикера. */
async function ownerCreatesStickerAndEntersVotePhase(
  boardId: string,
  ownerId: string,
): Promise<EntityId> {
  const ws = await connect(boardId);
  const reader = messageReader(ws);
  const actorId = newActorId();
  sendHello(ws, { guestId: ownerId, displayName: "Owner", actorId });
  const welcome = await reader.next();
  expect(welcome.type).toBe("welcome");

  const created = createSticker(empty(), newClock(actorId), {
    column: "start",
    frac: "1",
    text: "vote me",
    color: "yellow",
  });
  ws.send(JSON.stringify({ type: "op", delta: toWire(created.delta) }));
  const ack = await reader.next();
  expect(ack.type).toBe("ack");

  ws.send(
    JSON.stringify({
      type: "command",
      id: "cmd-enter-vote",
      command: { type: "setPhase", phase: "vote" },
    }),
  );
  // commandResult и meta приходят в неопределённом порядке (как в T-011 setPhase-тестах выше).
  const first = await reader.next();
  const second = await reader.next();
  const commandResult = [first, second].find((msg) => msg.type === "commandResult");
  expect(commandResult?.ok).toBe(true);

  ws.close();
  return dotKey(created.dot) as EntityId;
}

describe("REQ-015 (кр. 1, 2): голосование до лимита и отказ сверх лимита", () => {
  it("REQ-014/REQ-015 кр.1-2: participant с voteLimit=1 голосует один раз (ack), второй раз — reject vote_limit", async () => {
    const { boardId, ownerId, participantLink } = await newBoardWithLinks(1);
    const stickerId = await ownerCreatesStickerAndEntersVotePhase(boardId, ownerId);

    const participantId = newGuestId();
    const joined = await joinByLink(db, {
      linkToken: participantLink,
      guestId: participantId,
      displayName: "Voter",
    });
    expect(joined?.role).toBe("participant");

    const ws = await connect(boardId);
    const reader = messageReader(ws);
    const actorId = newActorId();
    sendHello(ws, { guestId: participantId, displayName: "Voter", actorId });
    const welcome = await reader.next();
    expect(welcome.type).toBe("welcome");
    if (welcome.type !== "welcome") throw new Error("expected welcome");
    const voterToken = welcome.voterToken;

    const firstVote = vote(empty(), newClock(actorId), stickerId, voterToken);
    ws.send(JSON.stringify({ type: "op", delta: toWire(firstVote.delta) }));
    const firstResult = await reader.next();
    expect(firstResult.type).toBe("ack");
    if (firstResult.type !== "ack") throw new Error("expected ack for first vote");
    expect(firstResult.dot).toEqual(firstVote.dot);

    const secondVote = vote(empty(), firstVote.clock, stickerId, voterToken);
    ws.send(JSON.stringify({ type: "op", delta: toWire(secondVote.delta) }));
    const secondResult = await reader.next();
    expect(secondResult.type).toBe("reject");
    if (secondResult.type !== "reject") throw new Error("expected reject for second vote");
    expect(secondResult.dot).toEqual(secondVote.dot);
    expect(secondResult.reason).toBe("vote_limit");
    expect(secondResult.message.length).toBeGreaterThan(0);

    ws.close();
  });
});

describe("REQ-015 (кр. 6, I6): лимит голосов держится под конкурентными vote из двух вкладок одного участника", () => {
  it("REQ-015 кр.6/I6: две вкладки одного guestId с voteLimit=1 голосуют одновременно — ровно одна принята (ack), другая отклонена (vote_limit)", async () => {
    const { boardId, ownerId, participantLink } = await newBoardWithLinks(1);
    const stickerId = await ownerCreatesStickerAndEntersVotePhase(boardId, ownerId);

    const participantId = newGuestId();
    const joined = await joinByLink(db, {
      linkToken: participantLink,
      guestId: participantId,
      displayName: "TwoTabs",
    });
    expect(joined?.role).toBe("participant");

    const wsTab1 = await connect(boardId);
    const wsTab2 = await connect(boardId);
    const readerTab1 = messageReader(wsTab1);
    const readerTab2 = messageReader(wsTab2);

    const actorTab1 = newActorId();
    const actorTab2 = newActorId();
    sendHello(wsTab1, { guestId: participantId, displayName: "TwoTabs", actorId: actorTab1 });
    sendHello(wsTab2, { guestId: participantId, displayName: "TwoTabs", actorId: actorTab2 });

    const welcomeTab1 = await readerTab1.next();
    const welcomeTab2 = await readerTab2.next();
    expect(welcomeTab1.type).toBe("welcome");
    expect(welcomeTab2.type).toBe("welcome");
    if (welcomeTab1.type !== "welcome" || welcomeTab2.type !== "welcome") {
      throw new Error("expected welcome on both tabs");
    }
    // Один и тот же guestId => один и тот же voterToken на обеих вкладках
    // (docs/spec/protocol.md § 2: voterToken = HMAC(secret, boardId + guestId)),
    // это то, что вообще делает "лимит на пользователя, не на вкладку" проверяемым.
    expect(welcomeTab1.voterToken).toBe(welcomeTab2.voterToken);
    const voterToken = welcomeTab1.voterToken;

    // Два независимых актора (разные вкладки) голосуют за один и тот же
    // стикер практически одновременно — оба сообщения уходят до получения
    // любого ответа, чтобы не гарантировать порядок вручную.
    const voteTab1 = vote(empty(), newClock(actorTab1), stickerId, voterToken);
    const voteTab2 = vote(empty(), newClock(actorTab2), stickerId, voterToken);
    wsTab1.send(JSON.stringify({ type: "op", delta: toWire(voteTab1.delta) }));
    wsTab2.send(JSON.stringify({ type: "op", delta: toWire(voteTab2.delta) }));

    // "Следующий ack/reject" для каждой вкладки — а не буквально "следующее
    // сообщение": проигравшая вкладка вдобавок получает op-рассылку голоса
    // победившей (см. REQ-022 тесты выше, nextOfType пропускает её).
    const resultTab1 = await nextOfType(readerTab1, ["ack", "reject"] as const);
    const resultTab2 = await nextOfType(readerTab2, ["ack", "reject"] as const);
    const results = [resultTab1, resultTab2];

    const acks = results.filter((msg) => msg.type === "ack");
    const rejects = results.filter((msg) => msg.type === "reject");
    expect(acks).toHaveLength(1);
    expect(rejects).toHaveLength(1);
    const [reject] = rejects;
    if (reject?.type !== "reject") throw new Error("expected exactly one reject");
    expect(reject.reason).toBe("vote_limit");

    wsTab1.close();
    wsTab2.close();
  });
});

describe("REQ-016: сброс голосов доступен только owner/facilitator", () => {
  it("REQ-016 кр.2: participant не может сбросить голоса — commandResult ok:false, forbidden", async () => {
    const { boardId, ownerId, participantLink } = await newBoardWithLinks(3);
    await ownerCreatesStickerAndEntersVotePhase(boardId, ownerId);

    const participantId = newGuestId();
    await joinByLink(db, {
      linkToken: participantLink,
      guestId: participantId,
      displayName: "Alice",
    });

    const ws = await connect(boardId);
    const reader = messageReader(ws);
    sendHello(ws, { guestId: participantId, displayName: "Alice", actorId: newActorId() });
    const welcome = await reader.next();
    expect(welcome.type).toBe("welcome");

    ws.send(
      JSON.stringify({
        type: "command",
        id: "cmd-reset-forbidden",
        command: { type: "resetVotes" },
      }),
    );
    const result = await reader.next();
    expect(result.type).toBe("commandResult");
    if (result.type !== "commandResult") throw new Error("expected commandResult");
    expect(result.id).toBe("cmd-reset-forbidden");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("forbidden");

    ws.close();
  });

  it("REQ-016 кр.2: viewer не может сбросить голоса — commandResult ok:false, forbidden", async () => {
    const { boardId, ownerId, viewerLink } = await newBoardWithLinks(3);
    await ownerCreatesStickerAndEntersVotePhase(boardId, ownerId);

    const viewerId = newGuestId();
    const joined = await joinByLink(db, {
      linkToken: viewerLink,
      guestId: viewerId,
      displayName: "Bob",
    });
    expect(joined?.role).toBe("viewer");

    const ws = await connect(boardId);
    const reader = messageReader(ws);
    sendHello(ws, { guestId: viewerId, displayName: "Bob", actorId: newActorId() });
    const welcome = await reader.next();
    expect(welcome.type).toBe("welcome");

    ws.send(
      JSON.stringify({ type: "command", id: "cmd-reset-viewer", command: { type: "resetVotes" } }),
    );
    const result = await reader.next();
    expect(result.type).toBe("commandResult");
    if (result.type !== "commandResult") throw new Error("expected commandResult");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("forbidden");

    ws.close();
  });
});

describe("REQ-016: сброс голосов освобождает лимит всех участников", () => {
  it("REQ-016 кр.1: owner сбрасывает голоса — исчерпавший лимит participant снова может голосовать, unvote-op рассылается всем подписчикам включая инициатора", async () => {
    const { boardId, ownerId, participantLink } = await newBoardWithLinks(1);
    const stickerId = await ownerCreatesStickerAndEntersVotePhase(boardId, ownerId);

    const participantId = newGuestId();
    const joined = await joinByLink(db, {
      linkToken: participantLink,
      guestId: participantId,
      displayName: "Exhausted",
    });
    expect(joined?.role).toBe("participant");

    const wsOwner = await connect(boardId);
    const wsParticipant = await connect(boardId);
    const readerOwner = messageReader(wsOwner);
    const readerParticipant = messageReader(wsParticipant);

    const ownerActorId = newActorId();
    const participantActorId = newActorId();
    sendHello(wsOwner, { guestId: ownerId, displayName: "Owner", actorId: ownerActorId });
    sendHello(wsParticipant, {
      guestId: participantId,
      displayName: "Exhausted",
      actorId: participantActorId,
    });
    const welcomeOwner = await readerOwner.next();
    const welcomeParticipant = await readerParticipant.next();
    expect(welcomeOwner.type).toBe("welcome");
    expect(welcomeParticipant.type).toBe("welcome");
    if (welcomeParticipant.type !== "welcome") throw new Error("expected welcome");
    const voterToken = welcomeParticipant.voterToken;

    // Тратим единственный голос (voteLimit=1).
    const firstVote = vote(empty(), newClock(participantActorId), stickerId, voterToken);
    wsParticipant.send(JSON.stringify({ type: "op", delta: toWire(firstVote.delta) }));
    const firstAck = await readerParticipant.next();
    expect(firstAck.type).toBe("ack");
    if (firstAck.type !== "ack") throw new Error("expected ack");

    // Owner подписан на доску и не автор этой операции — до resetVotes он
    // уже получает op-рассылку firstVote (protocol.md § 6). Если её не
    // прочитать здесь явно, она останется в очереди перед сообщениями
    // resetVotes ниже и собьёт последующий поиск commandResult (см. REQ-022
    // тесты выше — та же причина).
    const ownerSeesFirstVote = await readerOwner.next();
    expect(ownerSeesFirstVote.type).toBe("op");
    if (ownerSeesFirstVote.type !== "op") throw new Error("expected op broadcast of firstVote");
    expect(ownerSeesFirstVote.delta.votes[0]?.dot).toEqual(firstVote.dot);

    // Подтверждаем, что лимит действительно исчерпан.
    const secondVote = vote(empty(), firstVote.clock, stickerId, voterToken);
    wsParticipant.send(JSON.stringify({ type: "op", delta: toWire(secondVote.delta) }));
    const exhausted = await readerParticipant.next();
    expect(exhausted.type).toBe("reject");
    if (exhausted.type !== "reject") throw new Error("expected reject before reset");
    expect(exhausted.reason).toBe("vote_limit");

    // Owner сбрасывает голоса доски.
    wsOwner.send(
      JSON.stringify({ type: "command", id: "cmd-reset", command: { type: "resetVotes" } }),
    );

    // Инициатор получает commandResult ok:true И op-рассылку с unvote своего
    // же действия (§ 6 protocol.md рассылает broadcast всем, включая
    // инициатора — никто ещё не применял эти unvote локально).
    const ownerFirst = await readerOwner.next();
    const ownerSecond = await readerOwner.next();
    const ownerCommandResult = [ownerFirst, ownerSecond].find((m) => m.type === "commandResult");
    const ownerOp = [ownerFirst, ownerSecond].find((m) => m.type === "op");
    expect(ownerCommandResult?.type).toBe("commandResult");
    if (ownerCommandResult?.type !== "commandResult") throw new Error("expected commandResult");
    expect(ownerCommandResult.id).toBe("cmd-reset");
    expect(ownerCommandResult.ok).toBe(true);
    expect(ownerOp?.type).toBe("op");
    if (ownerOp?.type !== "op") throw new Error("expected op broadcast to initiator");
    expect(ownerOp.delta.unvotes).toHaveLength(1);
    expect(ownerOp.delta.unvotes[0]?.dot).toEqual(firstVote.dot);
    expect(ownerOp.delta.unvotes[0]?.target).toBe(stickerId);

    // Участник (не инициатор) тоже получает op-рассылку с тем же unvote.
    const participantOp = await readerParticipant.next();
    expect(participantOp.type).toBe("op");
    if (participantOp.type !== "op") throw new Error("expected op broadcast to participant");
    expect(participantOp.delta.unvotes).toHaveLength(1);
    expect(participantOp.delta.unvotes[0]?.dot).toEqual(firstVote.dot);

    // После сброса лимит снова доступен: тот же участник может проголосовать заново.
    const thirdVote = vote(empty(), secondVote.clock, stickerId, voterToken);
    wsParticipant.send(JSON.stringify({ type: "op", delta: toWire(thirdVote.delta) }));
    const afterReset = await readerParticipant.next();
    expect(afterReset.type).toBe("ack");
    if (afterReset.type !== "ack") throw new Error("expected ack after resetVotes freed the limit");
    expect(afterReset.dot).toEqual(thirdVote.dot);

    wsOwner.close();
    wsParticipant.close();
  });
});

// ---------------------------------------------------------------------------
// REQ-022 — почему два теста T-012 выше («две вкладки... I6» и «owner
// сбрасывает голоса...») в принципе могут прочитать НЕ тот тип сообщения,
// какой ждут первым: протокол рассылает `op` ВСЕМ подписчикам доски, кроме
// автора операции (docs/spec/protocol.md § 6 «Операция»: «остальным — op в
// их проекции»). Подписчик, который сам ничего не отправлял (или ждёт свой
// ack/reject), может получить чужой `op` первым или вперемешку со своим
// ответом — в том числе от ДРУГОЙ вкладки того же guestId, потому что это
// два разных WS-соединения (два разных actorId), оба подписаны на доску.
//
// Тесты ниже НЕ про баг реализации — они зелёные и подтверждают, что
// рассылка действительно работает как специфицировано. Они объясняют, какое
// предположение молчаливо делают соседние тесты T-012 (читают ровно одно
// следующее сообщение и считают его своим ack/reject), не учитывая лишние
// сообщения из общей подписки на доску. Сами эти тесты не исправляются
// здесь — отдельный следующий шаг.
// ---------------------------------------------------------------------------

describe("REQ-022: op-рассылка чужой операции доходит до подписчика независимо от того, ждёт ли он свой ack/reject", () => {
  it("REQ-022: участник A, который ничего не отправлял, получает op-рассылку голоса участника B той же доски", async () => {
    const { boardId, ownerId, participantLink } = await newBoardWithLinks(3);
    const stickerId = await ownerCreatesStickerAndEntersVotePhase(boardId, ownerId);

    const guestA = newGuestId();
    const guestB = newGuestId();
    await joinByLink(db, { linkToken: participantLink, guestId: guestA, displayName: "A" });
    await joinByLink(db, { linkToken: participantLink, guestId: guestB, displayName: "B" });

    const wsA = await connect(boardId);
    const wsB = await connect(boardId);
    const readerA = messageReader(wsA);
    const readerB = messageReader(wsB);

    const actorA = newActorId();
    const actorB = newActorId();
    sendHello(wsA, { guestId: guestA, displayName: "A", actorId: actorA });
    sendHello(wsB, { guestId: guestB, displayName: "B", actorId: actorB });
    const welcomeA = await readerA.next();
    const welcomeB = await readerB.next();
    expect(welcomeA.type).toBe("welcome");
    expect(welcomeB.type).toBe("welcome");
    if (welcomeA.type !== "welcome" || welcomeB.type !== "welcome") {
      throw new Error("expected welcome on both connections");
    }

    // A голосует и дожидается своего ack — A теперь "в покое": ничего больше
    // не отправляет и ничего своего не ждёт.
    const voteA = vote(empty(), newClock(actorA), stickerId, welcomeA.voterToken);
    wsA.send(JSON.stringify({ type: "op", delta: toWire(voteA.delta) }));
    const ackA = await readerA.next();
    expect(ackA.type).toBe("ack");

    // B голосует за тот же стикер. A ничего не отправлял в этот момент — но
    // A подписан на доску, поэтому первое, что A увидит дальше, — это именно
    // op-рассылка голоса B, а не что-либо относящееся к собственному действию A.
    const voteB = vote(empty(), newClock(actorB), stickerId, welcomeB.voterToken);
    wsB.send(JSON.stringify({ type: "op", delta: toWire(voteB.delta) }));

    const nextForA = await readerA.next();
    expect(nextForA.type).toBe("op");
    if (nextForA.type !== "op") throw new Error("expected op broadcast of B's vote to A");
    expect(nextForA.delta.votes).toHaveLength(1);
    expect(nextForA.delta.votes[0]?.dot).toEqual(voteB.dot);
    expect(nextForA.delta.votes[0]?.target).toBe(stickerId);

    wsA.close();
    wsB.close();
  });

  it("REQ-022: другая вкладка того же guestId тоже получает op-рассылку голоса первой вкладки — broadcast идёт всем прочим подписчикам доски, не только «чужим» участникам", async () => {
    const { boardId, ownerId, participantLink } = await newBoardWithLinks(3);
    const stickerId = await ownerCreatesStickerAndEntersVotePhase(boardId, ownerId);

    const guestId = newGuestId();
    const joined = await joinByLink(db, {
      linkToken: participantLink,
      guestId,
      displayName: "TwoTabs",
    });
    expect(joined?.role).toBe("participant");

    const wsTab1 = await connect(boardId);
    const wsTab2 = await connect(boardId);
    const readerTab1 = messageReader(wsTab1);
    const readerTab2 = messageReader(wsTab2);

    const actorTab1 = newActorId();
    const actorTab2 = newActorId();
    sendHello(wsTab1, { guestId, displayName: "TwoTabs", actorId: actorTab1 });
    sendHello(wsTab2, { guestId, displayName: "TwoTabs", actorId: actorTab2 });
    const welcomeTab1 = await readerTab1.next();
    const welcomeTab2 = await readerTab2.next();
    expect(welcomeTab1.type).toBe("welcome");
    expect(welcomeTab2.type).toBe("welcome");
    if (welcomeTab1.type !== "welcome") throw new Error("expected welcome on tab 1");

    // Только вкладка 1 голосует; вкладка 2 в этот момент ничего не отправляла
    // и ничего своего не ждёт — она "просто подписана" на доску, как в
    // существующих тестах T-012 выше (readerTab1/readerTab2 на две вкладки
    // одного участника).
    const voteTab1 = vote(empty(), newClock(actorTab1), stickerId, welcomeTab1.voterToken);
    wsTab1.send(JSON.stringify({ type: "op", delta: toWire(voteTab1.delta) }));

    // Вкладка 1 (автор операции) получает свой ack.
    const ackTab1 = await readerTab1.next();
    expect(ackTab1.type).toBe("ack");
    if (ackTab1.type !== "ack") throw new Error("expected ack for tab 1's own vote");
    expect(ackTab1.dot).toEqual(voteTab1.dot);

    // Вкладка 2 — другое WS-соединение (другой actorId) того же guestId,
    // тоже подписанное на доску: она получает op-рассылку голоса вкладки 1,
    // хотя формально это "тот же участник" — рассылка не делает исключения
    // для других соединений того же guestId.
    const opForTab2 = await readerTab2.next();
    expect(opForTab2.type).toBe("op");
    if (opForTab2.type !== "op") {
      throw new Error("expected op broadcast of tab 1's vote to tab 2 of the same guest");
    }
    expect(opForTab2.delta.votes).toHaveLength(1);
    expect(opForTab2.delta.votes[0]?.dot).toEqual(voteTab1.dot);
    expect(opForTab2.delta.votes[0]?.target).toBe(stickerId);

    wsTab1.close();
    wsTab2.close();
  });
});

// ---------------------------------------------------------------------------
// ADR-0008 — `unvote.dot` в проводном формате это dot ОТЗЫВАЕМОГО голоса
// (`vd`, чужая более ранняя операция `vote`), а не собственный dot операции
// отзыва (docs/spec/consistency-model.md § 3.1, § 7 V1/V7). Два связанных
// бага, найденные code-review T-012 (docs/adr/0008-…md), ещё не исправлены:
//
// 1. V1 ошибочно требует `vd.actor = connectionActorId` — отзыв голоса из
//    другой вкладки того же участника (другой actorId, тот же guestId) или
//    после перезагрузки страницы (тоже новый actorId) отклоняется как
//    `stale_dot`, хотя принадлежность голоса должна проверяться по
//    `voterToken` (V7 `checkVoteOwnership`, T-012), а не по actorId
//    соединения (REQ-015 кр. 4, REQ-002 кр. 2).
// 2. Повторная отправка уже применённого `unvote` (тот же `(vd, target)`,
//    независимо от того, кто его инициировал — тот же клиент повторно или
//    сервер через `resetVotes`) должна быть идемпотентным `ack` с `seq`
//    уже существующей записи журнала (REQ-023 кр. 3), а не `reject
//    not_own_vote`.
//
// Тесты ниже написаны ДО исправления реализации — они должны падать именно
// из-за этих багов, не из-за самого теста. `apps/server/src/ws/gateway.ts`,
// `apps/server/src/ops/validate.ts`, `apps/server/src/ops/votes.ts`,
// `apps/server/src/ops/log.ts` не читались — контракт целиком из
// `docs/adr/0008-…md`, `docs/spec/consistency-model.md` § 7,
// `docs/spec/protocol.md` § 5–6.
// ---------------------------------------------------------------------------

describe("ADR-0008: unvote не привязан к actorId соединения — принадлежность по voterToken (V7), не по dot.actor (V1)", () => {
  it("REQ-015 (кр. 4), ADR-0008: голос, отданный в одной вкладке, можно отозвать из другой вкладки того же участника — ack, не reject stale_dot", async () => {
    const { boardId, ownerId, participantLink } = await newBoardWithLinks(3);
    const stickerId = await ownerCreatesStickerAndEntersVotePhase(boardId, ownerId);

    const participantId = newGuestId();
    const joined = await joinByLink(db, {
      linkToken: participantLink,
      guestId: participantId,
      displayName: "TwoTabs",
    });
    expect(joined?.role).toBe("participant");

    const wsTab1 = await connect(boardId);
    const readerTab1 = messageReader(wsTab1);
    const actorTab1 = newActorId();
    sendHello(wsTab1, { guestId: participantId, displayName: "TwoTabs", actorId: actorTab1 });
    const welcomeTab1 = await readerTab1.next();
    expect(welcomeTab1.type).toBe("welcome");
    if (welcomeTab1.type !== "welcome") throw new Error("expected welcome on tab 1");
    const voterToken = welcomeTab1.voterToken;

    const votedTab1 = vote(empty(), newClock(actorTab1), stickerId, voterToken);
    wsTab1.send(JSON.stringify({ type: "op", delta: toWire(votedTab1.delta) }));
    const ackVote = await readerTab1.next();
    expect(ackVote.type).toBe("ack");

    // Вторая вкладка того же участника — другой actorId, тот же guestId и,
    // значит, тот же voterToken (протокол.md § 2: voterToken = HMAC(secret,
    // boardId + guestId)).
    const wsTab2 = await connect(boardId);
    const readerTab2 = messageReader(wsTab2);
    const actorTab2 = newActorId();
    sendHello(wsTab2, { guestId: participantId, displayName: "TwoTabs", actorId: actorTab2 });
    const welcomeTab2 = await readerTab2.next();
    expect(welcomeTab2.type).toBe("welcome");
    if (welcomeTab2.type !== "welcome") throw new Error("expected welcome on tab 2");
    expect(welcomeTab2.voterToken).toBe(voterToken);

    const unvoteDelta = unvote(empty(), votedTab1.dot, stickerId);
    wsTab2.send(JSON.stringify({ type: "op", delta: toWire(unvoteDelta) }));
    const result = await nextOfType(readerTab2, ["ack", "reject"] as const);
    expect(result.type).toBe("ack");

    wsTab1.close();
    wsTab2.close();
  });

  it("REQ-002 (кр. 2), ADR-0008: голос, отданный до перезагрузки страницы, можно отозвать новым соединением того же guestId — ack, не reject stale_dot", async () => {
    const { boardId, ownerId, participantLink } = await newBoardWithLinks(3);
    const stickerId = await ownerCreatesStickerAndEntersVotePhase(boardId, ownerId);

    const participantId = newGuestId();
    const joined = await joinByLink(db, {
      linkToken: participantLink,
      guestId: participantId,
      displayName: "Reload",
    });
    expect(joined?.role).toBe("participant");

    const ws1 = await connect(boardId);
    const reader1 = messageReader(ws1);
    const actor1 = newActorId();
    sendHello(ws1, { guestId: participantId, displayName: "Reload", actorId: actor1 });
    const welcome1 = await reader1.next();
    expect(welcome1.type).toBe("welcome");
    if (welcome1.type !== "welcome") throw new Error("expected welcome");
    const voterToken = welcome1.voterToken;

    const voted = vote(empty(), newClock(actor1), stickerId, voterToken);
    ws1.send(JSON.stringify({ type: "op", delta: toWire(voted.delta) }));
    const ackVote = await reader1.next();
    expect(ackVote.type).toBe("ack");

    // Эмулируем перезагрузку страницы: первое соединение закрывается
    // ПОСЛЕДОВАТЕЛЬНО (не параллельно), новое открывается уже после этого,
    // с новым actorId, но тем же guestId.
    await new Promise<void>((resolve) => {
      ws1.on("close", () => resolve());
      ws1.close();
    });

    const ws2 = await connect(boardId);
    const reader2 = messageReader(ws2);
    const actor2 = newActorId();
    sendHello(ws2, { guestId: participantId, displayName: "Reload", actorId: actor2 });
    const welcome2 = await reader2.next();
    expect(welcome2.type).toBe("welcome");
    if (welcome2.type !== "welcome") throw new Error("expected welcome after reconnect");
    expect(welcome2.voterToken).toBe(voterToken);

    const unvoteDelta = unvote(empty(), voted.dot, stickerId);
    ws2.send(JSON.stringify({ type: "op", delta: toWire(unvoteDelta) }));
    const result = await nextOfType(reader2, ["ack", "reject"] as const);
    expect(result.type).toBe("ack");

    ws2.close();
  });

  it("REQ-015 (кр. 4): попытка отозвать чужой голос (другой guestId/voterToken) отклоняется как not_own_vote — checkVoteOwnership (V7, T-012) не должна пострадать от снятия V1 (ADR-0008)", async () => {
    const { boardId, ownerId, participantLink } = await newBoardWithLinks(3);
    const stickerId = await ownerCreatesStickerAndEntersVotePhase(boardId, ownerId);

    const guestA = newGuestId();
    const guestB = newGuestId();
    await joinByLink(db, { linkToken: participantLink, guestId: guestA, displayName: "A" });
    await joinByLink(db, { linkToken: participantLink, guestId: guestB, displayName: "B" });

    const wsA = await connect(boardId);
    const wsB = await connect(boardId);
    const readerA = messageReader(wsA);
    const readerB = messageReader(wsB);

    const actorA = newActorId();
    const actorB = newActorId();
    sendHello(wsA, { guestId: guestA, displayName: "A", actorId: actorA });
    sendHello(wsB, { guestId: guestB, displayName: "B", actorId: actorB });
    const welcomeA = await readerA.next();
    const welcomeB = await readerB.next();
    expect(welcomeA.type).toBe("welcome");
    expect(welcomeB.type).toBe("welcome");
    if (welcomeA.type !== "welcome" || welcomeB.type !== "welcome") {
      throw new Error("expected welcome on both connections");
    }
    expect(welcomeA.voterToken).not.toBe(welcomeB.voterToken);

    const voteA = vote(empty(), newClock(actorA), stickerId, welcomeA.voterToken);
    wsA.send(JSON.stringify({ type: "op", delta: toWire(voteA.delta) }));
    const ackA = await readerA.next();
    expect(ackA.type).toBe("ack");

    // B заявляет dot чужого (A) голоса — минимальная, но реалистичная
    // подделка одного поля (как уже делает validate.test.ts): в реальности
    // B не мог бы узнать чужой dot, здесь это проверка, что сервер не
    // доверяет заявленному dot без проверки владения по voterToken.
    const forgedUnvote = unvote(empty(), voteA.dot, stickerId);
    wsB.send(JSON.stringify({ type: "op", delta: toWire(forgedUnvote) }));
    const resultB = await nextOfType(readerB, ["ack", "reject"] as const);

    expect(resultB.type).toBe("reject");
    if (resultB.type !== "reject") {
      throw new Error("expected reject for unvote of someone else's vote");
    }
    expect(resultB.reason).toBe("not_own_vote");

    wsA.close();
    wsB.close();
  });
});

describe("REQ-023 (кр. 3), ADR-0008: идемпотентность unvote — по паре (dot отзываемого голоса, target) в журнале, не отказ not_own_vote", () => {
  it("REQ-023 (кр. 3), ADR-0008: повторная отправка уже применённого unvote получает ack с тем же seq, не reject not_own_vote", async () => {
    const { boardId, ownerId } = await newBoardWithLinks(3);
    const stickerId = await ownerCreatesStickerAndEntersVotePhase(boardId, ownerId);

    const ws = await connect(boardId);
    const reader = messageReader(ws);
    const actorId = newActorId();
    sendHello(ws, { guestId: ownerId, displayName: "Owner", actorId });
    const welcome = await reader.next();
    expect(welcome.type).toBe("welcome");
    if (welcome.type !== "welcome") throw new Error("expected welcome");

    const voted = vote(empty(), newClock(actorId), stickerId, welcome.voterToken);
    ws.send(JSON.stringify({ type: "op", delta: toWire(voted.delta) }));
    const ackVote = await reader.next();
    expect(ackVote.type).toBe("ack");

    const unvoteDelta = unvote(empty(), voted.dot, stickerId);
    const unvoteMessage = JSON.stringify({ type: "op", delta: toWire(unvoteDelta) });

    ws.send(unvoteMessage);
    const firstUnvoteResult = await reader.next();
    expect(firstUnvoteResult.type).toBe("ack");
    if (firstUnvoteResult.type !== "ack") throw new Error("expected ack for first unvote");

    // Точно то же сообщение (тот же dot отзываемого голоса, та же target) —
    // как после разрыва соединения и повторной отправки очереди (REQ-023 кр. 3).
    ws.send(unvoteMessage);
    const secondUnvoteResult = await reader.next();
    expect(secondUnvoteResult.type).toBe("ack");
    if (secondUnvoteResult.type !== "ack") {
      throw new Error("expected ack for repeated unvote, not a reject");
    }
    expect(secondUnvoteResult.seq).toBe(firstUnvoteResult.seq);

    ws.close();
  });

  it("REQ-016 + ADR-0008: собственный unvote на голос, уже отозванный resetVotes, получает ack с тем же seq, что и unvote-запись resetVotes", async () => {
    const { boardId, ownerId, participantLink } = await newBoardWithLinks(1);
    const stickerId = await ownerCreatesStickerAndEntersVotePhase(boardId, ownerId);

    const participantId = newGuestId();
    const joined = await joinByLink(db, {
      linkToken: participantLink,
      guestId: participantId,
      displayName: "Exhausted",
    });
    expect(joined?.role).toBe("participant");

    const wsOwner = await connect(boardId);
    const wsParticipant = await connect(boardId);
    const readerOwner = messageReader(wsOwner);
    const readerParticipant = messageReader(wsParticipant);

    const ownerActorId = newActorId();
    const participantActorId = newActorId();
    sendHello(wsOwner, { guestId: ownerId, displayName: "Owner", actorId: ownerActorId });
    sendHello(wsParticipant, {
      guestId: participantId,
      displayName: "Exhausted",
      actorId: participantActorId,
    });
    const welcomeOwner = await readerOwner.next();
    const welcomeParticipant = await readerParticipant.next();
    expect(welcomeOwner.type).toBe("welcome");
    expect(welcomeParticipant.type).toBe("welcome");
    if (welcomeParticipant.type !== "welcome") throw new Error("expected welcome");
    const voterToken = welcomeParticipant.voterToken;

    const voted = vote(empty(), newClock(participantActorId), stickerId, voterToken);
    wsParticipant.send(JSON.stringify({ type: "op", delta: toWire(voted.delta) }));
    const ackVote = await readerParticipant.next();
    expect(ackVote.type).toBe("ack");

    // Owner подписан на доску и не автор этой операции — получает op-рассылку
    // голоса участника раньше, чем что-либо связанное с resetVotes ниже (как
    // в T-012 тесте "owner сбрасывает голоса" выше).
    const ownerSeesVote = await readerOwner.next();
    expect(ownerSeesVote.type).toBe("op");

    wsOwner.send(
      JSON.stringify({ type: "command", id: "cmd-reset-e", command: { type: "resetVotes" } }),
    );

    // Участник (не инициатор resetVotes) получает op-рассылку с unvote,
    // сгенерированным resetVotes — нужен именно её seq, чтобы сравнить с
    // seq собственного unvote ниже.
    const participantOp = await nextOfType(readerParticipant, ["op"] as const);
    expect(participantOp.delta.unvotes).toHaveLength(1);
    expect(participantOp.delta.unvotes[0]?.dot).toEqual(voted.dot);
    expect(participantOp.delta.unvotes[0]?.target).toBe(stickerId);
    const resetVoteSeq = participantOp.seq;

    // Дренируем ответ owner'у (commandResult + собственный op), порядок
    // между ними не гарантирован (как в T-012 тесте выше).
    const ownerFirst = await readerOwner.next();
    const ownerSecond = await readerOwner.next();
    const ownerCommandResult = [ownerFirst, ownerSecond].find((m) => m.type === "commandResult");
    expect(ownerCommandResult?.type).toBe("commandResult");
    if (ownerCommandResult?.type !== "commandResult") throw new Error("expected commandResult");
    expect(ownerCommandResult.ok).toBe(true);

    // Тот же участник теперь сам отзывает тот же голос, который уже отозвал
    // resetVotes — желаемое конечное состояние уже достигнуто, это должен
    // быть ack с seq уже существующей записи журнала, не отказ.
    const ownUnvote = unvote(empty(), voted.dot, stickerId);
    wsParticipant.send(JSON.stringify({ type: "op", delta: toWire(ownUnvote) }));
    const ownUnvoteResult = await nextOfType(readerParticipant, ["ack", "reject"] as const);

    expect(ownUnvoteResult.type).toBe("ack");
    if (ownUnvoteResult.type !== "ack") {
      throw new Error("expected ack for own unvote already applied by resetVotes");
    }
    expect(ownUnvoteResult.seq).toBe(resetVoteSeq);

    wsOwner.close();
    wsParticipant.close();
  });
});

// ---------------------------------------------------------------------------
// Находка 6 code-review этого PR: resetVotes писал отзывы по одному вне
// транзакции — сбой посередине (сеть/БД) оставлял доску с частично
// отозванными голосами и без рассылки уже вставленных строк никому.
// Исправлено (см. коммит): appendOp внутри resetVotes выполняется в одной
// транзакции db.transaction(...), рассылка — только после успешного коммита.
// Тест ниже подделывает сбой посередине через временный BEFORE INSERT
// триггер Postgres на ops (никаких хуков в коде продукта, только в тесте) и
// проверяет: транзакция целиком откатилась (ноль новых строк unvote в
// журнале), ни один подписчик не получил рассылку ни для одного из голосов
// (ни отравленного, ни соседнего) — проверяется контрольной операцией сразу
// после неудачной попытки.
// ---------------------------------------------------------------------------

describe("REQ-016: массовый отзыв голосов атомарен — сбой посередине не оставляет доску наполовину сброшенной", () => {
  it("resetVotes: сбой при вставке одного из двух отзывов откатывает оба, рассылки не было", async () => {
    const { boardId, ownerId, participantLink } = await newBoardWithLinks(3);

    // Owner создаёт два стикера и переводит доску в фазу vote (не переиспользуем
    // ownerCreatesStickerAndEntersVotePhase — той нужен ровно один стикер).
    const wsOwner = await connect(boardId);
    const readerOwner = messageReader(wsOwner);
    const ownerActorId = newActorId();
    sendHello(wsOwner, { guestId: ownerId, displayName: "Owner", actorId: ownerActorId });
    const welcomeOwner = await readerOwner.next();
    expect(welcomeOwner.type).toBe("welcome");

    const createdA = createSticker(empty(), newClock(ownerActorId), {
      column: "start",
      frac: "1",
      text: "sticker A",
      color: "yellow",
    });
    wsOwner.send(JSON.stringify({ type: "op", delta: toWire(createdA.delta) }));
    expect((await readerOwner.next()).type).toBe("ack");
    const stickerA = dotKey(createdA.dot) as EntityId;

    const createdB = createSticker(empty(), createdA.clock, {
      column: "start",
      frac: "2",
      text: "sticker B",
      color: "blue",
    });
    wsOwner.send(JSON.stringify({ type: "op", delta: toWire(createdB.delta) }));
    expect((await readerOwner.next()).type).toBe("ack");
    const stickerB = dotKey(createdB.dot) as EntityId;

    wsOwner.send(
      JSON.stringify({
        type: "command",
        id: "cmd-enter-vote",
        command: { type: "setPhase", phase: "vote" },
      }),
    );
    // setPhase рассылает meta всем подписчикам (в т.ч. инициатору) отдельным
    // сообщением от commandResult, порядок между ними не гарантирован —
    // читаем и отбрасываем оба (как ownerCreatesStickerAndEntersVotePhase выше).
    const enterVoteFirst = await readerOwner.next();
    const enterVoteSecond = await readerOwner.next();
    const enterVoteResult = [enterVoteFirst, enterVoteSecond].find(
      (m) => m.type === "commandResult",
    );
    expect(enterVoteResult?.type).toBe("commandResult");
    if (enterVoteResult?.type !== "commandResult") throw new Error("expected commandResult");
    expect(enterVoteResult.ok).toBe(true);

    // Два участника — каждый голосует за свой стикер.
    const participant1 = newGuestId();
    const participant2 = newGuestId();
    await joinByLink(db, { linkToken: participantLink, guestId: participant1, displayName: "P1" });
    await joinByLink(db, { linkToken: participantLink, guestId: participant2, displayName: "P2" });

    const ws1 = await connect(boardId);
    const ws2 = await connect(boardId);
    const reader1 = messageReader(ws1);
    const reader2 = messageReader(ws2);
    const actor1 = newActorId();
    const actor2 = newActorId();
    sendHello(ws1, { guestId: participant1, displayName: "P1", actorId: actor1 });
    sendHello(ws2, { guestId: participant2, displayName: "P2", actorId: actor2 });
    const welcome1 = await reader1.next();
    const welcome2 = await reader2.next();
    expect(welcome1.type).toBe("welcome");
    expect(welcome2.type).toBe("welcome");
    if (welcome1.type !== "welcome" || welcome2.type !== "welcome") {
      throw new Error("expected welcome on both participant connections");
    }

    // Owner, P1 и P2 все три подписаны на доску к этому моменту — каждый
    // голос рассылается ОБОИМ прочим подписчикам (не только owner'у),
    // поэтому дренируем обе оставшиеся очереди после каждого голоса.
    const vote1 = vote(empty(), newClock(actor1), stickerA, welcome1.voterToken);
    ws1.send(JSON.stringify({ type: "op", delta: toWire(vote1.delta) }));
    expect((await reader1.next()).type).toBe("ack");
    expect((await readerOwner.next()).type).toBe("op");
    expect((await reader2.next()).type).toBe("op");

    const vote2 = vote(empty(), newClock(actor2), stickerB, welcome2.voterToken);
    ws2.send(JSON.stringify({ type: "op", delta: toWire(vote2.delta) }));
    expect((await reader2.next()).type).toBe("ack");
    expect((await readerOwner.next()).type).toBe("op");
    expect((await reader1.next()).type).toBe("op");

    // Временный триггер: любая вставка в ops с unvotes[0].target = stickerB
    // проваливается — имитирует сбой БД/сети посередине массового отзыва.
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_poison_unvote() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.delta -> 'unvotes' -> 0 ->> 'target' = '${stickerB}' THEN
          RAISE EXCEPTION 'injected test failure for resetVotes atomicity test';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await pool.query(`
      CREATE TRIGGER test_poison_unvote_trigger
      BEFORE INSERT ON ops
      FOR EACH ROW EXECUTE FUNCTION test_poison_unvote();
    `);

    try {
      wsOwner.send(
        JSON.stringify({
          type: "command",
          id: "cmd-reset-atomic",
          command: { type: "resetVotes" },
        }),
      );

      // Транзакция падает внутри обработчика — это необработанное исключение
      // (как "board unexpectedly not found" в других местах этого файла),
      // owner получает error и соединение закрывается.
      const ownerResult = await readerOwner.next();
      expect(ownerResult.type).toBe("error");

      // Ни один из двух участников не должен был получить op-рассылку —
      // транзакция целиком откатилась ДО первого broadcast (рассылка в коде
      // происходит только после успешного commit). Контрольная операция от
      // owner'а (через новое соединение — старое закрыто сервером после
      // error) должна быть ПЕРВЫМ, что видят оба участника дальше.
      const wsOwner2 = await connect(boardId);
      const readerOwner2 = messageReader(wsOwner2);
      const ownerActorId2 = newActorId();
      sendHello(wsOwner2, { guestId: ownerId, displayName: "Owner", actorId: ownerActorId2 });
      expect((await readerOwner2.next()).type).toBe("welcome");

      const canary = createSticker(empty(), newClock(ownerActorId2), {
        column: "stop",
        frac: "1",
        text: "canary after failed resetVotes",
        color: "green",
      });
      wsOwner2.send(JSON.stringify({ type: "op", delta: toWire(canary.delta) }));
      expect((await readerOwner2.next()).type).toBe("ack");

      const canaryId = dotKey(canary.dot);
      const nextForP1 = await reader1.next();
      expect(nextForP1.type).toBe("op");
      if (nextForP1.type !== "op") throw new Error("expected op broadcast for P1");
      expect(nextForP1.delta.created[0]?.id).toBe(canaryId);

      const nextForP2 = await reader2.next();
      expect(nextForP2.type).toBe("op");
      if (nextForP2.type !== "op") throw new Error("expected op broadcast for P2");
      expect(nextForP2.delta.created[0]?.id).toBe(canaryId);

      // Прямая проверка журнала: ноль строк с unvotes для этой доски —
      // транзакция откатилась целиком, а не вставила первую и упала на второй.
      const rows = await db
        .select({ delta: schema.ops.delta })
        .from(schema.ops)
        .where(eq(schema.ops.boardId, boardId));
      const unvoteRows = rows.filter((r) => r.delta.unvotes.length > 0);
      expect(unvoteRows).toHaveLength(0);

      wsOwner2.close();
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS test_poison_unvote_trigger ON ops;");
      await pool.query("DROP FUNCTION IF EXISTS test_poison_unvote();");
    }

    ws1.close();
    ws2.close();
  });
});

// ---------------------------------------------------------------------------
// fix/T-011-op-single-entity — находка независимого /code-review (high):
// `apps/server/src/ops/permissions.ts` (`classifyAction`) и
// `apps/server/src/ws/gateway.ts` (`isOwn`) смотрят только на ПЕРВУЮ запись
// дельты, чтобы классифицировать действие и проверить владение; сама схема
// `clientDeltaSchema` (`packages/protocol/src/wire.ts`) сейчас гарантирует
// только «один dot», а не «одна сущность» (docs/spec/consistency-model.md
// § 7 V2, уточнено: «все записи и, если есть, создание — одной и той же
// сущности»; docs/spec/protocol.md § 5 invalid_shape). Клиент может
// склеить в одну дельту записи ДВУХ сущностей под одним (поддельным) dot —
// сервер провалидирует форму, классифицирует действие по первой записи и
// пропустит вторую (чужую) запись без проверки прав.
//
// Тест ниже воспроизводит сценарий 2 из отчёта code-review целиком через
// реальный WS + Postgres: participant прячет `deleted: true` на чужом
// стикере Y внутри своей же честной `createSticker`-дельты, подделывая у
// скрытой записи только dot/stamp (та же минимальная техника подделки
// одного поля на массиве записей, что и в блоке ADR-0008 выше в этом
// файле). Написан ДО исправления — обе проверки ниже (тип ответа и то, что
// Y реально не удалён в журнале) были КРАСНЫМИ до фикса: сервер отвечал
// `ack`, а Y оказывался по-настоящему помечен `deleted` в БД — дыра не
// гипотетическая, а реально работала целиком через протокол.
//
// Уточнение при реализации фикса (моё, не test-author): нарушение V2
// проверяется в `clientDeltaSchema` — части `clientMessageSchema`
// (`packages/protocol/src/messages.ts`), которую `gateway.ts` разбирает
// ДО того, как вообще узнаёт dot операции. Как и три уже существующих
// `.refine` той же схемы («один dot», «unvote не смешан», «supersede — из
// этой дельты»), нарушение формы — это `error` (сообщение целиком отвергнуто,
// соединение закрывается), а не `reject` (отказ конкретной, но по форме
// валидной операции, соединение остаётся) — так это уже работает для любого
// другого нарушения V2 в этом протоколе, не новое поведение.
//
// `apps/server/src/ops/permissions.ts`, `apps/server/src/ws/gateway.ts`,
// `apps/server/src/ops/validate.ts` не читались test-author'ом при написании
// теста — поведение было описано заказчиком теста достаточно точно; тип
// ответа (`error`, не `reject`) уточнён мной по факту прогона после фикса.
// ---------------------------------------------------------------------------

describe("V2 (форма), находка code-review (high): createSticker + скрытое deleted=true на чужой сущности под тем же dot", () => {
  it("REQ-007/REQ-009/REQ-011, V2: participant прячет удаление чужого стикера Y внутри своей createSticker-дельты — сервер отвергает всё сообщение (error invalid_shape) и Y НЕ удаляется", async () => {
    const ownerId = newGuestId();
    const { boardId, participantLink } = await createBoard(db, {
      title: "V2 hole — hidden delete of another entity",
      displayName: "Owner",
      voteLimit: 3,
      ownerId,
    });

    // Owner создаёт стикер Y обычным путём, в фазе collect (доска только что создана).
    const wsOwner = await connect(boardId);
    const readerOwner = messageReader(wsOwner);
    const ownerActorId = newActorId();
    sendHello(wsOwner, { guestId: ownerId, displayName: "Owner", actorId: ownerActorId });
    expect((await readerOwner.next()).type).toBe("welcome");

    const createdY = createSticker(empty(), newClock(ownerActorId), {
      column: "start",
      frac: "y",
      text: "victim sticker Y",
      color: "yellow",
    });
    wsOwner.send(JSON.stringify({ type: "op", delta: toWire(createdY.delta) }));
    const ackY = await readerOwner.next();
    expect(ackY.type).toBe("ack");
    const stickerY = dotKey(createdY.dot) as EntityId;

    // Участник присоединяется по ссылке — обычная роль participant.
    const attackerId = newGuestId();
    const joined = await joinByLink(db, {
      linkToken: participantLink,
      guestId: attackerId,
      displayName: "Attacker",
    });
    expect(joined?.role).toBe("participant");

    const wsAttacker = await connect(boardId);
    const readerAttacker = messageReader(wsAttacker);
    const attackerActorId = newActorId();
    sendHello(wsAttacker, {
      guestId: attackerId,
      displayName: "Attacker",
      actorId: attackerActorId,
    });
    const welcomeAttacker = await readerAttacker.next();
    expect(welcomeAttacker.type).toBe("welcome");

    // Честная часть дельты: participant создаёт СВОЙ новый стикер — один
    // dot, created + 5 entries, всё про эту новую сущность.
    // `createdY.delta` передаём как локальное "state" только чтобы честно
    // посчитать lamport выше максимума, который уже видел Y (нужно для
    // V4 у скрытой записи ниже) — на форму дельты это не влияет.
    const own = createSticker(createdY.delta, newClock(attackerActorId), {
      column: "stop",
      frac: "a",
      text: "attacker's own sticker",
      color: "pink",
    });

    // Нечестная часть: "как будто" честная deleteEntity(Y) — берём её
    // supersedes (реальный dot создания Y), но dot/stamp записи подменяем
    // на dot/stamp ЧЕСТНОЙ части (own), чтобы вся дельта несла один dot —
    // единственное, что сейчас проверяет clientDeltaSchema (operationDots).
    const del = deleteEntity(createdY.delta, own.clock, stickerY);

    const ownWire = toWire(own.delta);
    const delWire = toWire(del.delta);
    const [victimEntry] = delWire.entries;
    if (!victimEntry) throw new Error("expected deleteEntity to produce exactly one entry");
    const [ownStampSource] = ownWire.entries;
    if (!ownStampSource) throw new Error("expected createSticker to produce entries");

    const forgedDelta: WireDelta = {
      created: ownWire.created,
      entries: [...ownWire.entries, { ...victimEntry, dot: own.dot, stamp: ownStampSource.stamp }],
      supersedes: [...ownWire.supersedes, ...delWire.supersedes],
      votes: [],
      unvotes: [],
    };

    wsAttacker.send(JSON.stringify({ type: "op", delta: forgedDelta }));
    const result = await readerAttacker.next();

    // V2 — форма всего сообщения (clientMessageSchema, packages/protocol),
    // проверяется ДО того, как сервер вообще разбирает dot операции — как и
    // три уже существующих `.refine` той же схемы (один dot, unvote не
    // смешан с другим, supersede — из этой же дельты). Нарушение формы
    // здесь — фатальная ошибка сообщения (`error`, соединение закрывается),
    // а не отказ конкретной операции (`reject`, соединение остаётся) — это
    // ack/reject предполагают уже провалидированный по форме `dot` для
    // корреляции с очередью клиента, здесь его в принципе нет надёжно (dot
    // подделан). До добавления недостающего `.refine` этот expect был
    // красным — сервер отвечал `ack`, дыра пропускала атаку насквозь.
    expect(result.type).toBe("error");
    if (result.type !== "error") throw new Error("V2 hole: server accepted instead of error");
    expect(result.reason).toBe("invalid_shape");

    // Прямое подтверждение через журнал в Postgres, что дыра не
    // гипотетическая: если сервер принял дельту, в `ops` реально лежит
    // строка, отмечающая Y как deleted=true — чужой стикер удалён по-настоящему.
    const rows = await db
      .select({ delta: schema.ops.delta })
      .from(schema.ops)
      .where(eq(schema.ops.boardId, boardId));
    const yWasDeletedByAttacker = rows.some((row) =>
      row.delta.entries.some(
        (entry) =>
          entry.key.entity === stickerY && entry.key.field === "deleted" && entry.value === true,
      ),
    );
    expect(yWasDeletedByAttacker).toBe(false);

    wsOwner.close();
    wsAttacker.close();
  });
});

// ---------------------------------------------------------------------------
// Находка 6 code-review (T-011+T-012, тот же класс проблемы, что и у
// resetVotes выше): appendOp и recordAuthor писались вне транзакции — сбой
// recordAuthor посередине оставлял операцию уже в журнале, но без автора.
// Повторная отправка того же create находила dot по findOp (идемпотентность,
// REQ-023 кр.3) и получала `ack`, ни разу не вызывая recordAuthor снова —
// стикер навсегда оставался без автора, REQ-007/REQ-009 («только свой»)
// невозможно было бы удовлетворить для этого стикера никогда.
//
// Исправлено (см. коммит): appendOp+recordAuthor — одна транзакция
// db.transaction(...). Тест ниже подделывает сбой recordAuthor через
// временный BEFORE INSERT триггер Postgres на authors (без хуков в коде
// продукта) и проверяет: (1) вся транзакция откатилась — ни строки в ops,
// ни строки в authors; (2) после снятия триггера точно тот же create можно
// отправить повторно и он проходит нормально, с корректно записанным
// автором — состояние не застревает сломанным навсегда.
// ---------------------------------------------------------------------------

describe("REQ-007/REQ-009: appendOp+recordAuthor атомарны — сбой посередине не оставляет стикер без автора", () => {
  it("createSticker: сбой при записи автора откатывает и журнал; повтор того же create после снятия сбоя проходит нормально", async () => {
    const ownerId = newGuestId();
    const { boardId, participantLink } = await createBoard(db, {
      title: "author atomicity",
      displayName: "Owner",
      voteLimit: 3,
      ownerId,
    });

    const participantId = newGuestId();
    await joinByLink(db, {
      linkToken: participantLink,
      guestId: participantId,
      displayName: "Author",
    });

    const ws = await connect(boardId);
    const reader = messageReader(ws);
    const actorId = newActorId();
    sendHello(ws, { guestId: participantId, displayName: "Author", actorId });
    expect((await reader.next()).type).toBe("welcome");

    const created = createSticker(empty(), newClock(actorId), {
      column: "start",
      frac: "1",
      text: "orphan-prone sticker",
      color: "yellow",
    });
    const stickerId = dotKey(created.dot) as EntityId;
    const opMessage = JSON.stringify({ type: "op", delta: toWire(created.delta) });

    await pool.query(`
      CREATE OR REPLACE FUNCTION test_poison_author() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.entity_id = '${stickerId}' THEN
          RAISE EXCEPTION 'injected test failure for recordAuthor atomicity test';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await pool.query(`
      CREATE TRIGGER test_poison_author_trigger
      BEFORE INSERT ON authors
      FOR EACH ROW EXECUTE FUNCTION test_poison_author();
    `);

    try {
      ws.send(opMessage);
      const failed = await reader.next();
      expect(failed.type).toBe("error");

      // Транзакция должна была откатиться целиком — ни строки в ops, ни в authors.
      const opsRows = await db
        .select({ delta: schema.ops.delta })
        .from(schema.ops)
        .where(eq(schema.ops.boardId, boardId));
      const hasOrphanOp = opsRows.some((row) => row.delta.created.some((c) => c.id === stickerId));
      expect(hasOrphanOp).toBe(false);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS test_poison_author_trigger ON authors;");
      await pool.query("DROP FUNCTION IF EXISTS test_poison_author();");
    }

    // Сбой снят — тот же клиент повторно отправляет ТОЧНО ТУ ЖЕ дельту
    // (как и должен делать outbox при повторной доставке, REQ-023 кр.3).
    // Состояние не застряло — create проходит нормально, автор записывается.
    const ws2 = await connect(boardId);
    const reader2 = messageReader(ws2);
    sendHello(ws2, { guestId: participantId, displayName: "Author", actorId });
    expect((await reader2.next()).type).toBe("welcome");

    ws2.send(opMessage);
    const retryResult = await reader2.next();
    expect(retryResult.type).toBe("ack");

    const authorRow = await db
      .select({ guestId: schema.authors.guestId })
      .from(schema.authors)
      .where(and(eq(schema.authors.boardId, boardId), eq(schema.authors.entityId, stickerId)));
    expect(authorRow[0]?.guestId).toBe(participantId);

    ws.close();
    ws2.close();
  });
});

// ---------------------------------------------------------------------------
// T-013 — «Проекция видимости и reveal»: приёмочные тесты по реальному WS,
// написанные ДО реализации и не глядя в неё (docs/spec/protocol.md § 2
// «Авторство стикеров», § 5 `BoardMeta`, § 6 «Reveal»;
// docs/spec/requirements.md REQ-006, REQ-004 кр.1, REQ-020 кр.2;
// docs/spec/consistency-model.md § 5 проекция `proj_u`).
//
// Ключевое отличие от «просто не показываем на экране»: пока доска в
// `collect`, чужой стикер получателю вообще НЕ ДОСТАВЛЯЕТСЯ — ни в
// `welcome` (ни в снапшоте, ни в хвосте журнала `ops`), ни как `op`-
// рассылка. Само событие «что-то произошло» не должно утекать до `reveal`
// (protocol.md § 2: «до reveal сервер не отправляет чужие сущности вовсе»).
// После `reveal` (первый `setPhase` из `collect`, REQ-004 кр.1) сервер
// досылает ранее скрытое как `op`, `meta.revealed` становится `true`, а
// `meta.authors` — заполняется.
//
// `apps/server/src/**` не читался.
// ---------------------------------------------------------------------------

/**
 * Доказывает ОТСУТСТВИЕ следующего сообщения у `reader` в течение 300ms.
 * Нужен именно гонкой с таймаутом (а не «следующее сообщение — другого
 * типа»): порядок доставки между независимыми WS-соединениями протоколом
 * не гарантирован (см. `nextOfType` выше в этом файле), поэтому единственный
 * надёжный способ показать «ничего не пришло вообще» — подождать и не
 * получить ничего.
 */
async function expectNoMessage(reader: ReturnType<typeof messageReader>): Promise<void> {
  const result = await Promise.race([
    reader.next().then(() => "message" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 300)),
  ]);
  expect(result).toBe("timeout");
}

describe("REQ-006 (кр. 1): чужой стикер в фазе collect не доходит до получателя вовсе", () => {
  it("REQ-006 кр.1а: стикер создан ДО подключения получателя — отсутствует и в welcome.snapshot, и в welcome.ops", async () => {
    const { boardId, ownerId, participantLink } = await newBoardWithOwner();

    const wsOwner = await connect(boardId);
    const readerOwner = messageReader(wsOwner);
    const ownerActorId = newActorId();
    sendHello(wsOwner, { guestId: ownerId, displayName: "Owner", actorId: ownerActorId });
    expect((await readerOwner.next()).type).toBe("welcome");

    const created = createSticker(empty(), newClock(ownerActorId), {
      column: "start",
      frac: "1",
      text: "owner's secret, before newcomer connects",
      color: "yellow",
    });
    wsOwner.send(JSON.stringify({ type: "op", delta: toWire(created.delta) }));
    expect((await readerOwner.next()).type).toBe("ack");
    const stickerId = dotKey(created.dot) as EntityId;

    // Участник присоединяется и подключается ПОСЛЕ того, как стикер уже создан.
    const participantId = newGuestId();
    const joined = await joinByLink(db, {
      linkToken: participantLink,
      guestId: participantId,
      displayName: "Newcomer",
    });
    expect(joined?.role).toBe("participant");

    const ws = await connect(boardId);
    const reader = messageReader(ws);
    sendHello(ws, { guestId: participantId, displayName: "Newcomer", actorId: newActorId() });
    const welcome = await reader.next();
    expect(welcome.type).toBe("welcome");
    if (welcome.type !== "welcome") throw new Error("expected welcome");

    const seenInSnapshot = welcome.snapshot?.state.created.some((c) => c.id === stickerId) ?? false;
    const seenInOps = welcome.ops.some((op) => op.delta.created.some((c) => c.id === stickerId));
    expect(seenInSnapshot).toBe(false);
    expect(seenInOps).toBe(false);

    wsOwner.close();
    ws.close();
  });

  it("REQ-006 кр.1б: стикер создан ПОСЛЕ подключения получателя — не приходит как op-рассылка вовсе (не пустая дельта, а ничего)", async () => {
    const { boardId, ownerId, participantLink } = await newBoardWithOwner();

    const participantId = newGuestId();
    const joined = await joinByLink(db, {
      linkToken: participantLink,
      guestId: participantId,
      displayName: "Bystander",
    });
    expect(joined?.role).toBe("participant");

    const wsOwner = await connect(boardId);
    const ws = await connect(boardId);
    const readerOwner = messageReader(wsOwner);
    const reader = messageReader(ws);

    const ownerActorId = newActorId();
    sendHello(wsOwner, { guestId: ownerId, displayName: "Owner", actorId: ownerActorId });
    sendHello(ws, { guestId: participantId, displayName: "Bystander", actorId: newActorId() });
    expect((await readerOwner.next()).type).toBe("welcome");
    expect((await reader.next()).type).toBe("welcome");

    const created = createSticker(empty(), newClock(ownerActorId), {
      column: "start",
      frac: "1",
      text: "owner's live secret, after bystander already connected",
      color: "green",
    });
    wsOwner.send(JSON.stringify({ type: "op", delta: toWire(created.delta) }));
    expect((await readerOwner.next()).type).toBe("ack");

    // Получатель уже подписан на доску — если бы видимость была лишь
    // фильтром на экране, он получил бы `op` (пусть и с пустой для него
    // проекцией). Здесь он не получает ВООБЩЕ НИЧЕГО для этой операции.
    await expectNoMessage(reader);

    wsOwner.close();
    ws.close();
  });
});

describe("REQ-006 (кр. 2): временное скрытие действует для всех ролей без исключения, включая owner", () => {
  it("REQ-006 кр.2: owner не видит чужой стикер, пока доска в collect — ни живьём, ни в welcome после переподключения", async () => {
    const { boardId, ownerId, participantLink } = await newBoardWithOwner();

    const participantId = newGuestId();
    const joined = await joinByLink(db, {
      linkToken: participantLink,
      guestId: participantId,
      displayName: "Author",
    });
    expect(joined?.role).toBe("participant");

    const wsParticipant = await connect(boardId);
    const readerParticipant = messageReader(wsParticipant);
    const participantActorId = newActorId();
    sendHello(wsParticipant, {
      guestId: participantId,
      displayName: "Author",
      actorId: participantActorId,
    });
    expect((await readerParticipant.next()).type).toBe("welcome");

    // Owner уже подключён ДО создания чужого стикера — проверяем живую рассылку.
    const wsOwner = await connect(boardId);
    const readerOwner = messageReader(wsOwner);
    sendHello(wsOwner, { guestId: ownerId, displayName: "Owner", actorId: newActorId() });
    expect((await readerOwner.next()).type).toBe("welcome");

    const created = createSticker(empty(), newClock(participantActorId), {
      column: "start",
      frac: "1",
      text: "participant's secret, owner must not see it either",
      color: "pink",
    });
    wsParticipant.send(JSON.stringify({ type: "op", delta: toWire(created.delta) }));
    expect((await readerParticipant.next()).type).toBe("ack");
    const stickerId = dotKey(created.dot) as EntityId;

    // Owner (роль с самыми широкими правами в системе) не получает ничего вживую...
    await expectNoMessage(readerOwner);

    // ...и переподключение тоже ничего не показывает: временное скрытие —
    // свойство фазы collect, а не отсутствие привилегии у роли.
    const wsOwner2 = await connect(boardId);
    const readerOwner2 = messageReader(wsOwner2);
    sendHello(wsOwner2, { guestId: ownerId, displayName: "Owner", actorId: newActorId() });
    const welcomeOwner2 = await readerOwner2.next();
    expect(welcomeOwner2.type).toBe("welcome");
    if (welcomeOwner2.type !== "welcome") throw new Error("expected welcome");

    const seenInSnapshot =
      welcomeOwner2.snapshot?.state.created.some((c) => c.id === stickerId) ?? false;
    const seenInOps = welcomeOwner2.ops.some((op) =>
      op.delta.created.some((c) => c.id === stickerId),
    );
    expect(seenInSnapshot).toBe(false);
    expect(seenInOps).toBe(false);

    wsParticipant.close();
    wsOwner.close();
    wsOwner2.close();
  });
});

describe("REQ-004 (кр. 1) + REQ-006 (кр. 3): reveal раскрывает авторов и досылает ранее скрытые стикеры", () => {
  it("REQ-004 кр.1/REQ-006 кр.3: первый выход из collect — meta.revealed=true, meta.authors содержит автора скрытого стикера, стикер досылается op-рассылкой тому, кому был скрыт", async () => {
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

    const ownerActorId = newActorId();
    sendHello(wsOwner, { guestId: ownerId, displayName: "Owner", actorId: ownerActorId });
    sendHello(wsParticipant, {
      guestId: participantId,
      displayName: "Alice",
      actorId: newActorId(),
    });
    expect((await readerOwner.next()).type).toBe("welcome");
    expect((await readerParticipant.next()).type).toBe("welcome");

    // Owner создаёт стикер в collect — Alice его пока не видит вовсе (REQ-006 кр.1).
    const created = createSticker(empty(), newClock(ownerActorId), {
      column: "start",
      frac: "1",
      text: "hidden until reveal",
      color: "yellow",
    });
    wsOwner.send(JSON.stringify({ type: "op", delta: toWire(created.delta) }));
    expect((await readerOwner.next()).type).toBe("ack");
    const stickerId = dotKey(created.dot) as EntityId;

    // Отсутствие доставки до reveal отдельно доказано выше (REQ-006 кр.1).
    // Здесь `readerParticipant` намеренно не трогаем до reveal: `next()`
    // messageReader нельзя отменить — начатое здесь ожидание "ничего не
    // пришло" забрало бы себе первое же сообщение после reveal и не отдало
    // бы его последующему чтению ниже.

    // Первый уход из collect — это и есть reveal (REQ-004 кр.1, protocol.md § 6).
    wsOwner.send(
      JSON.stringify({
        type: "command",
        id: "cmd-reveal",
        command: { type: "setPhase", phase: "group" },
      }),
    );

    // Порядок commandResult/meta для инициатора не гарантирован (как в
    // существующем тесте REQ-004 кр.1/кр.3 выше в этом файле).
    const ownerFirst = await readerOwner.next();
    const ownerSecond = await readerOwner.next();
    const ownerCommandResult = [ownerFirst, ownerSecond].find((m) => m.type === "commandResult");
    expect(ownerCommandResult?.type).toBe("commandResult");
    if (ownerCommandResult?.type !== "commandResult") throw new Error("expected commandResult");
    expect(ownerCommandResult.ok).toBe(true);

    // Alice получает `meta` с revealed=true и авторами, и (в любом порядке
    // относительно meta, возможно несколькими op) — досылку ранее скрытого
    // стикера owner'а.
    let meta: Extract<ServerMessage, { type: "meta" }> | undefined;
    let sawCreatedSticker = false;
    for (let i = 0; i < 5 && (!meta || !sawCreatedSticker); i++) {
      const msg = await readerParticipant.next();
      if (msg.type === "meta") meta = msg;
      if (msg.type === "op" && msg.delta.created.some((c) => c.id === stickerId)) {
        sawCreatedSticker = true;
      }
    }

    expect(meta?.type).toBe("meta");
    if (meta?.type !== "meta") throw new Error("expected meta broadcast with reveal");
    expect(meta.meta.revealed).toBe(true);
    expect(meta.meta.authors[stickerId]).toBe("Owner");
    expect(sawCreatedSticker).toBe(true);

    wsOwner.close();
    wsParticipant.close();
  });
});

// ---------------------------------------------------------------------------
// T-026, H1 (`docs/spec/simulator.md` § 12) — смежный, но ДРУГОЙ сценарий,
// чем блок выше: там участник ПОДКЛЮЧЁН в момент reveal (живая досылка
// `sendRevealCatchup`). Здесь участник в момент reveal ОТКЛЮЧЁН, и его
// собственный `lastSeq` (от `ack` на СВОЙ же видимый стикер) уже больше,
// чем `seq` чужого скрытого стикера — потому что `seq` общий на доску и у
// него бывают "пропуски" для скрытых от этого участника строк. При
// переподключении ПОСЛЕ reveal `welcomeData` сейчас отдаёт только строки с
// `seq > lastSeq`, и скрытый стикер навсегда пропадает для этого участника
// (`docs/spec/simulator.md` § 12, H1; ВС-2(б) — `boards.reveal_seq`).
// ---------------------------------------------------------------------------

describe("REQ-006 (кр. 3), REQ-023 (кр. 2), H1: переподключение ПОСЛЕ reveal с уже продвинутым lastSeq не должно терять ранее скрытый стикер", () => {
  it("REQ-006 кр.3 / REQ-023 кр.2 (H1): Bob был отключён в момент reveal, его lastSeq больше seq скрытого стикера Owner'а — после переподключения стикер всё равно приходит (welcome.snapshot или welcome.ops), автор виден", async () => {
    const { boardId, ownerId, participantLink } = await newBoardWithOwner();

    const participantId = newGuestId();
    const joined = await joinByLink(db, {
      linkToken: participantLink,
      guestId: participantId,
      displayName: "Bob",
    });
    expect(joined?.role).toBe("participant");

    const wsOwner = await connect(boardId);
    const wsBob = await connect(boardId);
    const readerOwner = messageReader(wsOwner);
    const readerBob = messageReader(wsBob);

    const ownerActorId = newActorId();
    const bobActorId = newActorId();
    sendHello(wsOwner, { guestId: ownerId, displayName: "Owner", actorId: ownerActorId });
    sendHello(wsBob, { guestId: participantId, displayName: "Bob", actorId: bobActorId });
    expect((await readerOwner.next()).type).toBe("welcome");
    expect((await readerBob.next()).type).toBe("welcome");

    // Owner создаёт стикер, скрытый от Bob, пока доска в collect (REQ-006 кр.1) —
    // его seq меньше, чем у следующей строки, которую увидит Bob.
    const hidden = createSticker(empty(), newClock(ownerActorId), {
      column: "start",
      frac: "1",
      text: "hidden from Bob until reveal",
      color: "yellow",
    });
    wsOwner.send(JSON.stringify({ type: "op", delta: toWire(hidden.delta) }));
    expect((await readerOwner.next()).type).toBe("ack");
    const hiddenStickerId = dotKey(hidden.dot) as EntityId;

    // Bob создаёt СВОЙ стикер (сам себе виден) ПОСЛЕ — доска обрабатывает
    // операции по FIFO (T-012), поэтому его ack.seq строго больше seq
    // скрытой строки owner'а. Это и есть "продвинутый lastSeq" из H1.
    const bobsOwn = createSticker(empty(), newClock(bobActorId), {
      column: "start",
      frac: "2",
      text: "Bob's own sticker",
      color: "green",
    });
    wsBob.send(JSON.stringify({ type: "op", delta: toWire(bobsOwn.delta) }));
    const bobAck = await readerBob.next();
    expect(bobAck.type).toBe("ack");
    if (bobAck.type !== "ack") throw new Error("expected ack");
    const bobLastSeq = bobAck.seq;

    // Bob отключается ДО reveal, запомнив bobLastSeq (это делает клиент
    // реально, здесь эмулируется передачей lastSeq в hello при переподключении).
    let bobClosed = false;
    wsBob.on("close", () => {
      bobClosed = true;
    });
    wsBob.close();
    await new Promise<void>((resolve) => {
      if (bobClosed) return resolve();
      wsBob.on("close", () => resolve());
      setTimeout(resolve, 2000);
    });

    // Первый уход из collect — reveal (REQ-004 кр.1). Bob к этому моменту
    // без соединения — `sendRevealCatchup` (живая досылка) его не застаёт.
    wsOwner.send(
      JSON.stringify({
        type: "command",
        id: "cmd-reveal-h1",
        command: { type: "setPhase", phase: "group" },
      }),
    );
    const ownerFirst = await readerOwner.next();
    const ownerSecond = await readerOwner.next();
    const ownerCommandResult = [ownerFirst, ownerSecond].find((m) => m.type === "commandResult");
    expect(ownerCommandResult?.type).toBe("commandResult");
    if (ownerCommandResult?.type !== "commandResult") throw new Error("expected commandResult");
    expect(ownerCommandResult.ok).toBe(true);

    // Bob переподключается ПОСЛЕ reveal с уже продвинутым lastSeq.
    const wsBob2 = await connect(boardId);
    const readerBob2 = messageReader(wsBob2);
    sendHello(wsBob2, {
      guestId: participantId,
      displayName: "Bob",
      actorId: newActorId(),
      lastSeq: bobLastSeq,
    });
    const welcomeBob2 = await readerBob2.next();
    expect(welcomeBob2.type).toBe("welcome");
    if (welcomeBob2.type !== "welcome") throw new Error("expected welcome");

    // H1: ранее скрытый стикер owner'а обязан дойти до Bob хоть сейчас — в
    // snapshot (если бы он был; сознательно не делаем saveSnapshot здесь,
    // задача T-026) или в хвосте `ops`. Единственный реальный источник тут — `ops`.
    const seenInSnapshot =
      welcomeBob2.snapshot?.state.created.some((c) => c.id === hiddenStickerId) ?? false;
    const seenInOps = welcomeBob2.ops.some((op) =>
      op.delta.created.some((c) => c.id === hiddenStickerId),
    );
    expect(seenInSnapshot || seenInOps).toBe(true);

    // Автор ранее скрытого стикера тоже должен быть виден после reveal (REQ-006 кр.3).
    expect(welcomeBob2.meta.revealed).toBe(true);
    expect(welcomeBob2.meta.authors[hiddenStickerId]).toBe("Owner");

    wsOwner.close();
    wsBob2.close();
  });
});

describe("REQ-020 (кр. 2): доска не считается раскрытой, пока в collect", () => {
  it("REQ-020 кр.2: welcome.meta.revealed=false и welcome.meta.authors={} в фазе collect, даже если стикеры уже созданы", async () => {
    const { boardId, ownerId } = await newBoardWithOwner();

    const ws = await connect(boardId);
    const reader = messageReader(ws);
    const actorId = newActorId();
    sendHello(ws, { guestId: ownerId, displayName: "Owner", actorId });
    expect((await reader.next()).type).toBe("welcome");

    const created = createSticker(empty(), newClock(actorId), {
      column: "start",
      frac: "1",
      text: "still in collect, board not revealed yet",
      color: "yellow",
    });
    ws.send(JSON.stringify({ type: "op", delta: toWire(created.delta) }));
    expect((await reader.next()).type).toBe("ack");

    const ws2 = await connect(boardId);
    const reader2 = messageReader(ws2);
    sendHello(ws2, { guestId: ownerId, displayName: "Owner", actorId: newActorId() });
    const welcome2 = await reader2.next();
    expect(welcome2.type).toBe("welcome");
    if (welcome2.type !== "welcome") throw new Error("expected welcome");
    expect(welcome2.meta.revealed).toBe(false);
    expect(welcome2.meta.authors).toEqual({});

    ws.close();
    ws2.close();
  });
});
