// T-014 § 1 / ADR-0011 — порт `resume` и второй аргумент `OutboxStore.save(entries, clock)`.
// Имена тестов начинаются с REQ-023: ADR-0011 реализует REQ-023 кр. 1-2
// (офлайн-правки не теряются, очередь уходит после восстановления связи).

import type { Clock } from "@retro/crdt";
import { describe, expect, it } from "vitest";
import { createSyncClient } from "../src/client.js";
import type { OutboxStore, PendingEntry } from "../src/outbox.js";
import type { ClientCorePorts } from "../src/types.js";
import {
  ackMessage,
  makeConfig,
  makePorts,
  parseHello,
  parseOp,
  welcomeMessage,
} from "./fixtures.js";

function spyOutbox() {
  const calls: { entries: readonly PendingEntry[]; clock: Clock }[] = [];
  const store = {
    save(entries: readonly PendingEntry[], clock: Clock) {
      calls.push({ entries, clock });
    },
  } satisfies OutboxStore;
  return { calls, store };
}

const create = (frac: string, text: string) =>
  ({ type: "createSticker", column: "start", frac, text, color: "yellow" }) as const;

/** Первая «сессия»: две офлайн-правки; возвращает то, что персистилось. */
function firstSession() {
  const ports = makePorts();
  const spy = spyOutbox();
  const client = createSyncClient(makeConfig(), { ...ports, outbox: spy.store });
  client.act(create("a", "первый"));
  client.act(create("b", "второй"));
  // Часы формируем независимо от save(): эта фикстура не должна зависеть от проверяемого контракта.
  const saved = {
    entries: [...client.inspect().pending],
    clock: { actor: ports.actorId, counter: 2, lamport: 2 } satisfies Clock,
  };
  return { actorId: ports.actorId, saved, client };
}

describe("OutboxStore.save(entries, clock)", () => {
  it("REQ-023: act() передаёт в save актуальные часы: actor, счётчик dot и lamport", () => {
    const ports = makePorts();
    const spy = spyOutbox();
    const client = createSyncClient(makeConfig(), { ...ports, outbox: spy.store });
    client.act(create("a", "первый"));
    client.act(create("b", "второй"));

    const saved = spy.calls.at(-1);
    expect(saved?.entries).toHaveLength(2);
    expect(saved?.clock.actor).toBe(ports.actorId);
    expect(saved?.clock.counter).toBe(2);
    expect(saved?.clock.lamport).toBeGreaterThanOrEqual(2);
  });

  it("REQ-023: после ack часы в save не откатываются (счётчик остаётся 2, очередь короче)", () => {
    const ports = makePorts();
    const spy = spyOutbox();
    const client = createSyncClient(makeConfig(), { ...ports, outbox: spy.store });
    client.act(create("a", "первый"));
    client.act(create("b", "второй"));
    client.connected();
    client.receive(welcomeMessage({}));

    const first = client.inspect().pending[0];
    if (!first) throw new Error("пусто");
    client.receive(ackMessage(first.dot, 1));

    const saved = spy.calls.at(-1);
    expect(saved?.entries).toHaveLength(1);
    expect(saved?.clock.counter).toBe(2);
    expect(saved?.clock.actor).toBe(ports.actorId);
  });

  it("REQ-023: когда очередь опустела, save получает [] и всё ещё актуальные часы (актор не теряет счётчик)", () => {
    const ports = makePorts();
    const spy = spyOutbox();
    const client = createSyncClient(makeConfig(), { ...ports, outbox: spy.store });
    client.act(create("a", "первый"));
    client.connected();
    client.receive(welcomeMessage({}));
    const only = client.inspect().pending[0];
    if (!only) throw new Error("пусто");
    client.receive(ackMessage(only.dot, 1));

    const saved = spy.calls.at(-1);
    expect(saved?.entries).toEqual([]);
    expect(saved?.clock.counter).toBe(1);
  });
});

