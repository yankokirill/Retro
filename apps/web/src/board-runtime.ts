// Сборка живой доски в браузере: сессия (T-014) → ядро клиента → контроллер → WebSocket.

import { createSyncClient } from "@retro/client-core";
import { type BoardController, createBoardController } from "./board-controller.js";
import { buildWsUrl, connectSync } from "./sync/connection.js";
import { startSession } from "./sync/session.js";

export interface BoardRuntime {
  readonly controller: BoardController;
  stop(): void;
}

export async function startBoard(boardId: string, displayName: string): Promise<BoardRuntime> {
  const session = await startSession({
    boardId,
    storage: localStorage,
    idb: typeof indexedDB === "undefined" ? undefined : indexedDB,
    locks: typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : undefined,
    newId: () => crypto.randomUUID(),
  });
  const client = createSyncClient(
    { boardId, guestId: session.guestId, displayName },
    session.ports,
  );
  let connection: ReturnType<typeof connectSync> | null = null;
  const controller = createBoardController({ client, send: (lines) => connection?.send(lines) });
  connection = connectSync({
    client,
    url: buildWsUrl(location, boardId),
    createSocket: (url) => new WebSocket(url) as never,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as number),
    onChange: controller.refresh,
  });
  return {
    controller,
    stop() {
      connection?.close();
      session.release();
    },
  };
}
