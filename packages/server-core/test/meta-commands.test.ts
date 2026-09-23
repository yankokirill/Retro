// T-030 (docs/design/T-030-meta-commands.md, docs/spec/protocol.md § 6
// «Команды метаданных»): grantFacilitator (REQ-003 кр. 2–3), startTimer /
// stopTimer (REQ-019 кр. 2), таймер переживает переподключение (REQ-027).
// Через createBoardServer на MemoryBoardStore; часы — порт `now`, свои у теста.

import type { Command, RejectReason, ServerMessage } from "@retro/protocol";
import { clientMessageSchema, PROTOCOL_VERSION, serverMessageSchema } from "@retro/protocol";
import type { Outgoing, ServerCorePorts } from "@retro/server-core";
import { createBoardServer, createMemoryBoardStore } from "@retro/server-core";
import { describe, expect, it } from "vitest";

function uuid(tail: string): string {
  return `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
}

const BOARD_ID = uuid("b1");
const OWNER_ID = uuid("01");
const ACTOR_OWNER = uuid("02");
const FAC_ID = uuid("f1");
const ACTOR_FAC = uuid("f2");
const GUEST_A = uuid("0a");
const ACTOR_A = uuid("0b");
const GUEST_B = uuid("0c");
const ACTOR_B = uuid("0d");
const VIEWER_ID = uuid("e1");
const ACTOR_VIEWER = uuid("e2");
const STRANGER_ID = uuid("ee");

const T0 = 1_700_000_000_000;

function helloRaw(actorId: string, guestId: string, lastSeq: number | null = null): string {
  return JSON.stringify(
    clientMessageSchema.parse({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      guestId,
      displayName: "Guest",
      actorId,
      lastSeq,
    }),
  );
}

function commandRaw(id: string, command: Command): string {
  return JSON.stringify(clientMessageSchema.parse({ type: "command", id, command }));
}

interface Parsed {
  readonly to: string;
  readonly message: ServerMessage;
  /** Сырой JSON — `role` в `meta` ещё может не пройти через схему протокола. */
  readonly raw: Record<string, unknown>;
}

function parse(outgoing: readonly Outgoing[]): Parsed[] {
  return outgoing.map((entry) => ({
    to: entry.to,
    message: serverMessageSchema.parse(JSON.parse(entry.raw)),
    raw: JSON.parse(entry.raw) as Record<string, unknown>,
  }));
}

function metas(out: readonly Parsed[]): Parsed[] {
  return out.filter((e) => e.message.type === "meta");
}

function metaTimer(entry: Parsed): { endsAt: string } | null {
  if (entry.message.type !== "meta") throw new Error("not a meta message");
  return entry.message.meta.timer;
}

function resultFor(out: readonly Parsed[], to: string, id: string) {
  const found = out.find(
    (e) => e.to === to && e.message.type === "commandResult" && e.message.id === id,
  );
  if (!found || found.message.type !== "commandResult") {
    throw new Error(`no commandResult ${id} for ${to}`);
  }
  return found.message;
}

interface Env {
  readonly store: ReturnType<typeof createMemoryBoardStore>;
  readonly server: ReturnType<typeof createBoardServer>;
  readonly clock: { now: number };
  connect(conn: string, actor: string, guest: string, lastSeq?: number | null): Promise<Parsed[]>;
  send(conn: string, id: string, command: Command): Promise<Parsed[]>;
}

function makeEnv(options: { withNow?: boolean } = {}): Env {
  const store = createMemoryBoardStore();
  store.createBoard({
    id: BOARD_ID,
    title: "Retro",
    ownerId: OWNER_ID,
    ownerName: "Owner",
    voteLimit: 3,
  });
  store.addMember(BOARD_ID, FAC_ID, "facilitator", "Fac");
  store.addMember(BOARD_ID, GUEST_A, "participant", "Alice");
  store.addMember(BOARD_ID, GUEST_B, "participant", "Bob");
  store.addMember(BOARD_ID, VIEWER_ID, "viewer", "Vera");
  const clock = { now: T0 };
  const ports: ServerCorePorts = {
    store,
    voterToken: (_b: string, guestId: string) => `vt:${guestId}`,
    ...(options.withNow === false ? {} : { now: () => clock.now }),
  };
  const server = createBoardServer(ports);
  return {
    store,
    server,
    clock,
    async connect(conn, actor, guest, lastSeq = null) {
      server.open(conn, BOARD_ID);
      return parse((await server.receive(conn, helloRaw(actor, guest, lastSeq))).outgoing);
    },
    async send(conn, id, command) {
      return parse((await server.receive(conn, commandRaw(id, command))).outgoing);
    },
  };
}

/** Владелец и все остальные подключены; доска переведена в `discuss` (первый выход из collect — reveal). */
async function setupDiscuss(env: Env) {
  await env.connect("c-owner", ACTOR_OWNER, OWNER_ID);
  await env.connect("c-fac", ACTOR_FAC, FAC_ID);
  await env.connect("c-a", ACTOR_A, GUEST_A);
  await env.connect("c-b", ACTOR_B, GUEST_B);
  await env.connect("c-viewer", ACTOR_VIEWER, VIEWER_ID);
  const phase = await env.send("c-owner", "p1", { type: "setPhase", phase: "discuss" });
  expect(resultFor(phase, "c-owner", "p1").ok).toBe(true);
}

const ALL_CONNS = ["c-owner", "c-fac", "c-a", "c-b", "c-viewer"];

describe("T-030: grantFacilitator", () => {
  it("REQ-003: owner повышает участника до facilitator — роль в хранилище, commandResult ok автору", async () => {
    const env = makeEnv();
    await setupDiscuss(env);

    const out = await env.send("c-owner", "g1", { type: "grantFacilitator", guestId: GUEST_A });
    expect(resultFor(out, "c-owner", "g1").ok).toBe(true);
    expect(await env.store.memberRole(BOARD_ID, GUEST_A)).toBe("facilitator");
  });

  it("REQ-003: meta с role=facilitator уходит каждому подключению цели и только им", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    await env.connect("c-a2", ACTOR_A, GUEST_A); // второе подключение того же гостя

    const out = await env.send("c-owner", "g1", { type: "grantFacilitator", guestId: GUEST_A });

    const withRole = out.filter((e) => e.message.type === "meta" && "role" in e.raw);
    expect(withRole.map((e) => e.to).sort()).toEqual(["c-a", "c-a2"]);
    for (const entry of withRole) expect(entry.raw.role).toBe("facilitator");
    // Никто другой не получает чужую роль.
    for (const entry of out) {
      if (entry.to === "c-a" || entry.to === "c-a2") continue;
      expect(entry.raw.role).toBeUndefined();
    }
  });

  it("REQ-003: повтор grantFacilitator для уже фасилитатора — ok", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    await env.send("c-owner", "g1", { type: "grantFacilitator", guestId: GUEST_A });
    const out = await env.send("c-owner", "g2", { type: "grantFacilitator", guestId: GUEST_A });
    expect(resultFor(out, "c-owner", "g2").ok).toBe(true);
    expect(await env.store.memberRole(BOARD_ID, GUEST_A)).toBe("facilitator");
  });

  it("REQ-003: не-owner (facilitator, participant, viewer) получает forbidden, роль не меняется", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    for (const [conn, n] of [
      ["c-fac", "1"],
      ["c-a", "2"],
      ["c-viewer", "3"],
    ] as const) {
      const out = await env.send(conn, `g${n}`, { type: "grantFacilitator", guestId: GUEST_B });
      const result = resultFor(out, conn, `g${n}`);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("forbidden");
    }
    expect(await env.store.memberRole(BOARD_ID, GUEST_B)).toBe("participant");
  });

  it("REQ-003: guestId не участника доски — unknown_target, участник не создаётся", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    const out = await env.send("c-owner", "g1", { type: "grantFacilitator", guestId: STRANGER_ID });
    const result = resultFor(out, "c-owner", "g1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_target");
    expect(await env.store.memberRole(BOARD_ID, STRANGER_ID)).toBeNull();
  });

  it("REQ-003: повышенный фасилитатор действительно получает права — может сменить фазу", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    await env.send("c-owner", "g1", { type: "grantFacilitator", guestId: GUEST_A });
    const out = await env.send("c-a", "p2", { type: "setPhase", phase: "actions" });
    expect(resultFor(out, "c-a", "p2").ok).toBe(true);
  });
});

describe("T-030: startTimer / stopTimer", () => {
  it("REQ-019: startTimer в discuss — timerEndsAt = ISO(now + seconds), meta всем подписчикам, ok автору", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    const expected = new Date(T0 + 90_000).toISOString();

    const out = await env.send("c-fac", "t1", { type: "startTimer", seconds: 90 });

    expect(resultFor(out, "c-fac", "t1").ok).toBe(true);
    expect((await env.store.board(BOARD_ID))?.timerEndsAt).toBe(expected);
    const toMeta = metas(out);
    expect(toMeta.map((e) => e.to).sort()).toEqual([...ALL_CONNS].sort());
    for (const entry of toMeta) expect(metaTimer(entry)).toEqual({ endsAt: expected });
  });

  it("REQ-019: owner тоже может запустить таймер", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    const out = await env.send("c-owner", "t1", { type: "startTimer", seconds: 60 });
    expect(resultFor(out, "c-owner", "t1").ok).toBe(true);
  });

  it("REQ-019: participant и viewer не могут запустить таймер — forbidden, состояние не меняется", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    for (const conn of ["c-a", "c-viewer"]) {
      const out = await env.send(conn, `t-${conn}`, { type: "startTimer", seconds: 60 });
      const result = resultFor(out, conn, `t-${conn}`);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("forbidden");
    }
    expect((await env.store.board(BOARD_ID))?.timerEndsAt).toBeNull();
  });

  it("REQ-019: startTimer вне discuss — wrong_phase", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    await env.send("c-owner", "p2", { type: "setPhase", phase: "vote" });
    const out = await env.send("c-owner", "t1", { type: "startTimer", seconds: 60 });
    const result = resultFor(out, "c-owner", "t1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wrong_phase" satisfies RejectReason);
    expect((await env.store.board(BOARD_ID))?.timerEndsAt).toBeNull();
  });

  it("REQ-019: повторный startTimer заменяет идущий таймер", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    await env.send("c-fac", "t1", { type: "startTimer", seconds: 60 });
    env.clock.now = T0 + 10_000;
    const out = await env.send("c-fac", "t2", { type: "startTimer", seconds: 120 });

    const expected = new Date(T0 + 10_000 + 120_000).toISOString();
    expect(resultFor(out, "c-fac", "t2").ok).toBe(true);
    expect((await env.store.board(BOARD_ID))?.timerEndsAt).toBe(expected);
    for (const entry of metas(out)) expect(metaTimer(entry)).toEqual({ endsAt: expected });
  });

  it("REQ-019: без порта now startTimer — commandResult invalid_shape, остальное работает", async () => {
    const env = makeEnv({ withNow: false });
    await setupDiscuss(env);
    const out = await env.send("c-owner", "t1", { type: "startTimer", seconds: 60 });
    const result = resultFor(out, "c-owner", "t1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_shape");
    expect((await env.store.board(BOARD_ID))?.timerEndsAt).toBeNull();

    const phase = await env.send("c-owner", "p2", { type: "setPhase", phase: "actions" });
    expect(resultFor(phase, "c-owner", "p2").ok).toBe(true);
  });

  it("REQ-019: stopTimer сбрасывает таймер — meta с timer null всем, ok автору", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    await env.send("c-fac", "t1", { type: "startTimer", seconds: 60 });

    const out = await env.send("c-owner", "t2", { type: "stopTimer" });

    expect(resultFor(out, "c-owner", "t2").ok).toBe(true);
    expect((await env.store.board(BOARD_ID))?.timerEndsAt).toBeNull();
    const toMeta = metas(out);
    expect(toMeta.map((e) => e.to).sort()).toEqual([...ALL_CONNS].sort());
    for (const entry of toMeta) expect(metaTimer(entry)).toBeNull();
  });

  it("REQ-019: stopTimer без идущего таймера — ok", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    const out = await env.send("c-owner", "t1", { type: "stopTimer" });
    expect(resultFor(out, "c-owner", "t1").ok).toBe(true);
    expect((await env.store.board(BOARD_ID))?.timerEndsAt).toBeNull();
  });

  it("REQ-019: participant и viewer не могут остановить таймер — forbidden, таймер идёт", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    await env.send("c-fac", "t1", { type: "startTimer", seconds: 60 });
    const before = (await env.store.board(BOARD_ID))?.timerEndsAt;
    expect(before).toBeTruthy();

    for (const conn of ["c-a", "c-viewer"]) {
      const out = await env.send(conn, `s-${conn}`, { type: "stopTimer" });
      const result = resultFor(out, conn, `s-${conn}`);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("forbidden");
    }
    expect((await env.store.board(BOARD_ID))?.timerEndsAt).toBe(before);
  });
});

describe("T-030: таймер и смена фазы", () => {
  it("REQ-019: setPhase в не-discuss сбрасывает таймер — в том же meta, что несёт новую фазу", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    await env.send("c-fac", "t1", { type: "startTimer", seconds: 60 });

    const out = await env.send("c-owner", "p2", { type: "setPhase", phase: "actions" });

    expect(resultFor(out, "c-owner", "p2").ok).toBe(true);
    expect((await env.store.board(BOARD_ID))?.timerEndsAt).toBeNull();
    const toMeta = metas(out);
    expect(toMeta.length).toBeGreaterThan(0);
    for (const entry of toMeta) {
      if (entry.message.type !== "meta") continue;
      expect(entry.message.meta.phase).toBe("actions");
      expect(entry.message.meta.timer).toBeNull();
    }
  });

  it("REQ-019: setPhase в discuss не сбрасывает таймер", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    await env.send("c-owner", "p2", { type: "setPhase", phase: "vote" });
    // Таймер, оставшийся от прежнего состояния доски (например, выставленный через порт).
    const endsAt = new Date(T0 + 300_000).toISOString();
    await env.store.setTimer(BOARD_ID, endsAt);

    const out = await env.send("c-owner", "p3", { type: "setPhase", phase: "discuss" });

    expect(resultFor(out, "c-owner", "p3").ok).toBe(true);
    expect((await env.store.board(BOARD_ID))?.timerEndsAt).toBe(endsAt);
    for (const entry of metas(out)) expect(metaTimer(entry)).toEqual({ endsAt });
  });
});

describe("T-030: таймер при переподключении", () => {
  it("REQ-027: welcome при переподключении несёт идущий таймер (переживает reconnect и перезагрузку страницы)", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    await env.send("c-fac", "t1", { type: "startTimer", seconds: 90 });
    const expected = new Date(T0 + 90_000).toISOString();

    await env.server.close("c-b");
    const welcome = await env.connect("c-b2", ACTOR_B, GUEST_B, null);

    const entry = welcome.find((e) => e.to === "c-b2" && e.message.type === "welcome");
    if (!entry || entry.message.type !== "welcome") throw new Error("expected welcome");
    expect(entry.message.meta.timer).toEqual({ endsAt: expected });
  });

  it("REQ-027: таймер хранится в хранилище — новый сервер на том же хранилище (перезапуск) отдаёт его в welcome", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    await env.send("c-fac", "t1", { type: "startTimer", seconds: 90 });
    const expected = new Date(T0 + 90_000).toISOString();

    const restarted = createBoardServer({
      store: env.store,
      voterToken: (_b: string, guestId: string) => `vt:${guestId}`,
      now: () => env.clock.now,
    });
    restarted.open("c-new", BOARD_ID);
    const out = parse((await restarted.receive("c-new", helloRaw(ACTOR_A, GUEST_A))).outgoing);
    const entry = out.find((e) => e.message.type === "welcome");
    if (!entry || entry.message.type !== "welcome") throw new Error("expected welcome");
    expect(entry.message.meta.timer).toEqual({ endsAt: expected });
  });

  it("REQ-027: после stopTimer welcome несёт timer null", async () => {
    const env = makeEnv();
    await setupDiscuss(env);
    await env.send("c-fac", "t1", { type: "startTimer", seconds: 90 });
    await env.send("c-fac", "t2", { type: "stopTimer" });

    const welcome = await env.connect("c-a2", ACTOR_A, GUEST_A);
    const entry = welcome.find((e) => e.to === "c-a2" && e.message.type === "welcome");
    if (!entry || entry.message.type !== "welcome") throw new Error("expected welcome");
    expect(entry.message.meta.timer).toBeNull();
  });
});
