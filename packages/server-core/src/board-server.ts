// T-024 (docs/design/T-005-simulator.md § 3.1). `createBoardServer` — ядро
// сервера без I/O: принимает сообщения одного или нескольких соединений,
// решает, что на них ответить и кому разослать, но само не открывает
// сокетов и не обращается к сети — только к порту `BoardStore` (store.ts) и
// к чистому `voterToken`. Тонкий адаптер (`apps/server/src/ws/gateway.ts`)
// подключает это к настоящим WebSocket.
//
// SIM-05 (docs/spec/simulator.md): «шаг сервера атомарен так же, как в
// apps/server» — здесь это обеспечивается тем, что `receive`/`close` сами
// ставят обработку в очередь доски (`queue.ts`) СИНХРОННО в момент вызова
// (до первого await), не после. Это заменяет две временные заплатки T-026:
// цепочку промисов `inbox` на одно WS-соединение (H2) и обёртку `hello` в
// `queue.run` вручную в `gateway.ts` (находка 1 code-review PR #19) —
// обеими больше не нужно заниматься гейтвею, это теперь встроенное свойство
// `receive`/`close` этого модуля (см. `handlers/hello.ts`, шапка файла).

import { clientMessageSchema } from "@retro/protocol";
import { handleCommand } from "./handlers/command.js";
import type { HandlerContext, Sink } from "./handlers/context.js";
import { handleHello } from "./handlers/hello.js";
import { handleOp } from "./handlers/op.js";
import { createBoardQueue } from "./queue.js";
import type { BoardStore } from "./store.js";
import { SubscriberRegistry } from "./subscribers.js";

export type ConnectionId = string;

export interface Outgoing {
  readonly to: ConnectionId;
  /** Уже сериализовано: ровно та строка, что уйдёт в сокет. */
  readonly raw: string;
}

export interface ReceiveResult {
  readonly outgoing: readonly Outgoing[];
  /** Соединения, которые надо закрыть ПОСЛЕ отправки `outgoing` (error/invalid_shape). */
  readonly close: readonly ConnectionId[];
}

export interface ServerCorePorts {
  readonly store: BoardStore;
  /** HMAC(секрет, boardId + guestId) — секрет знает только адаптер. */
  readonly voterToken: (boardId: string, guestId: string) => string;
  /**
   * Часы (миллисекунды эпохи) — ядро само времени не знает (ADR-0009). Без них таймер обсуждения
   * недоступен (`startTimer` → `invalid_shape`), остальное работает.
   */
  readonly now?: () => number;
  /** Необязательный лог внутренних ошибок; в симуляторе — счётчик. */
  readonly onInternalError?: (
    error: unknown,
    context: { readonly boardId: string; readonly connection: ConnectionId },
  ) => void;
}

export interface BoardServer {
  /** Соединение открыто для доски; сообщений ещё не было. Синхронно. */
  open(connection: ConnectionId, boardId: string): void;
  /**
   * Ставит обработку в очередь доски СИНХРОННО в момент вызова (до первого
   * await) — отсюда порядок: сообщения одного соединения обрабатываются в
   * порядке вызова (SIM-05 кр. 2, H2). Промис разрешается, когда обработка
   * закончена.
   */
  receive(connection: ConnectionId, raw: string): Promise<ReceiveResult>;
  /** Отписка тоже через очередь: рассылка, начатая до close, ещё видит подписчика. */
  close(connection: ConnectionId): Promise<void>;
}

/**
 * Разбор + диспетчер одного сообщения — тело бывшего `handleMessage`
 * (`ws/gateway.ts`), вызывается уже ИЗНУТРИ `queue.run(boardId, …)`.
 *
 * Невалидный JSON (`JSON.parse` бросает) и валидный JSON, не прошедший
 * `clientMessageSchema`, теперь дают одну и ту же причину `invalid_shape` —
 * в `ws/gateway.ts` (T-009) это было случайно по-разному (`JSON.parse`
 * бросал мимо `safeParse`, попадал в общий catch с причиной `forbidden`,
 * не отличимой от настоящей внутренней ошибки); здесь это тот же класс
 * «сообщение не разобрать», сознательно объединённый под одну причину.
 */