describe("ClientCorePorts.resume", () => {
  function resumed() {
    const { actorId, saved } = firstSession();
    const spy = spyOutbox();
    let newActorCalls = 0;
    const ports: ClientCorePorts = {
      newActorId: () => {
        newActorCalls++;
        return "22222222-2222-4222-8222-222222222222";
      },
      newCommandId: () => "cmd-1",
      outbox: spy.store,
      resume: { actorId, clock: saved.clock, pending: saved.entries },
    };
    const client = createSyncClient(makeConfig(), ports);
    return { actorId, saved, spy, client, newActorCalls: () => newActorCalls };
  }

  it("REQ-023: с resume newActorId не вызывается, actorId и P берутся из resume дословно", () => {
    const { actorId, saved, client, newActorCalls } = resumed();

    expect(newActorCalls()).toBe(0);
    const snap = client.inspect();
    expect(snap.actorId).toBe(actorId);
    expect(snap.pending).toEqual(saved.entries);
    expect(snap.status).toBe("offline");
  });

  it("REQ-023: при создании с resume outbox.save не вызывается", () => {
    const { spy } = resumed();
    expect(spy.calls).toEqual([]);
  });

  it("REQ-023: возобновлённые правки сразу видны на экране (view из X_c ⊔ ⨆P)", () => {
    const { client } = resumed();
    const texts = (client.inspect().view.columns.get("start") ?? []).map((c) =>
      "text" in c ? c.text : null,
    );
    expect(texts).toEqual(expect.arrayContaining([["первый"], ["второй"]]));
    expect(texts).toHaveLength(2);
  });

  it("REQ-023: первый hello несёт resume.actorId", () => {
    const { actorId, client } = resumed();
    const sent = client.connected();
    expect(parseHello(sent[0] as string).actorId).toBe(actorId);
  });

  it("REQ-023: после welcome очередь уходит в исходном порядке теми же dot и дельтами", () => {
    const { saved, client } = resumed();
    client.connected();
    const resent = client.receive(welcomeMessage({}));

    expect(resent).toHaveLength(2);
    const ops = resent.map((raw) => parseOp(raw));
    const texts = ops.map((op) => op.delta.entries.find((e) => e.key.field === "text")?.value);
    expect(texts).toEqual(["первый", "второй"]);
    expect(client.inspect().pending.map((p) => p.dot)).toEqual(saved.entries.map((p) => p.dot));
    expect(client.inspect().pending.map((p) => p.delta)).toEqual(saved.entries.map((p) => p.delta));
  });

  it("REQ-023: следующий act продолжает счётчик из resume.clock (без повтора dot)", () => {
    const { actorId, saved, client } = resumed();
    const r = client.act(create("c", "третий"));
    expect(r.ok).toBe(true);

    const pending = client.inspect().pending;
    expect(pending).toHaveLength(3);
    const newest = pending[2];
    expect(newest?.dot.actor).toBe(actorId);
    expect(newest?.dot.counter).toBe(saved.clock.counter + 1);
  });

  it("REQ-023: счётчик продолжается из resume.clock, а не выводится из P (часы впереди очереди)", () => {
    // Часть dot уже подтверждена/отклонена и в P её нет: счётчик 7, в очереди один элемент.
    const { actorId, saved } = firstSession();
    const entry = saved.entries[1] as PendingEntry;
    const spy = spyOutbox();
    const client = createSyncClient(makeConfig(), {
      newActorId: () => {
        throw new Error("не должен вызываться");
      },
      newCommandId: () => "c",
      outbox: spy.store,
      resume: {
        actorId,
        clock: { actor: actorId, counter: 7, lamport: saved.clock.lamport + 10 },
        pending: [entry],
      },
    });

    client.act(create("z", "новый"));
    const newest = client.inspect().pending.at(-1);
    expect(newest?.dot.counter).toBe(8);
    expect(spy.calls.at(-1)?.clock.counter).toBe(8);
  });

  it("REQ-023: ack возобновлённого элемента переносит его в X_c и убирает из P", () => {
    const { saved, client, spy } = resumed();
    client.connected();
    client.receive(welcomeMessage({}));

    const first = saved.entries[0] as PendingEntry;
    client.receive(ackMessage(first.dot, 1));

    expect(client.inspect().pending).toHaveLength(1);
    expect(spy.calls.at(-1)?.entries).toHaveLength(1);
  });

  it("REQ-023: без resume поведение прежнее — newActorId вызывается ровно один раз", () => {
    let calls = 0;
    const ports = makePorts();
    createSyncClient(makeConfig(), {
      ...ports,
      newActorId: () => {
        calls++;
        return ports.actorId;
      },
    });
    expect(calls).toBe(1);
  });
});
