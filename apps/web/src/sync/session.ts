// Сессия вкладки — ADR-0011: Web Lock на (доска, гость) даёт право продолжить
// персистентную очередь тем же актором; вкладка без лока работает с пустой очередью в памяти.

import {
  type ClientCorePorts,
  createMemoryOutboxStore,
  type OutboxStore,
} from "@retro/client-core";
import { loadGuestIdentity } from "./guest.js";
import { openIdbOutbox } from "./idb-outbox.js";

export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: object | null) => Promise<unknown>,
  ): Promise<unknown>;
}

export interface SessionDeps {
  readonly boardId: string;
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly idb: IDBFactory | undefined;
  readonly locks: LockManagerLike | undefined;
  readonly newId: () => string;
}

export interface Session {
  readonly guestId: string;
  readonly displayName: string | null;
  readonly ports: ClientCorePorts;
  readonly resumed: boolean;
  readonly persistent: boolean;
  release(): void;
}

/** Берёт лок и возвращает функцию отпускания; `null` — лок занят или Web Locks недоступны. */
async function acquireLock(
  locks: LockManagerLike | undefined,
  name: string,
): Promise<(() => void) | null> {
  if (!locks) return null;
  return new Promise((resolve) => {
    void locks.request(name, { ifAvailable: true }, (lock) => {
      if (lock === null) {
        resolve(null);
        return Promise.resolve();
      }
      return new Promise<void>((release) => resolve(() => release()));
    });
  });
}

export async function startSession(deps: SessionDeps): Promise<Session> {
  const { guestId, displayName } = loadGuestIdentity(deps.storage, deps.newId);
  const lockName = `retro:${deps.boardId}:${guestId}`;
  const release = await acquireLock(deps.locks, lockName);

  const base = { guestId, displayName };
  const common = { newActorId: deps.newId, newCommandId: deps.newId };

  if (release === null || deps.idb === undefined) {
    const outbox: OutboxStore = createMemoryOutboxStore();
    return {
      ...base,
      ports: { ...common, outbox },
      resumed: false,
      persistent: false,
      release: release ?? (() => undefined),
    };
  }

  const outbox = await openIdbOutbox(deps.idb, lockName);
  const record = await outbox.load();
  return {
    ...base,
    ports: record ? { ...common, outbox, resume: record } : { ...common, outbox },
    resumed: record !== null,
    persistent: true,
    release() {
      release();
      outbox.close();
    },
  };
}
