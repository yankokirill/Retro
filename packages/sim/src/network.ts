// Модель сети — docs/spec/simulator.md § 4.1. Соединение = два канала FIFO
// строк JSON. Внутри канала нет потерь и переупорядочивания, пока соединение
// живо (§ 4.1 — предположение модели, WebSocket поверх TCP).

export type Direction = "toServer" | "toClient";

export interface Connection {
  /** `ConnectionId` для `BoardServer.open/receive/close` (server-core). Стабилен на весь прогон. */
  readonly id: string;
  /** Индекс в `World.clients`. */
  readonly clientIndex: number;
  readonly toServer: string[];
  readonly toClient: string[];
  alive: boolean;
  /** E3 произошёл, E4 (`serverNotice`) ещё не доставлен — сервер может адресовать соединению сообщения, они теряются (§ 4.2). */
  noticePending: boolean;
}

export function createConnection(id: string, clientIndex: number): Connection {
  return { id, clientIndex, toServer: [], toClient: [], alive: true, noticePending: false };
}

/** Непустой канал в заданном направлении. */
export function hasPending(connection: Connection, direction: Direction): boolean {
  return (direction === "toServer" ? connection.toServer : connection.toClient).length > 0;
}
