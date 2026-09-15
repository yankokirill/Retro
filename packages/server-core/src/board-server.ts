// T-024 (docs/design/T-005-simulator.md § 3.1). `createBoardServer` — ядро
// сервера без I/O: принимает сообщения одного или нескольких WS-соединений,
// решает, что на них ответить и кому разослать, но само не открывает
// сокетов и не обращается к сети — только к порту `BoardStore` (store.ts) и
// к чистым `voterToken`. Тонкий адаптер (`apps/server/src/ws/gateway.ts`)
// подключает это к настоящим WebSocket.
//
// SIM-05 (docs/spec/simulator.md): «шаг сервера атомарен так же, как в
// apps/server» — здесь это обеспечивается тем, что `receive`/`close` сами
// ставят обработку в очередь доски (`queue.ts`) СИНХРОННО в момент вызова
// (до первого await), не после. Это заменяет две временные заплатки T-026:
// цепочку промисов `inbox` на одно WS-соединение (H2) и обёртку `hello` в
// `queue.run` вручную в `gateway.ts` (находка 1 code-review PR #19) —
// обеими больше не нужно заниматься гейтвею, это теперь встроенное свойство
// `receive`.
//
// Реализация — следующий шаг T-024 (после того, как test-author напишет
// тесты по этому контракту); сейчас — заглушка, как `validateOp` в T-010.

import type { BoardStore } from "./store.js";

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

export function createBoardServer(_ports: ServerCorePorts): BoardServer {
  throw new Error("createBoardServer: not implemented");
}
