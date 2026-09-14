// T-009 — рассылка серверных сообщений подписчикам одной доски
// (docs/spec/protocol.md § 5–6: «остальным — op в их проекции»).

import type { WebSocket } from "@fastify/websocket";
import type { ServerMessage } from "@retro/protocol";

export interface Subscriber {
  readonly socket: WebSocket;
  readonly actorId: string;
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
}
