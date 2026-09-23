// T-014 § 4 — ADR-0011: Web Lock на гостя, возобновление актора и очереди.

import { createSyncClient, type PendingEntry } from "@retro/client-core";
import type { Clock } from "@retro/crdt";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { openIdbOutbox } from "../src/sync/idb-outbox.js";
import { startSession } from "../src/sync/session.js";

const BOARD = "22222222-2222-4222-8222-222222222222";
const ACTOR = "11111111-1111-4111-8111-111111111111";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

/** Поддельный LockManager: `grant` решает, отдаём лок или `null` (занят). */
function fakeLocks(grant: boolean) {
  const requests: { name: string; options: unknown }[] = [];
  let held = false;
  let done = false;
  return {
    requests,
    isHeld: () => held,
    isDone: () => done,
    request(
      name: string,
      options: { ifAvailable: true },
      callback: (lock: object | null) => Promise<unknown>,
    ): Promise<unknown> {
      requests.push({ name, options });
      held = grant;
      const result = callback(grant ? { name } : null);
      return result.then((v) => {
        held = false;
        done = true;
        return v;
      });
    },
  };
}

function makeSeed(): { entries: PendingEntry[]; clock: Clock } {
  const client = createSyncClient(
    { boardId: BOARD, guestId: "guest-1", displayName: "Аня" },
    { newActorId: () => ACTOR, newCommandId: () => "c", outbox: { save() {} } },
  );
  for (const frac of ["a", "b"]) {
    client.act({ type: "createSticker", column: "start", frac, text: frac, color: "yellow" });
  }
  return {
    entries: [...client.inspect().pending],
    clock: { actor: ACTOR, counter: 2, lamport: 2 },
  };
}

async function seedIdb(factory: IDBFactory, key: string) {
  const seed = makeSeed();
  const outbox = await openIdbOutbox(factory, key);
  outbox.save(seed.entries, seed.clock);
  await outbox.flush();
  outbox.close();
  return seed;
}

function counterId() {
  let n = 0;
  const calls = { count: 0 };
  return {
    calls,
    newId: () => {
      calls.count++;
      return `id-${++n}`;
    },
  };
}

const LOCK_NAME = `retro:${BOARD}:guest-1`;
const storedGuest = () => memoryStorage({ "retro.guestId": "guest-1", "retro.displayName": "Аня" });

