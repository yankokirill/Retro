// SIM-05 (docs/spec/simulator.md § 4.3): «шаг сервера атомарен так же, как в
// apps/server» — приёмочные тесты для контракта `createBoardServer`
// (`packages/server-core/src/board-server.ts`, дан verbatim в задаче T-024),
// написанные ДО реализации (сейчас — заглушка, синхронно бросает
// `Error("createBoardServer: not implemented")`) и не глядя в неё.
//
// Контекст (H2, находка code-review PR #19 — см. docs/spec/simulator.md
// § 12): в `apps/server` обе гонки были исправлены заплатками; здесь
// проверяется, что `createBoardServer` убирает их архитектурно — каждое
// сообщение соединения (`hello`/`op`/`command`) и отписка становятся в
// очередь ДОСКИ целиком, в порядке вызова `receive`/`close` (ADR-0009), а
// не после первого `await` внутри обработчика.
//
// Ожидаемый результат ПРЯМО СЕЙЧАС: каждый `it` ниже падает РОВНО на строке
// `createBoardServer(ports)` с сообщением "createBoardServer: not
// implemented" — не из-за ошибки в построении сообщений/стаба.

import { empty } from "@retro/crdt";
import type { Command, Role } from "@retro/protocol";
import { clientMessageSchema, PROTOCOL_VERSION, serverMessageSchema } from "@retro/protocol";
import { describe, expect, it } from "vitest";
import type { BoardServer, ConnectionId, ServerCorePorts } from "../src/board-server.js";
import { createBoardServer } from "../src/board-server.js";
import type {
  ActorClock,
  AppendOpResult,
  BoardRecord,
  BoardStore,
  BoardStoreTx,
  OpRow,
  ReplayResult,
} from "../src/store.js";

// ---------------------------------------------------------------------------
// Сообщения клиента — честно через zod-схемы @retro/protocol (§ протокол
// доверяет только тому, что прошло схему; строим ИМЕННО так, как это сделал
// бы настоящий клиент, чтобы receive() принял их как валидный JSON).

const BOARD_ID = "11111111-1111-4111-8111-111111111111";

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

