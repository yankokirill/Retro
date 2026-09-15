// T-009 — рассылка серверных сообщений подписчикам одной доски
// (docs/spec/protocol.md § 5–6: «остальным — op в их проекции»).

import type { WebSocket } from "@fastify/websocket";
import type { Role, ServerMessage } from "@retro/protocol";

export interface Subscriber {
  readonly socket: WebSocket;
  readonly actorId: string;
  /** guestId из `hello` — для авторства (T-011, `ops/authors.ts`) и матрицы прав. */
  readonly guestId: string;
  /**
   * Роль на момент `hello`, кэшируется на время соединения (T-011). Может
   * устареть, если роль сменится посреди сессии (`grantFacilitator`) — этот
   * канал ещё не подключён к WS (`boards/service.ts`, JSDoc там), так что
   * пока это не наблюдаемо; переисследовать, когда `grantFacilitator`
   * станет WS `command`.
   */
  readonly role: Role;
}

/**
 * Реестр WS-подключений по доске, в памяти одного процесса сервера
 * (горизонтальное масштабирование — вне MVP, `CLAUDE.md` § 2). Не хранит
 * ничего о состоянии доски — только сокеты, которым слать сообщения.
 */
export class BoardHub {
  private readonly boards = new Map<string, Set<Subscriber>>();

  subscribe(boardId: string, subscriber: Subscriber): void {
    const set = this.boards.get(boardId);
    if (set) {
      set.add(subscriber);
    } else {
      this.boards.set(boardId, new Set([subscriber]));
    }
  }

  unsubscribe(boardId: string, subscriber: Subscriber): void {
    const set = this.boards.get(boardId);
    if (!set) return;
    set.delete(subscriber);
    if (set.size === 0) this.boards.delete(boardId);
  }

  send(subscriber: Subscriber, message: ServerMessage): void {
    subscriber.socket.send(JSON.stringify(message));
  }

  /** Всем подписчикам доски, кроме `except` (автору операции отдельно шлют `ack`). */
  broadcast(boardId: string, message: ServerMessage, except?: Subscriber): void {
    for (const subscriber of this.boards.get(boardId) ?? []) {
      if (subscriber !== except) this.send(subscriber, message);
    }
  }

  /**
   * T-013 (`proj_u`, REQ-006): как `broadcast`, но сообщение считается
   * отдельно для каждого получателя — `build` возвращает `null`, если этому
   * подписчику сейчас ничего не видно (тогда не шлём вообще ничего, а не
   * пустую дельту, — сам факт сообщения не должен течь, CLAUDE.md § 5).
   */
  broadcastEach(
    boardId: string,
    except: Subscriber | undefined,
    build: (subscriber: Subscriber) => ServerMessage | null,
  ): void {
    for (const subscriber of this.boards.get(boardId) ?? []) {
      if (subscriber === except) continue;
      const message = build(subscriber);
      if (message) this.send(subscriber, message);
    }
  }

  /** Подписчики доски прямо сейчас — снимок множества (T-013, reveal-досылка после смены фазы). */
  subscribers(boardId: string): readonly Subscriber[] {
    return [...(this.boards.get(boardId) ?? [])];
  }
}