async function dispatch(
  ctx: HandlerContext,
  connection: ConnectionId,
  boardId: string,
  raw: string,
): Promise<void> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    ctx.sink.send(connection, { type: "error", reason: "invalid_shape", message: "invalid JSON" });
    ctx.sink.close(connection);
    return;
  }

  const parsed = clientMessageSchema.safeParse(json);
  if (!parsed.success) {
    ctx.sink.send(connection, {
      type: "error",
      reason: "invalid_shape",
      message: parsed.error.message,
    });
    ctx.sink.close(connection);
    return;
  }
  const message = parsed.data;
  const subscriber = ctx.registry.get(connection);

  if (!subscriber) {
    if (message.type !== "hello") {
      ctx.sink.send(connection, {
        type: "error",
        reason: "invalid_shape",
        message: "first message must be hello",
      });
      ctx.sink.close(connection);
      return;
    }
    await handleHello(ctx, connection, boardId, message);
    return;
  }

  if (message.type === "op") {
    await handleOp(ctx, connection, boardId, subscriber, message);
    return;
  }
  if (message.type === "command") {
    await handleCommand(ctx, connection, boardId, subscriber, message);
    return;
  }
}

export function createBoardServer(ports: ServerCorePorts): BoardServer {
  // Один экземпляр на весь BoardServer (не на соединение) — очередь общая
  // для всех соединений одной доски, как и требует допущение модели
  // (queue.ts, I6 § 8 consistency-model.md).
  const queue = createBoardQueue();
  const registry = new SubscriberRegistry();
  const boardIdByConnection = new Map<ConnectionId, string>();

  function open(connection: ConnectionId, boardId: string): void {
    boardIdByConnection.set(connection, boardId);
  }

  function receive(connection: ConnectionId, raw: string): Promise<ReceiveResult> {
    const boardId = boardIdByConnection.get(connection);
    if (boardId === undefined) {
      // Отклонённый промис, не синхронный throw (code-review PR #20,
      // находка 1): receive() возвращает Promise<ReceiveResult> по контракту
      // — вызывающий вправе делать server.receive(...).then(...) без try/
      // catch вокруг самого вызова (как и делает apps/server/src/ws/
      // gateway.ts). Синхронный throw обходил бы эту цепочку целиком и
      // вылетал бы как необработанное исключение из слушателя "message".
      return Promise.reject(new Error(`receive: connection ${connection} was not open()ed`));
    }

    const outgoing: Outgoing[] = [];
    const closing: ConnectionId[] = [];
    const sink: Sink = {
      send(to, message) {
        outgoing.push({ to, raw: JSON.stringify(message) });
      },
      close(conn) {
        closing.push(conn);
      },
    };
    const ctx: HandlerContext = {
      store: ports.store,
      voterToken: ports.voterToken,
      now: ports.now,
      registry,
      sink,
    };

    // Синхронно, ДО первого await этой функции — SIM-05 кр.2 (H2): два
    // receive() одного соединения, вызванные подряд без await, где первый —
    // hello, обрабатываются строго по порядку вызова, второй не может
    // обогнать первый и получить "first message must be hello".
    const done = queue.run(boardId, () => dispatch(ctx, connection, boardId, raw));

    return done
      .catch((error: unknown) => {
        ports.onInternalError?.(error, { boardId, connection });
        // Тот же предохранитель, что был в ws/gateway.ts (T-009): точные
        // причины отказа по V1–V7 уже обработаны внутри dispatch/handlers и
        // сюда не долетают — этот catch только про «не реализовано/сломано».
        sink.send(connection, {
          type: "error",
          reason: "forbidden",
          message: error instanceof Error ? error.message : String(error),
        });
        sink.close(connection);
      })
      .then(() => ({ outgoing, close: closing }));
  }

  function close(connection: ConnectionId): Promise<void> {
    const boardId = boardIdByConnection.get(connection);
    boardIdByConnection.delete(connection);
    if (boardId === undefined) return Promise.resolve();

    // Тоже синхронно встаёт в очередь ДО первого await этой функции —
    // рассылка, начатая до close, ещё видит подписчика (см. JSDoc
    // BoardServer.close выше).
    return queue.run(boardId, async () => {
      registry.unsubscribe(boardId, connection);
    });
  }

  return { open, receive, close };
}
