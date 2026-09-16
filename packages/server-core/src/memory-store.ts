// T-025 (docs/design/T-005-simulator.md § 3.4). `MemoryBoardStore` —
// адаптер порта `BoardStore` в памяти: та же контрактная логика, что
// `PgBoardStore` (T-024), без БД — для `packages/sim` (T-005, детерминизм
// и скорость) и для `test:unit` (SIM-03: контрактный набор зелёный на
// обоих адаптерах). Помимо порта несёт настройку мира (доска/участники —
// вне протокола WS, REST в симуляторе не моделируется) и управляемые
// неисправности/наблюдение для оракула и тестов.
//
// Реализация — следующий шаг T-025 (после того, как test-author допишет
// контракт и тесты ядра); сейчас — заглушка, как `createBoardServer` в T-024.

import type { Role } from "@retro/protocol";
import type { BoardStore, OpRow } from "./store.js";

export interface MemoryBoardStore extends BoardStore {
  /**
   * Заводит доску и сразу владельца в участниках с ролью `owner`
   * (как `boardsService.createBoard`, apps/server) — отдельного вызова
   * `addMember` для владельца не нужно.
   */
  createBoard(input: {
    readonly id: string;
    readonly title: string;
    readonly ownerId: string;
    readonly ownerName: string;
    readonly voteLimit: number;
  }): void;
  addMember(boardId: string, guestId: string, role: Role, displayName: string): void;
  /** E8 (docs/spec/simulator.md § 4.2): снапшот текущего состояния доски на её `lastSeq`. */
  saveSnapshot(boardId: string): void;
  /**
   * E9: следующая транзакция (`tx.appendOp`/`tx.recordAuthor`) хранилища
   * падает после `afterWrites`-й успешной записи в её буфер, ничего не
   * применив; если записей в транзакции меньше — падает при попытке
   * зафиксироваться. Неисправность одноразовая.
   */
  failNextTransaction(afterWrites: number): void;
  /** Сырые строки журнала доски, по возрастанию `seq` — для оракула симулятора. */
  log(boardId: string): readonly OpRow[];
}

export interface MemoryBoardStoreOptions {
  /** Пропуск seq перед следующей записью (≥ 0); единственный источник «случайности» — передаётся симулятором. */
  readonly seqGap?: () => number;
}

export function createMemoryBoardStore(_options?: MemoryBoardStoreOptions): MemoryBoardStore {
  throw new Error("createMemoryBoardStore: not implemented");
}
