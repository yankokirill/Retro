// T-024 — реестр подписчиков, бывший `apps/server/src/ws/board-hub.ts` без
// сокета: там, где `BoardHub` держала `Subscriber.socket` и сама вызывала
// `socket.send`, здесь подписчик — просто данные (`ConnectionId` вместо
// сокета), а отправка — через `Sink` (board-server.ts), который собирает
// исходящие сообщения в `ReceiveResult.outgoing` вместо реальной записи в
// сеть (ADR-0009 — ядро без I/O).

import type { Role } from "@retro/protocol";
import type { ConnectionId } from "./board-server.js";

export interface Subscriber {
  readonly connection: ConnectionId;
  readonly actorId: string;
  /** guestId из `hello` — для авторства и матрицы прав. */
  readonly guestId: string;
  /**
   * Роль на момент `hello`, кэшируется на время соединения (T-011,
   * перенесено без изменений из `ws/board-hub.ts`). Может устареть, если
   * роль сменится посреди сессии (`grantFacilitator`) — вне T-011/T-024.
   */
  readonly role: Role;
}

/**
 * Реестр подписчиков по доске, в памяти одного `BoardServer` (один процесс
 * — горизонтальное масштабирование вне MVP, CLAUDE.md § 2). Не хранит
 * ничего о состоянии доски — только то, кому слать.
 */
export class SubscriberRegistry {
  private readonly byBoard = new Map<string, Set<Subscriber>>();
  private readonly byConnection = new Map<ConnectionId, Subscriber>();

  subscribe(boardId: string, subscriber: Subscriber): void {
    const set = this.byBoard.get(boardId);
    if (set) {
      set.add(subscriber);
    } else {
      this.byBoard.set(boardId, new Set([subscriber]));
    }
    this.byConnection.set(subscriber.connection, subscriber);
  }

  unsubscribe(boardId: string, connection: ConnectionId): void {
    const subscriber = this.byConnection.get(connection);
    this.byConnection.delete(connection);
    if (!subscriber) return;
    const set = this.byBoard.get(boardId);
    if (!set) return;
    set.delete(subscriber);
    if (set.size === 0) this.byBoard.delete(boardId);
  }

  /** `undefined` — соединение ещё не прошло `hello` (или уже отписано). */
  get(connection: ConnectionId): Subscriber | undefined {
    return this.byConnection.get(connection);
  }

  subscribersOf(boardId: string): ReadonlySet<Subscriber> {
    return this.byBoard.get(boardId) ?? new Set();
  }
}