describe("startSession", () => {
  it("REQ-023: лок запрашивается с именем retro:<boardId>:<guestId> и ifAvailable", async () => {
    const locks = fakeLocks(true);
    const ids = counterId();
    const session = await startSession({
      boardId: BOARD,
      storage: storedGuest(),
      idb: new IDBFactory(),
      locks,
      newId: ids.newId,
    });

    expect(locks.requests).toHaveLength(1);
    expect(locks.requests[0]?.name).toBe(LOCK_NAME);
    expect(locks.requests[0]?.options).toEqual({ ifAvailable: true });
    expect(session.guestId).toBe("guest-1");
    expect(session.displayName).toBe("Аня");
    session.release();
  });

  it("REQ-023: лок получен, очереди нет — свежий актор, resumed=false, persistent=true", async () => {
    const ids = counterId();
    const session = await startSession({
      boardId: BOARD,
      storage: storedGuest(),
      idb: new IDBFactory(),
      locks: fakeLocks(true),
      newId: ids.newId,
    });

    expect(session.resumed).toBe(false);
    expect(session.persistent).toBe(true);
    expect(session.ports.resume).toBeUndefined();
    expect(typeof session.ports.newActorId()).toBe("string");
    expect(typeof session.ports.newCommandId()).toBe("string");
    session.release();
  });

  it("REQ-023: лок получен и в IndexedDB непустая очередь — ports.resume с тем же актором, newActorId не вызывался", async () => {
    const factory = new IDBFactory();
    const seed = await seedIdb(factory, LOCK_NAME);
    const ids = counterId();

    const session = await startSession({
      boardId: BOARD,
      storage: storedGuest(),
      idb: factory,
      locks: fakeLocks(true),
      newId: ids.newId,
    });

    expect(session.resumed).toBe(true);
    expect(session.persistent).toBe(true);
    expect(session.ports.resume).toEqual({
      actorId: ACTOR,
      clock: seed.clock,
      pending: seed.entries,
    });
    // guestId уже был в storage, актор не выдавался — newId не должен был вызываться вовсе.
    expect(ids.calls.count).toBe(0);
    session.release();
  });

  it("REQ-023: возобновлённая сессия отдаёт клиенту ядра ту же очередь и того же актора", async () => {
    const factory = new IDBFactory();
    const seed = await seedIdb(factory, LOCK_NAME);
    const session = await startSession({
      boardId: BOARD,
      storage: storedGuest(),
      idb: factory,
      locks: fakeLocks(true),
      newId: counterId().newId,
    });

    const client = createSyncClient(
      { boardId: BOARD, guestId: session.guestId, displayName: "Аня" },
      session.ports,
    );
    expect(client.inspect().actorId).toBe(ACTOR);
    expect(client.inspect().pending).toEqual(seed.entries);
    session.release();
  });

  it("REQ-023: лок удерживается до release() — промис callback завершается только в release", async () => {
    const locks = fakeLocks(true);
    const session = await startSession({
      boardId: BOARD,
      storage: storedGuest(),
      idb: new IDBFactory(),
      locks,
      newId: counterId().newId,
    });

    await Promise.resolve();
    expect(locks.isHeld()).toBe(true);
    expect(locks.isDone()).toBe(false);

    session.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(locks.isDone()).toBe(true);
    expect(locks.isHeld()).toBe(false);
  });

  it("REQ-023: лок занят — новый актор, очередь в памяти, persistent=false, resumed=false; чужая запись не тронута", async () => {
    const factory = new IDBFactory();
    const seed = await seedIdb(factory, LOCK_NAME);

    const session = await startSession({
      boardId: BOARD,
      storage: storedGuest(),
      idb: factory,
      locks: fakeLocks(false),
      newId: counterId().newId,
    });

    expect(session.resumed).toBe(false);
    expect(session.persistent).toBe(false);
    expect(session.ports.resume).toBeUndefined();

    // Вторая вкладка пишет свою очередь — персистентная запись первой остаётся прежней.
    session.ports.outbox.save([], { actor: "other", counter: 9, lamport: 9 });
    await new Promise((r) => setTimeout(r, 20));

    const check = await openIdbOutbox(factory, LOCK_NAME);
    expect(await check.load()).toEqual({
      actorId: ACTOR,
      clock: seed.clock,
      pending: seed.entries,
    });
    check.close();
    session.release();
  });

  it("REQ-023: Web Locks недоступны — новый актор, память, persistent=false", async () => {
    const session = await startSession({
      boardId: BOARD,
      storage: storedGuest(),
      idb: new IDBFactory(),
      locks: undefined,
      newId: counterId().newId,
    });
    expect(session.persistent).toBe(false);
    expect(session.resumed).toBe(false);
    expect(session.ports.resume).toBeUndefined();
    session.release();
  });

  it("REQ-023: IndexedDB недоступна — новый актор, память, persistent=false", async () => {
    const session = await startSession({
      boardId: BOARD,
      storage: storedGuest(),
      idb: undefined,
      locks: fakeLocks(true),
      newId: counterId().newId,
    });
    expect(session.persistent).toBe(false);
    expect(session.resumed).toBe(false);
    session.release();
  });

  it("REQ-002: первый заход — guestId создаётся через newId и записывается в storage", async () => {
    const storage = memoryStorage();
    const locks = fakeLocks(true);
    const session = await startSession({
      boardId: BOARD,
      storage,
      idb: new IDBFactory(),
      locks,
      newId: counterId().newId,
    });

    expect(session.displayName).toBeNull();
    expect(storage.data.get("retro.guestId")).toBe(session.guestId);
    expect(locks.requests[0]?.name).toBe(`retro:${BOARD}:${session.guestId}`);
    session.release();
  });
});