/** Одна честная запись (§ 3 consistency-model.md) — content нам не важен, важно, что это валидный `op`. */
function opRaw(actorId: string): string {
  const dot = { actor: actorId, counter: 1 };
  const stamp = { lamport: 1, actor: actorId };
  const entityId = `${actorId}:1`;
  const message = clientMessageSchema.parse({
    type: "op",
    delta: {
      created: [{ id: entityId, kind: "sticker" }],
      entries: [
        { key: { entity: entityId, field: "text" }, dot, stamp, value: "hello" },
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

function commandRaw(id: string, command: Command): string {
  const message = clientMessageSchema.parse({ type: "command", id, command });
  return JSON.stringify(message);
}

// ---------------------------------------------------------------------------
// StubBoardStore: реализует BoardStore вручную (адаптеров ещё нет), логирует
// "<tag>:<method>:start"/"...:end" в общий массив и возвращает промис,
// разрешаемый ТОЛЬКО тестом (deferred, как в test/queue.test.ts) — так можно
// детерминированно проверить, что вызовы одного receive не перемешиваются во
// времени с вызовами другого.
//
// Ограничение честности: методы BoardStore не несут ConnectionId — только
// boardId/guestId/actor(dot.actor). Тег для методов без такого аргумента
// (board/opsSince/currentState/updatePhase/...) поставить нечем — ниже он
// помечается "?" и не участвует в проверке чередования (SIM-05 кр.1);
// проверка опирается на методы, различимые по guestId/actor (memberRole,
// appendOp, findOpSeq, findUnvoteSeq, actorClock, recordAuthor) — их
// достаточно, чтобы поймать переплетение, если оно есть.

interface PendingCall {
  readonly description: string;
  resolve(): void;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const UNKNOWN_TAG = "?";

interface StubBoardStoreConfig {
  readonly log: string[];
  readonly pending: PendingCall[];
  readonly tagByGuestId?: ReadonlyMap<string, string>;
  readonly tagByActor?: ReadonlyMap<string, string>;
  readonly board?: BoardRecord | null;
  readonly role?: Role | null;
}

function createStubBoardStore(config: StubBoardStoreConfig): BoardStore {
  const { log, pending, tagByGuestId, tagByActor, board, role } = config;

  function record<T>(tag: string, method: string, value: T): Promise<T> {
    log.push(`${tag}:${method}:start`);
    const gate = deferred();
    pending.push({ description: `${tag}:${method}`, resolve: gate.resolve });
    return gate.promise.then(() => {
      log.push(`${tag}:${method}:end`);
      return value;
    });
  }

  const tagForGuest = (guestId: string): string => tagByGuestId?.get(guestId) ?? UNKNOWN_TAG;
  const tagForActor = (actor: string): string => tagByActor?.get(actor) ?? UNKNOWN_TAG;

  return {
    board: (_boardId: string) => record(UNKNOWN_TAG, "board", board ?? null),
    memberRole: (_boardId: string, guestId: string) =>
      record<Role | null>(tagForGuest(guestId), "memberRole", role ?? "participant"),
    updatePhase: (_boardId, _phase, _revealSeq) => record(UNKNOWN_TAG, "updatePhase", undefined),
    findOpSeq: (_boardId, dot) => record<number | null>(tagForActor(dot.actor), "findOpSeq", null),
    findUnvoteSeq: (_boardId, voteDot, _target) =>
      record<number | null>(tagForActor(voteDot.actor), "findUnvoteSeq", null),
    actorClock: (_boardId, actor) =>
      record<ActorClock>(tagForActor(actor), "actorClock", {
        lastCounter: 0,
        lastLamport: 0,
        boardMaxLamport: 0,
      }),
    opsSince: (_boardId, _sinceSeq) => record<OpRow[]>(UNKNOWN_TAG, "opsSince", []),
    opsUpTo: (_boardId, _uptoSeq) => record<OpRow[]>(UNKNOWN_TAG, "opsUpTo", []),
    lastSeq: (_boardId) => record(UNKNOWN_TAG, "lastSeq", 0),
    latestSnapshot: (_boardId) => record(UNKNOWN_TAG, "latestSnapshot", null),
    currentState: (_boardId) =>
      record<ReplayResult>(UNKNOWN_TAG, "currentState", { state: empty(), uptoSeq: 0 }),
    authors: (_boardId) => record(UNKNOWN_TAG, "authors", new Map()),
    authorDisplayNames: (_boardId) => record(UNKNOWN_TAG, "authorDisplayNames", {}),
    transaction: async (fn) => {
      const tx: BoardStoreTx = {
        appendOp: (params) =>
          record<AppendOpResult>(tagForActor(params.dot?.actor ?? UNKNOWN_TAG), "appendOp", {
            seq: 1,
          }),
        recordAuthor: (_boardId, _entityId, guestId) =>
          record(tagForGuest(guestId), "recordAuthor", undefined),
      };
      return fn(tx);
    },
  };
}

// ---------------------------------------------------------------------------
// Управление "временем" без setTimeout/гонок по реальным часам (queue.test.ts).

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Проигрывает раунды "дать микрозадачам доиграть → отпустить всё, что сейчас
 * висит в pending" пока `promise` не разрешится/не отклонится, или пока не
 * кончится `maxRounds` (защита от зависания, если реализация никогда не
 * обращается к хранилищу так, как мы ожидаем).
 */
async function drainUntilSettled(
  promise: Promise<unknown>,
  pending: PendingCall[],
  maxRounds = 100,
): Promise<void> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let round = 0; round < maxRounds && !settled; round += 1) {
    await flushMicrotasks();
    if (settled) break;
    const toRelease = pending.splice(0, pending.length);
    for (const call of toRelease) call.resolve();
  }
}

function makePorts(store: BoardStore): ServerCorePorts {
  return { store, voterToken: () => "voter-token" };
}

describe("SIM-05: атомарность шага сервера (createBoardServer)", () => {
  it(
    "SIM-05 (кр.2, H2): op сразу после hello в одном соединении дожидается своей очереди, " +
      "а не отклоняется как 'до hello'",
    async () => {
      const log: string[] = [];
      const pending: PendingCall[] = [];
      const actorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const guestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const store = createStubBoardStore({
        log,
        pending,
        tagByGuestId: new Map([[guestId, "conn"]]),
        tagByActor: new Map([[actorId, "conn"]]),
        board: {
          id: BOARD_ID,
          title: "Retro",
          ownerId: "owner-1",
          phase: "collect",
          voteLimit: 3,
          revealSeq: null,
        },
      });

      const server: BoardServer = createBoardServer(makePorts(store));
      const conn: ConnectionId = "conn-1";
      server.open(conn, BOARD_ID);

      let helloSettled = false;
      const helloPromise = server.receive(conn, helloRaw(actorId, guestId));
      helloPromise.then(
        () => {
          helloSettled = true;
        },
        () => {
          helloSettled = true;
        },
      );
      // Без await между вызовами — ровно сценарий H2.
      const opPromise = server.receive(conn, opRaw(actorId));

      await flushMicrotasks();
      // hello всё ещё висит на обращении к хранилищу — второй receive не
      // должен был успеть отклонить op как "первое сообщение должно быть hello".
      expect(helloSettled).toBe(false);

      await drainUntilSettled(helloPromise, pending);
      const helloResult = await helloPromise;
      expect(helloResult.close).toHaveLength(0);

      await drainUntilSettled(opPromise, pending);
      const opResult = await opPromise;

      const rejectedAsPreHello = opResult.outgoing.some((message) => {
        const parsed = serverMessageSchema.safeParse(JSON.parse(message.raw));
        return parsed.success && parsed.data.type === "error" && /hello/i.test(parsed.data.message);
      });
      expect(rejectedAsPreHello).toBe(false);
    },
  );

  it(
    "SIM-05 (кр.1): receive одного соединения обрабатывается целиком, не переплетаясь во времени " +
      "с receive другого соединения той же доски",
    async () => {
      const log: string[] = [];
      const pending: PendingCall[] = [];
      const actorA = "aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa";
      const guestA = "aaaaaaaa-0001-4aaa-8aaa-aaaaaaaaaaaa";
      const actorB = "bbbbbbbb-0000-4bbb-8bbb-bbbbbbbbbbbb";
      const guestB = "bbbbbbbb-0001-4bbb-8bbb-bbbbbbbbbbbb";
      const store = createStubBoardStore({
        log,
        pending,
        tagByGuestId: new Map([
          [guestA, "A"],
          [guestB, "B"],
        ]),
        tagByActor: new Map([
          [actorA, "A"],
          [actorB, "B"],
        ]),
        role: "facilitator",
        board: {
          id: BOARD_ID,
          title: "Retro",
          ownerId: "owner-1",
          phase: "group",
          voteLimit: 3,
          revealSeq: 1,
        },
      });

      const server: BoardServer = createBoardServer(makePorts(store));
      const connA: ConnectionId = "conn-A";
      const connB: ConnectionId = "conn-B";
      server.open(connA, BOARD_ID);
      server.open(connB, BOARD_ID);

      await drainUntilSettled(server.receive(connA, helloRaw(actorA, guestA)), pending);
      await drainUntilSettled(server.receive(connB, helloRaw(actorB, guestB)), pending);
      log.length = 0; // интересует только гонка ниже, не сами hello

      // Без await между вызовами — "одновременно" в терминах SIM-05 § 4.2 E2.
      const opA = server.receive(connA, opRaw(actorA));
      const commandB = server.receive(
        connB,
        commandRaw("cmd-1", { type: "setPhase", phase: "vote" }),
      );

      await drainUntilSettled(opA, pending);
      await drainUntilSettled(commandB, pending);
      await opA;
      await commandB;

      const tagged = log.filter((entry) => entry.startsWith("A:") || entry.startsWith("B:"));
      // Разбиваем тегированные записи на непрерывные "блоки" одного тега.
      // Если обработка A и B переплеталась, тег переключался бы более
      // одного раза за один блок → число блоков было бы больше числа
      // уникальных тегов (например A,B,A → 3 блока, 2 уникальных тега).
      const blocks: string[] = [];
      for (const entry of tagged) {
        const tag = entry.split(":", 1)[0] ?? "";
        if (blocks.length === 0 || blocks[blocks.length - 1] !== tag) blocks.push(tag);
      }
      expect(new Set(blocks).size).toBe(blocks.length);
    },
  );

  it(
    "SIM-05: close(conn), вызванный без await сразу после receive(conn, op), " +
      "не обгоняет ещё не обработанный op",
    async () => {
      const log: string[] = [];
      const pending: PendingCall[] = [];
      const actorId = "cccccccc-0000-4ccc-8ccc-cccccccccccc";
      const guestId = "cccccccc-0001-4ccc-8ccc-cccccccccccc";
      const store = createStubBoardStore({
        log,
        pending,
        tagByGuestId: new Map([[guestId, "conn"]]),
        tagByActor: new Map([[actorId, "conn"]]),
        board: {
          id: BOARD_ID,
          title: "Retro",
          ownerId: "owner-1",
          phase: "group",
          voteLimit: 3,
          revealSeq: 1,
        },
      });

      const server: BoardServer = createBoardServer(makePorts(store));
      const conn: ConnectionId = "conn-1";
      server.open(conn, BOARD_ID);
      await drainUntilSettled(server.receive(conn, helloRaw(actorId, guestId)), pending);

      let opSettled = false;
      let closeSettled = false;
      // Без await между вызовами — close ставится в очередь ПОСЛЕ op по
      // порядку вызова (ADR-0009), не должен обработаться раньше него.
      const opPromise = server.receive(conn, opRaw(actorId));
      opPromise.then(
        () => {
          opSettled = true;
        },
        () => {
          opSettled = true;
        },
      );
      const closePromise = server.close(conn);
      closePromise.then(
        () => {
          closeSettled = true;
        },
        () => {
          closeSettled = true;
        },
      );

      await flushMicrotasks();
      // op ещё висит на обращении к хранилищу — close, поставленный позже
      // op в очередь той же доски/соединения, не мог его обогнать.
      expect(closeSettled).toBe(false);

      await drainUntilSettled(opPromise, pending);
      expect(opSettled).toBe(true);
      expect(closeSettled).toBe(false);

      await drainUntilSettled(closePromise, pending);
      expect(closeSettled).toBe(true);
    },
  );

  it(
    "SIM-05: первое сообщение соединения — валидный JSON, но не hello — " +
      "соединение закрывается с сообщением type: 'error'",
    async () => {
      const log: string[] = [];
      const pending: PendingCall[] = [];
      const store = createStubBoardStore({ log, pending });

      const server: BoardServer = createBoardServer(makePorts(store));
      const conn: ConnectionId = "conn-1";
      server.open(conn, BOARD_ID);

      const notHello = opRaw("dddddddd-0000-4ddd-8ddd-dddddddddddd");
      const resultPromise = server.receive(conn, notHello);
      await drainUntilSettled(resultPromise, pending);
      const result = await resultPromise;

      expect(result.close).toEqual([conn]);
      const [message] = result.outgoing;
      if (message === undefined) throw new Error("expected at least one outgoing message");
      expect(message.to).toBe(conn);
      const parsed = serverMessageSchema.parse(JSON.parse(message.raw));
      expect(parsed.type).toBe("error");
    },
  );

  it("SIM-05: невалидный JSON закрывает соединение с сообщением type: 'error', reason: 'invalid_shape'", async () => {
    const log: string[] = [];
    const pending: PendingCall[] = [];
    const store = createStubBoardStore({ log, pending });

    const server: BoardServer = createBoardServer(makePorts(store));
    const conn: ConnectionId = "conn-1";
    server.open(conn, BOARD_ID);

    const resultPromise = server.receive(conn, "not json");
    await drainUntilSettled(resultPromise, pending);
    const result = await resultPromise;

    expect(result.close).toEqual([conn]);
    const [message] = result.outgoing;
    if (message === undefined) throw new Error("expected at least one outgoing message");
    const parsed = serverMessageSchema.parse(JSON.parse(message.raw));
    expect(parsed.type).toBe("error");
    expect((parsed as { reason?: string }).reason).toBe("invalid_shape");
  });
});
