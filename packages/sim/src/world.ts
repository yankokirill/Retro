// Мир прогона — docs/spec/simulator.md § 1 («мир»), § 3 («Модель мира»).
// Единственное состояние, которое меняет `applyEvent` (apply.ts). Не
// экспортирует ничего похожего на `Date.now`/`Math.random` — вся случайность
// приходит через `Prng`, переданный в `createWorld` (правило 7 CLAUDE.md).

import type { OutboxStore, PendingEntry, SyncClient } from "@retro/client-core";
import type { EntityId } from "@retro/crdt";
import type { Role } from "@retro/protocol";
import type { BoardServer, MemoryBoardStore } from "@retro/server-core";
import type { SimConfig } from "./config.js";
import type { Connection } from "./network.js";
import type { OracleState } from "./oracle.js";
import type { Prng } from "./prng.js";
import type { Stats } from "./stats.js";

export interface Guest {
  readonly id: string;
  readonly role: Role;
  readonly displayName: string;
}

export interface ClientState {
  readonly guestIndex: number;
  /** Экземпляр ядра клиента — заменяется целиком при E6 (`reload`, ВС-1(а)). */
  core: SyncClient;
  outbox: OutboxStore & { read(): readonly PendingEntry[] };
  /** Индекс в `World.connections`; `null` — клиент офлайн, соединения ещё/уже нет. */
  connection: number | null;
}

export interface World {
  readonly config: SimConfig;
  readonly boardId: string;
  readonly guests: readonly Guest[];
  readonly clients: readonly ClientState[];
  /** Растёт по ходу прогона — каждое E5 (`connect`) добавляет соединение, старые не переиспользуются. */
  readonly connections: Connection[];
  readonly store: MemoryBoardStore;
  readonly server: BoardServer;
  /** Счётчик выполненных E1 — бюджет `--ops` (§ 6 проекта, план главного цикла). */
  acts: number;
  /** Последние затронутые сущности, не больше 3 — «горячая цель» (§ 5.1). */
  readonly recent: EntityId[];
  readonly stats: Stats;
  readonly oracle: OracleState;
}

/**
 * Детерминированный заменитель `apps/server/src/auth/voter-token.ts`
 * (который использует `node:crypto`, запрещённый в чистых пакетах). Здесь
 * не нужны криптографические свойства — только устойчивое сопоставление
 * (доска, гость) → токен, уникальное в пределах одного прогона.
 */
export function voterToken(boardId: string, guestId: string): string {
  return `${boardId}:${guestId}`;
}

/**
 * Собирает мир: доска, гости и роли, распределение вкладок по гостям
 * (§ 3 спецификации — ровно один owner, 0–1 facilitator, 0–1 viewer,
 * остальные participant; при `clients >= 3` хотя бы у одного гостя
 * >= 2 вкладки), `MemoryBoardStore`, `createBoardServer`. Все клиенты
 * начинают офлайн (`connection: null`) — E5 подключает их по расписанию
 * планировщика, включая «поздних участников» с `lastSeq = null` с самого начала.
 */
export function createWorld(config: SimConfig, prng: Prng): World {
  throw new Error("createWorld: not implemented");
}

/** Отмечает сущность как недавно затронутую (§ 5.1 «горячая цель») — не более 3 последних, самая новая в конце. */
export function touchRecent(world: World, id: EntityId): void {
  const idx = world.recent.indexOf(id);
  if (idx !== -1) world.recent.splice(idx, 1);
  world.recent.push(id);
  while (world.recent.length > 3) world.recent.shift();
}
