// Персистентность очереди P — docs/spec/simulator.md § 13 (ВС-1).
//
// client-core не решает, ПЕРЕЖИВАЕТ ли очередь перезагрузку вкладки и как —
// это ADR в T-014 (браузерный адаптер: IndexedDB, актор при возобновлении
// и т.п.). Здесь только контракт стока: client-core вызывает `save` после
// каждого изменения P (act/ack/reject), ничего из него не читает сам —
// это чистый write-through лог для того, кто решит его использовать.

import type { Dot, WireDelta } from "@retro/crdt";
import type { Intent } from "./types.js";

/**
 * Один элемент очереди P. `dot` — то же, что вернул бы `operationDot(delta)`
 * (`@retro/protocol`): для `create`/`write`/`vote` — собственный dot операции;
 * для `unvote` — dot ОТЗЫВАЕМОГО голоса (у unvote нет своего, § 3.1
 * `consistency-model.md`). Это тот же dot, что несёт `ack`/`reject` сервера
 * для этой операции (protocol.md § 5) — по нему `SyncClient.receive`
 * сопоставляет ответ сервера с элементом P.
 */
export interface PendingEntry {
  /**
   * Намерение, из которого построена `delta` (ADR-0010): при отказе более
   * ранней дельты, от которой эта зависит только по перекрытию, дельта
   * пересобирается из намерения над новым `X_c ⊔ ⨆P`.
   */
  readonly intent: Intent;
  readonly delta: WireDelta;
  readonly dot: Dot;
  readonly kind: "op" | "unvote";
}

export interface OutboxStore {
  /** Полная замена содержимого — вызывается после каждого изменения P. */
  save(entries: readonly PendingEntry[]): void;
}

/**
 * Реализация по умолчанию — для тестов и `packages/sim` (T-005): держит
 * последний переданный `save` снимок в памяти процесса. `read()` — не часть
 * `OutboxStore` (client-core её не вызывает), а только для проверки в тестах.
 */
export function createMemoryOutboxStore(): OutboxStore & {
  read(): readonly PendingEntry[];
} {
  let entries: readonly PendingEntry[] = [];
  return {
    save(next) {
      entries = next;
    },
    read() {
      return entries;
    },
  };
}
