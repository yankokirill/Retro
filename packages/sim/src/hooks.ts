// Точки подмены на границах ядер — docs/spec/simulator.md § 10.2 (мутанты). Только типы: сам
// мир (world.ts/apply.ts) знает лишь об этих четырёх местах и не содержит ни одного «флага
// сломать себя»; конкретные поломки собраны отдельно в mutants.ts и в продуктовый код не попадают.

import type { BoardServer, MemoryBoardStore } from "@retro/server-core";

export interface WorldHooks {
  /** Порт хранилища: возвращает обёртку над настоящим `MemoryBoardStore` (M4, M5, M7). */
  readonly wrapStore?: (store: MemoryBoardStore) => MemoryBoardStore;
  /** Ядро сервера: обёртка над настоящим `BoardServer` (M3, M6). */
  readonly wrapServer?: (
    server: BoardServer,
    context: { readonly store: MemoryBoardStore; readonly boardId: string },
  ) => BoardServer;
  /** Сеть «сервер → клиент»: сообщение, которое клиент получит вместо посланного (M2). */
  readonly toClient?: (raw: string) => string;
  /** Сеть «клиент → сервер»: ответы клиента на полученное сообщение, которые дойдут до канала (M1). */
  readonly clientReplies?: (received: string, replies: readonly string[]) => readonly string[];
}
