// Мир прогона — docs/spec/simulator.md § 1 («мир»), § 3 («Модель мира»).
// Единственное состояние, которое меняет `applyEvent` (apply.ts). Не
// экспортирует ничего похожего на `Date.now`/`Math.random` — вся случайность
// приходит через `Prng`, переданный в `createWorld` (правило 7 CLAUDE.md).

import {
  createMemoryOutboxStore,
  createSyncClient,
  type OutboxStore,
  type PendingEntry,
  type SyncClient,
} from "@retro/client-core";
import type { EntityId } from "@retro/crdt";
import type { Role } from "@retro/protocol";
import {
  type BoardServer,
  createBoardServer,
  createMemoryBoardStore,
  type MemoryBoardStore,
} from "@retro/server-core";
import type { SnapshotObservation } from "./checks.js";
import type { SimConfig } from "./config.js";
import type { Connection } from "./network.js";
import { createOracleState, type OracleState } from "./oracle.js";
import type { Prng } from "./prng.js";
import { createStats, type Stats } from "./stats.js";

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
  /** E8, ещё не сверенные с X_S на контрольной точке (S8) — apply.ts копит, run.ts проверяет и опустошает. */
  readonly snapshotsObserved: SnapshotObservation[];
  /**
   * Взведена E9 (`storeFault`), ещё не разрешилась замеченным `error`.
   * Хранилище — один общий `MemoryBoardStore` на доску, поэтому неисправность
   * не привязана к конкретному соединению: её погасит первый `error` от
   * любого клиента (apply.ts, обработка `deliver toServer`).
   */
  pendingStoreFault: boolean;
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
  const boardId = prng.uuid();

  // Гости и роли (§ 3): ровно один owner, 0–1 facilitator, 0–1 viewer,
  // остальные participant. При clients >= 3 хотя бы у одного гостя >= 2
  // вкладки — достигается тем, что гостей меньше, чем клиентов.
  const guestCount = config.clients >= 3 ? config.clients - 1 : config.clients;
  const tabsPerGuest = new Array<number>(guestCount).fill(1);
  let remainingTabs = config.clients - guestCount;
  while (remainingTabs > 0) {
    const idx = prng.int(0, guestCount - 1);
    const current = tabsPerGuest[idx];
    tabsPerGuest[idx] = (current ?? 1) + 1;
    remainingTabs -= 1;
  }

  const roles: Role[] = new Array(guestCount).fill("participant");
  roles[0] = "owner";
  let nextRoleIndex = 1;
  if (guestCount > nextRoleIndex && prng.next() < 0.6) {
    roles[nextRoleIndex] = "facilitator";
    nextRoleIndex += 1;
  }
  if (guestCount > nextRoleIndex && prng.next() < 0.3) {
    roles[nextRoleIndex] = "viewer";
  }

  const guests: Guest[] = [];
  for (let i = 0; i < guestCount; i++) {
    guests.push({
      id: prng.uuid(),
      role: roles[i] ?? "participant",
      displayName: `Guest ${i + 1}`,
    });
  }

  const [voteLimitMin, voteLimitMax] = config.profile.voteLimitRange;
  const voteLimit = prng.int(voteLimitMin, voteLimitMax);

  const store = createMemoryBoardStore({ seqGap: () => (prng.next() < 0.7 ? 0 : prng.int(1, 3)) });
  const owner = guests[0];
  if (!owner) throw new Error("createWorld: at least one guest is required");
  store.createBoard({
    id: boardId,
    title: "Retro",
    ownerId: owner.id,
    ownerName: owner.displayName,
    voteLimit,
  });
  for (let i = 1; i < guests.length; i++) {
    const guest = guests[i];
    if (!guest) continue;
    store.addMember(boardId, guest.id, guest.role, guest.displayName);
  }

  const server = createBoardServer({
    store,
    voterToken: (boardIdArg, guestId) => voterToken(boardIdArg, guestId),
  });

  const clients: ClientState[] = [];
  for (let guestIndex = 0; guestIndex < guestCount; guestIndex++) {
    const tabs = tabsPerGuest[guestIndex] ?? 1;
    const guest = guests[guestIndex];
    if (!guest) continue;
    for (let t = 0; t < tabs; t++) {
      const outbox = createMemoryOutboxStore();
      const core = createSyncClient(
        { boardId, guestId: guest.id, displayName: guest.displayName },
        { newActorId: () => prng.uuid(), newCommandId: () => prng.uuid(), outbox },
      );
      clients.push({ guestIndex, core, outbox, connection: null });
    }
  }

  return {
    config,
    boardId,
    guests,
    clients,
    connections: [],
    store,
    server,
    acts: 0,
    recent: [],
    stats: createStats(),
    oracle: createOracleState(),
    snapshotsObserved: [],
    pendingStoreFault: false,
  };
}

/** Отмечает сущность как недавно затронутую (§ 5.1 «горячая цель») — не более 3 последних, самая новая в конце. */
export function touchRecent(world: World, id: EntityId): void {
  const idx = world.recent.indexOf(id);
  if (idx !== -1) world.recent.splice(idx, 1);
  world.recent.push(id);
  while (world.recent.length > 3) world.recent.shift();
}
