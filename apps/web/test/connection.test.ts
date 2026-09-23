// T-014 § 5 — REQ-023 кр. 1-2, REQ-024 кр. 1: WebSocket-адаптер поверх настоящего
// createSyncClient; сокет и таймеры поддельные.

import { createSyncClient, type SyncClient } from "@retro/client-core";
import { operationDot, serverMessageSchema } from "@retro/protocol";
import { describe, expect, it } from "vitest";
import { buildWsUrl, connectSync } from "../src/sync/connection.js";

const BOARD = "22222222-2222-4222-8222-222222222222";
const ACTOR = "11111111-1111-4111-8111-111111111111";

class FakeSocket {
  sent: string[] = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closeCalls++;
  }
  open() {
    this.onopen?.();
  }
  message(data: string) {
    this.onmessage?.({ data });
  }
  drop() {
    this.onclose?.();
  }
}

function setup(opts: { backoff?: { baseMs: number; maxMs: number } } = {}) {
  const client = createSyncClient(
    { boardId: BOARD, guestId: "guest-1", displayName: "Аня" },
    { newActorId: () => ACTOR, newCommandId: () => "cmd", outbox: { save() {} } },
  );
  const sockets: FakeSocket[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const delays: number[] = [];
  let nextTimer = 1;
  let changes = 0;
  const conn = connectSync({
    client,
    url: "ws://test/api/boards/x/ws",
    createSocket: (url: string) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    setTimer: (fn: () => void, ms: number) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      delays.push(ms);
      return id;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    onChange: () => {
      changes++;
    },
    ...opts,
  });
  const fireTimer = () => {
    const [id, t] = [...timers.entries()][0] ?? [];
    if (id === undefined || !t) throw new Error("нет запланированного таймера");
    timers.delete(id);
    t.fn();
  };
  return { client, conn, sockets, timers, delays, fireTimer, changes: () => changes };
}

const last = <T>(xs: T[]): T => {
  const x = xs.at(-1);
  if (x === undefined) throw new Error("пусто");
  return x;
};

function welcome(): string {
  return JSON.stringify(
    serverMessageSchema.parse({
      type: "welcome",
      role: "participant",
      voterToken: "voter-1",
      meta: {
        boardId: BOARD,
        title: "Ретро",
        phase: "collect",
        revealed: false,
        voteLimit: 3,
        timer: null,
        authors: {},
      },
      snapshot: null,
      ops: [],
    }),
  );
}

const ack = (dot: { actor: string; counter: number }, seq: number) =>
  JSON.stringify({ type: "ack", dot, seq });

function createIntent(client: SyncClient, text: string, frac: string) {
  const r = client.act({ type: "createSticker", column: "start", frac, text, color: "yellow" });
  if (!r.ok) throw new Error("act failed");
  return r;
}

const types = (socket: FakeSocket) => socket.sent.map((s) => JSON.parse(s).type as string);
const opTexts = (socket: FakeSocket) =>
  socket.sent
    .map((s) => JSON.parse(s))
    .filter((m) => m.type === "op")
    .map(
      (m) => m.delta.entries.find((e: { key: { field: string } }) => e.key.field === "text").value,
    );

describe("connectSync: подключение", () => {
  it("REQ-023: сокет создаётся сразу, до onopen ничего не отправляется", () => {
    const { sockets } = setup();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe("ws://test/api/boards/x/ws");
    expect(sockets[0]?.sent).toEqual([]);
  });

  it("REQ-023: onopen — в сокет уходит hello от client.connected() с actorId", () => {
    const { sockets, client } = setup();
    sockets[0]?.open();

    expect(types(sockets[0] as FakeSocket)).toEqual(["hello"]);
    expect(JSON.parse((sockets[0] as FakeSocket).sent[0] as string).actorId).toBe(ACTOR);
    expect(client.inspect().status).toBe("connecting");
  });

  it("REQ-023: onmessage передаёт данные в client.receive и вызывает onChange", () => {
    const { sockets, client, changes } = setup();
    sockets[0]?.open();
    const before = changes();
    sockets[0]?.message(welcome());

    expect(client.inspect().status).toBe("welcomed");
    expect(changes()).toBeGreaterThan(before);
  });
});

describe("connectSync: REQ-023 — офлайн-очередь и переподключение", () => {
  it("REQ-023: офлайн act → open → welcome: очередь уходит в исходном порядке", () => {
    const { sockets, client } = setup();
    createIntent(client, "первый", "a");
    createIntent(client, "второй", "b");
    createIntent(client, "третий", "c");

    const s = sockets[0] as FakeSocket;
    s.open();
    expect(opTexts(s)).toEqual([]);
    s.message(welcome());

    expect(types(s)).toEqual(["hello", "op", "op", "op"]);
    expect(opTexts(s)).toEqual(["первый", "второй", "третий"]);
  });

  it("REQ-023: разрыв → таймер 500 мс → новый сокет → hello; после welcome неподтверждённое уходит заново в том же порядке", () => {
    const { sockets, client, fireTimer, delays } = setup();
    createIntent(client, "первый", "a");
    createIntent(client, "второй", "b");

    const s1 = sockets[0] as FakeSocket;
    s1.open();
    s1.message(welcome());
    expect(opTexts(s1)).toEqual(["первый", "второй"]);

    s1.drop();
    expect(client.inspect().status).toBe("offline");
    expect(last(delays)).toBe(500);
    fireTimer();

    expect(sockets).toHaveLength(2);
    const s2 = sockets[1] as FakeSocket;
    s2.open();
    expect(types(s2)).toEqual(["hello"]);
    s2.message(welcome());

    expect(opTexts(s2)).toEqual(["первый", "второй"]);
  });

  it("REQ-023: повторный ack по дублю не создаёт второго применения — на экране один стикер на dot", () => {
    const { sockets, client, fireTimer } = setup();
    createIntent(client, "первый", "a");
    createIntent(client, "второй", "b");

    const s1 = sockets[0] as FakeSocket;
    s1.open();
    s1.message(welcome());
    const [op1, op2] = s1.sent.filter((m) => JSON.parse(m).type === "op").map((m) => JSON.parse(m));
    const dot1 = operationDot(op1.delta);
    const dot2 = operationDot(op2.delta);

    // ack первого дошёл, потом связь пропала до ack второго.
    s1.message(ack(dot1, 1));
    s1.drop();
    fireTimer();
    const s2 = sockets[1] as FakeSocket;
    s2.open();
    s2.message(welcome());

    // повторно уходит только неподтверждённое
    expect(opTexts(s2)).toEqual(["второй"]);

    // сервер подтверждает второй, а затем присылает дубль ack
    s2.message(ack(dot2, 2));
    s2.message(ack(dot2, 2));
    s2.message(ack(dot1, 1));

    const snap = client.inspect();
    expect(snap.pending).toEqual([]);
    expect(snap.view.columns.get("start")).toHaveLength(2);
  });

  it("REQ-023: onChange вызывается и при разрыве", () => {
    const { sockets, changes } = setup();
    sockets[0]?.open();
    const before = changes();
    sockets[0]?.drop();
    expect(changes()).toBeGreaterThan(before);
  });
});

describe("connectSync: backoff", () => {
  it("REQ-023: задержки 500, 1000, 2000, ... до maxMs=30000 без случайности", () => {
    const { sockets, fireTimer, delays } = setup();
    for (let i = 0; i < 9; i++) {
      (sockets[i] as FakeSocket).drop();
      fireTimer();
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it("REQ-023: после welcome счётчик неудач сбрасывается — следующая задержка снова 500", () => {
    const { sockets, fireTimer, delays } = setup();
    sockets[0]?.drop();
    fireTimer();
    sockets[1]?.drop();
    fireTimer();
    expect(delays).toEqual([500, 1000]);

    const s3 = sockets[2] as FakeSocket;
    s3.open();
    s3.message(welcome());
    s3.drop();

    expect(last(delays)).toBe(500);
  });

  it("REQ-023: backoff настраиваем (baseMs/maxMs)", () => {
    const { sockets, fireTimer, delays } = setup({ backoff: { baseMs: 100, maxMs: 300 } });
    for (let i = 0; i < 3; i++) {
      (sockets[i] as FakeSocket).drop();
      fireTimer();
    }
    expect(delays).toEqual([100, 200, 300]);
  });
});

describe("connectSync: ошибки протокола и send", () => {
  it("REQ-023: receive бросил (мусор от сервера) — исключение не выходит из onmessage, сокет закрывается", () => {
    const { sockets } = setup();
    const s = sockets[0] as FakeSocket;
    s.open();

    expect(() => s.message("это не JSON протокола")).not.toThrow();
    expect(s.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it("REQ-023: после закрытия из-за ошибки обычный onclose приводит к переподключению", () => {
    const { sockets, fireTimer, client } = setup();
    const s = sockets[0] as FakeSocket;
    s.open();
    s.message("мусор");
    s.drop();

    expect(client.inspect().status).toBe("offline");
    fireTimer();
    expect(sockets).toHaveLength(2);
  });

  it("REQ-024: send(strings) в открытый сокет — уходит как есть", () => {
    const { sockets, conn, client } = setup();
    const s = sockets[0] as FakeSocket;
    s.open();
    s.message(welcome());
    const before = s.sent.length;

    const r = createIntent(client, "онлайн", "a");
    conn.send(r.send);

    expect(s.sent.slice(before)).toEqual(r.send);
    expect(opTexts(s)).toEqual(["онлайн"]);
  });

  it("REQ-023: send(strings) до onopen и после разрыва ничего не отправляет и не бросает", () => {
    const { sockets, conn } = setup();
    const s = sockets[0] as FakeSocket;

    expect(() => conn.send(["x"])).not.toThrow();
    expect(s.sent).toEqual([]);

    s.open();
    const afterOpen = s.sent.length;
    s.drop();
    conn.send(["y"]);
    expect(s.sent.length).toBe(afterOpen);
  });
});

describe("connectSync: close()", () => {
  it("REQ-023: close() закрывает сокет, вызывает client.disconnected и не переподключается", () => {
    const { sockets, conn, client, timers } = setup();
    const s = sockets[0] as FakeSocket;
    s.open();
    s.message(welcome());

    conn.close();
    expect(s.closeCalls).toBeGreaterThanOrEqual(1);
    expect(client.inspect().status).toBe("offline");

    s.drop();
    expect(timers.size).toBe(0);
    expect(sockets).toHaveLength(1);
  });

  it("REQ-023: close() во время ожидания переподключения отменяет таймер", () => {
    const { sockets, conn, timers } = setup();
    sockets[0]?.drop();
    expect(timers.size).toBe(1);

    conn.close();
    expect(timers.size).toBe(0);
    expect(sockets).toHaveLength(1);
  });
});

describe("buildWsUrl", () => {
  it("REQ-023: https -> wss, http -> ws, путь /api/boards/:id/ws", () => {
    expect(buildWsUrl({ protocol: "https:", host: "retro.example" }, BOARD)).toBe(
      `wss://retro.example/api/boards/${BOARD}/ws`,
    );
    expect(buildWsUrl({ protocol: "http:", host: "localhost:5173" }, BOARD)).toBe(
      `ws://localhost:5173/api/boards/${BOARD}/ws`,
    );
  });
});
