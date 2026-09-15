// T-028 — остальной контракт `SyncClient` из JSDoc `../src/types.ts`,
// необходимый для REQ-023/REQ-024, но не сформулированный буквально в самих
// критериях: обработка каждого типа `ServerMessage` (`receive()`),
// идемпотентность `connected()`, `disconnected()` и стабильность `actorId`.
//
// `createSyncClient` — заглушка; каждый тест ниже должен падать на
// `Error: createSyncClient: not implemented`.

import { createSticker, empty, equals, newClock } from "@retro/crdt";
import { describe, expect, it } from "vitest";
import { createSyncClient } from "../src/client.js";
import {
  commandResultMessage,
  errorMessage,
  makeConfig,
  makeMeta,
  makePorts,
  metaMessage,
  otherActorId,
  welcomeMessage,
  wireOf,
} from "./fixtures.js";

describe("receive(): сообщения, не прошедшие serverMessageSchema, — исключение, а не молчаливый игнор", () => {
  it("receive(): невалидный JSON (не ServerMessage вовсе) — бросает", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);
    expect(() => client.receive(JSON.stringify({ type: "not-a-real-type" }))).toThrow();
  });

  it("receive(): синтаксически некорректная строка (не JSON) — бросает", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);
    expect(() => client.receive("{ this is not json")).toThrow();
  });
});

describe("receive(welcome): статус, роль, voterToken, meta и слияние snapshot+ops в X_c", () => {
  it("receive(welcome): status становится welcomed, role/meta/voterToken берутся из сообщения", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);
    client.connected();

    const meta = makeMeta({ title: "Ретро команды А" });
    client.receive(welcomeMessage({ role: "facilitator", voterToken: "vt-1", meta }));

    const snapshot = client.inspect();
    expect(snapshot.status).toBe("welcomed");
    expect(snapshot.role).toBe("facilitator");
    expect(snapshot.voterToken).toBe("vt-1");
    expect(snapshot.meta).toEqual(meta);
  });

  it("receive(welcome): X_c = snapshot ⊔ ops; lastSeq = максимум из upToSeq и seq всех ops", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);
    client.connected();

    const otherActor = otherActorId();
    const snapshotCreate = createSticker(empty(), newClock(otherActor), {
      column: "start",
      frac: "a",
      text: "из снапшота",
      color: "yellow",
    });

    const opCreate = createSticker(empty(), newClock(otherActorId()), {
      column: "stop",
      frac: "b",
      text: "из ops",
      color: "green",
    });

    client.receive(
      welcomeMessage({
        snapshot: { upToSeq: 3, state: wireOf(snapshotCreate.delta) },
        ops: [{ seq: 6, delta: wireOf(opCreate.delta) }],
      }),
    );

    const snapshot = client.inspect();
    expect(snapshot.lastSeq).toBe(6);

    const start = snapshot.view.columns.get("start") ?? [];
    const stop = snapshot.view.columns.get("stop") ?? [];
    expect(start.some((item) => "text" in item && item.text.includes("из снапшота"))).toBe(true);
    expect(stop.some((item) => "text" in item && item.text.includes("из ops"))).toBe(true);
  });
});

describe("receive(op): чужая операция, в т.ч. пришедшая раньше welcome, не отбрасывается", () => {
  it("receive(op) до welcome (status = connecting): всё равно сливается в X_c и видно на экране", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);
    client.connected();
    expect(client.inspect().status).toBe("connecting");

    const foreign = createSticker(empty(), newClock(otherActorId()), {
      column: "continue",
      frac: "a",
      text: "пришло до welcome",
      color: "pink",
    });

    client.receive(JSON.stringify({ type: "op", seq: 1, delta: wireOf(foreign.delta) }));

    const view = client.inspect().view;
    const column = view.columns.get("continue") ?? [];
    expect(column.some((item) => "text" in item && item.text.includes("пришло до welcome"))).toBe(
      true,
    );
  });

  it("receive(op): lastSeq растёт монотонно (max прежнего и нового seq)", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);
    client.connected();
    client.receive(welcomeMessage({ ops: [] }));
    expect(client.inspect().lastSeq).toBeNull();

    const foreign = createSticker(empty(), newClock(otherActorId()), {
      column: "start",
      frac: "a",
      text: "op",
      color: "yellow",
    });
    client.receive(JSON.stringify({ type: "op", seq: 9, delta: wireOf(foreign.delta) }));
    expect(client.inspect().lastSeq).toBe(9);
  });
});

describe("receive(meta): обновляет BoardMeta снимка независимо от welcome", () => {
  it("receive(meta): snapshot.meta заменяется на присланный", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);
    client.connected();
    client.receive(welcomeMessage({ meta: makeMeta({ phase: "collect" }) }));

    const nextMeta = makeMeta({ phase: "group" });
    client.receive(metaMessage(nextMeta));

    expect(client.inspect().meta).toEqual(nextMeta);
  });
});

describe("receive(commandResult): не бросает (наблюдаемого поля в ClientSnapshot для него нет — см. неясности)", () => {
  it("receive(commandResult): валидное сообщение обрабатывается без исключения", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);
    client.connected();
    client.receive(welcomeMessage({}));

    expect(() => client.receive(commandResultMessage("cmd-1", true))).not.toThrow();
    expect(() =>
      client.receive(
        commandResultMessage("cmd-2", false, { reason: "forbidden", message: "нет прав" }),
      ),
    ).not.toThrow();
  });
});

describe("receive(error): фатальная ошибка сервера переводит клиента в offline", () => {
  it("receive(error): status становится offline (сервер разорвёт соединение)", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);
    client.connected();
    client.receive(welcomeMessage({}));
    expect(client.inspect().status).toBe("welcomed");

    client.receive(errorMessage("rate_limited", "слишком часто"));
    expect(client.inspect().status).toBe("offline");
  });
});

describe("connected()/disconnected(): идемпотентность и стабильность actorId", () => {
  it("connected(): повторный вызов, пока уже не offline, — идемпотентный no-op ([])", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    const first = client.connected();
    expect(first).toHaveLength(1);

    const second = client.connected();
    expect(second).toEqual([]);
    expect(client.inspect().status).toBe("connecting");
  });

  it("connected(): no-op, если клиент уже welcomed", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);
    client.connected();
    client.receive(welcomeMessage({}));

    expect(client.connected()).toEqual([]);
    expect(client.inspect().status).toBe("welcomed");
  });

  it("disconnected(): status → offline; X_c и P не меняются", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);
    client.connected();
    client.receive(welcomeMessage({}));

    client.act({
      type: "createSticker",
      column: "start",
      frac: "a",
      text: "офлайн-стикер",
      color: "blue",
    });
    const beforeConfirmed = client.inspect().confirmed;
    const beforePending = client.inspect().pending;

    client.disconnected();

    const after = client.inspect();
    expect(after.status).toBe("offline");
    expect(equals(after.confirmed, beforeConfirmed)).toBe(true);
    expect(after.pending).toEqual(beforePending);
  });

  it("ports.newActorId(): вызывается РОВНО ОДИН РАЗ за жизнь экземпляра, даже через несколько connected()/disconnected()", () => {
    let calls = 0;
    const base = makePorts();
    const ports = {
      ...base,
      newActorId: () => {
        calls++;
        return base.actorId;
      },
    };
    const client = createSyncClient(makeConfig(), ports);

    client.connected();
    client.receive(welcomeMessage({}));
    client.disconnected();
    client.connected();
    client.receive(welcomeMessage({}));
    client.disconnected();

    expect(calls).toBe(1);
  });
});
