// T-014 § 3 — ADR-0011: очередь P и часы в IndexedDB.

import { createSyncClient, type PendingEntry } from "@retro/client-core";
import type { Clock } from "@retro/crdt";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { openIdbOutbox } from "../src/sync/idb-outbox.js";

function makeEntries(count: number): { entries: PendingEntry[]; clock: Clock; actorId: string } {
  const actorId = "11111111-1111-4111-8111-111111111111";
  const client = createSyncClient(
    { boardId: "22222222-2222-4222-8222-222222222222", guestId: "g", displayName: "Аня" },
    { newActorId: () => actorId, newCommandId: () => "c", outbox: { save() {} } },
  );
  for (let i = 0; i < count; i++) {
    const r = client.act({
      type: "createSticker",
      column: "start",
      frac: String.fromCharCode(97 + i),
      text: `стикер ${i}`,
      color: "yellow",
    });
    if (!r.ok) throw new Error("act failed");
  }
  return {
    entries: [...client.inspect().pending],
    clock: { actor: actorId, counter: count, lamport: count },
    actorId,
  };
}

describe("openIdbOutbox", () => {
  it("REQ-023: пустая база — load() возвращает null", async () => {
    const outbox = await openIdbOutbox(new IDBFactory(), "k");
    expect(await outbox.load()).toBeNull();
    outbox.close();
  });

  it("REQ-023: save + flush + load — структурно те же entries и clock, actorId = clock.actor", async () => {
    const { entries, clock, actorId } = makeEntries(2);
    const outbox = await openIdbOutbox(new IDBFactory(), "k");

    outbox.save(entries, clock);
    await outbox.flush();

    const loaded = await outbox.load();
    expect(loaded).toEqual({ actorId, clock, pending: entries });
    outbox.close();
  });

  it("REQ-023: запись переживает переоткрытие базы (перезагрузка вкладки)", async () => {
    const factory = new IDBFactory();
    const { entries, clock } = makeEntries(3);

    const first = await openIdbOutbox(factory, "k");
    first.save(entries, clock);
    await first.flush();
    first.close();

    const second = await openIdbOutbox(factory, "k");
    const loaded = await second.load();
    expect(loaded?.pending).toEqual(entries);
    expect(loaded?.clock).toEqual(clock);
    second.close();
  });

  it("REQ-023: несколько save подряд без ожидания — побеждает последний", async () => {
    const { entries, clock } = makeEntries(3);
    const outbox = await openIdbOutbox(new IDBFactory(), "k");

    outbox.save(entries.slice(0, 1), { ...clock, counter: 1 });
    outbox.save(entries.slice(0, 2), { ...clock, counter: 2 });
    outbox.save(entries, clock);
    await outbox.flush();

    const loaded = await outbox.load();
    expect(loaded?.pending).toEqual(entries);
    expect(loaded?.clock.counter).toBe(clock.counter);
    outbox.close();
  });

  it("REQ-023: пустая очередь — load() null, даже если раньше очередь была непустой (ADR-0011)", async () => {
    const { entries, clock } = makeEntries(2);
    const outbox = await openIdbOutbox(new IDBFactory(), "k");

    outbox.save(entries, clock);
    outbox.save([], { ...clock, counter: 5 });
    await outbox.flush();

    expect(await outbox.load()).toBeNull();
    outbox.close();
  });

  it("REQ-023: разные key — независимые записи", async () => {
    const factory = new IDBFactory();
    const a = makeEntries(1);
    const b = makeEntries(2);
    const outA = await openIdbOutbox(factory, "board:a");
    const outB = await openIdbOutbox(factory, "board:b");

    outA.save(a.entries, a.clock);
    outB.save(b.entries, b.clock);
    await Promise.all([outA.flush(), outB.flush()]);

    expect((await outA.load())?.pending).toHaveLength(1);
    expect((await outB.load())?.pending).toHaveLength(2);
    outA.close();
    outB.close();
  });

  it("REQ-023: save синхронный — возвращает управление до записи и не бросает", async () => {
    const { entries, clock } = makeEntries(1);
    const outbox = await openIdbOutbox(new IDBFactory(), "k");
    const result = outbox.save(entries, clock);
    expect(result).toBeUndefined();
    await outbox.flush();
    outbox.close();
  });
});
