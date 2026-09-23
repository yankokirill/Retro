// Очередь P в IndexedDB — ADR-0011. Запись одна на ключ: { actorId, clock, pending }.

import type { OutboxStore, PendingEntry } from "@retro/client-core";
import type { Clock } from "@retro/crdt";

export interface ResumeRecord {
  readonly actorId: string;
  readonly clock: Clock;
  readonly pending: readonly PendingEntry[];
}

export type IdbOutbox = OutboxStore & {
  load(): Promise<ResumeRecord | null>;
  flush(): Promise<void>;
  close(): void;
};

const STORE = "outbox";
const RECORD_KEY = "queue";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function openIdbOutbox(factory: IDBFactory, key: string): Promise<IdbOutbox> {
  const opening = factory.open(`retro-outbox:${key}`, 1);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore(STORE);
  };
  const db = await request(opening);

  // Записи выстраиваются в цепочку: порядок вызовов save сохраняется, побеждает последний.
  let chain: Promise<void> = Promise.resolve();

  function put(record: ResumeRecord): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record, RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  return {
    save(entries, clock) {
      const record: ResumeRecord = { actorId: clock.actor, clock, pending: [...entries] };
      // Сбой записи не должен ронять интерфейс: очередь остаётся в памяти ядра.
      chain = chain.then(() => put(record)).catch(() => undefined);
    },
    async load() {
      await chain;
      const tx = db.transaction(STORE, "readonly");
      const record = (await request(tx.objectStore(STORE).get(RECORD_KEY))) as
        | ResumeRecord
        | undefined;
      if (!record || record.pending.length === 0) return null;
      return record;
    },
    flush: () => chain,
    close() {
      db.close();
    },
  };
}
