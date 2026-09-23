// T-024 — общий контекст обработчиков (`handlers/*`): порт хранения, порт
// вычисления `voterToken`, реестр подписчиков и `Sink` — приёмник исходящих
// сообщений вместо реального сокета (`board-server.ts` собирает их в
// `ReceiveResult.outgoing`/`.close`, ADR-0009: ядро без I/O).

import type { ServerMessage } from "@retro/protocol";
import type { ConnectionId } from "../board-server.js";
import type { BoardStore } from "../store.js";
import type { SubscriberRegistry } from "../subscribers.js";

export interface Sink {
  /** Кладёт сообщение в исходящую очередь этого `receive()` — не отправляет ничего напрямую. */
  send(connection: ConnectionId, message: ServerMessage): void;
  /** Помечает соединение на закрытие ПОСЛЕ отправки всего `outgoing` (см. `ReceiveResult.close`). */
  close(connection: ConnectionId): void;
}

export interface HandlerContext {
  readonly store: BoardStore;
  readonly voterToken: (boardId: string, guestId: string) => string;
  readonly now: (() => number) | undefined;
  readonly registry: SubscriberRegistry;
  readonly sink: Sink;
}
