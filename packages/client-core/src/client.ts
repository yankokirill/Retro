// createSyncClient — реализация ядра клиента. Точное поведение каждого
// метода описано в JSDoc `types.ts`; этот файл — только код, следующий
// этому контракту.

import type { Clock, Dot, State } from "@retro/crdt";
import {
  assign,
  unvote as crdtUnvote,
  vote as crdtVote,
  createAction,
  createGroup,
  createSticker,
  deleteEntity,
  editText,
  empty,
  fromWire,
  materialize,
  merge,
  move,
  newClock,
  renameGroup,
  restoreEntity,
  setColor,
  setDone,
  setGroup,
  toWire,
} from "@retro/crdt";
import type { BoardMeta, Command, RejectReason, Role, ServerMessage } from "@retro/protocol";
import { clientDeltaSchema, PROTOCOL_VERSION, serverMessageSchema } from "@retro/protocol";
import type { PendingEntry } from "./outbox.js";
import type {
  ActResult,
  ClientCorePorts,
  ClientSnapshot,
  ClientStatus,
  Intent,
  Rejection,
  SyncClient,
  SyncClientConfig,
} from "./types.js";

const DEFAULT_MAX_PENDING = 500;

/**
 * Строит `PendingEntry` для одного `Intent` через конструкторы `@retro/crdt`
 * над `state`/`clock`. Не мутирует ничего снаружи. `voterToken` нужен только
 * для `vote` (§ 3.1 `consistency-model.md`: `V⁺ = {(d, owner(a), id)}`) —
 * вызывающий (`act()`) уже проверил, что он не `null`, когда intent это требует.
 */
function buildEntry(
  state: State,
  clock: Clock,
  intent: Intent,
  voterToken: string | null,
): { entry: Omit<PendingEntry, "intent">; clock: Clock } {
  switch (intent.type) {
    case "createSticker": {
      const r = createSticker(state, clock, {
        column: intent.column,
        frac: intent.frac,
        text: intent.text,
        color: intent.color,
      });
      return { entry: { delta: toWire(r.delta), dot: r.dot, kind: "op" }, clock: r.clock };
    }
    case "editText":
    case "editAction": {
      const r = editText(state, clock, intent.id, intent.text);
      return { entry: { delta: toWire(r.delta), dot: r.dot, kind: "op" }, clock: r.clock };
    }
    case "setColor": {
      const r = setColor(state, clock, intent.id, intent.color);
      return { entry: { delta: toWire(r.delta), dot: r.dot, kind: "op" }, clock: r.clock };
    }
    case "move": {
      const r = move(state, clock, intent.id, intent.place);
      return { entry: { delta: toWire(r.delta), dot: r.dot, kind: "op" }, clock: r.clock };
    }
    case "setGroup": {
      const r = setGroup(state, clock, intent.id, intent.group);
      return { entry: { delta: toWire(r.delta), dot: r.dot, kind: "op" }, clock: r.clock };
    }
    case "delete": {
      const r = deleteEntity(state, clock, intent.id);
      return { entry: { delta: toWire(r.delta), dot: r.dot, kind: "op" }, clock: r.clock };
    }
    case "restore": {
      const r = restoreEntity(state, clock, intent.id);
      return { entry: { delta: toWire(r.delta), dot: r.dot, kind: "op" }, clock: r.clock };
    }
    case "createGroup": {
      const r = createGroup(state, clock, {
        column: intent.column,
        frac: intent.frac,
        title: intent.title,
      });
      return { entry: { delta: toWire(r.delta), dot: r.dot, kind: "op" }, clock: r.clock };
    }
    case "renameGroup": {
      const r = renameGroup(state, clock, intent.id, intent.title);
      return { entry: { delta: toWire(r.delta), dot: r.dot, kind: "op" }, clock: r.clock };
    }
    case "createAction": {
      const r = createAction(state, clock, { text: intent.text });
      return { entry: { delta: toWire(r.delta), dot: r.dot, kind: "op" }, clock: r.clock };
    }
    case "assign": {
      const r = assign(state, clock, intent.id, intent.guestId);
      return { entry: { delta: toWire(r.delta), dot: r.dot, kind: "op" }, clock: r.clock };
    }
    case "setDone": {
      const r = setDone(state, clock, intent.id, intent.done);
      return { entry: { delta: toWire(r.delta), dot: r.dot, kind: "op" }, clock: r.clock };
    }
    case "vote": {
      // act() уже отклонил vote с voterToken === null как not_welcomed_yet.
      const r = crdtVote(state, clock, intent.target, voterToken as string);
      return { entry: { delta: toWire(r.delta), dot: r.dot, kind: "op" }, clock: r.clock };
    }
    case "unvote": {
      // unvote не тикает часы (§ 3.1 consistency-model.md) — clock не меняется.
      const delta = crdtUnvote(state, intent.voteDot, intent.target);
      return { entry: { delta: toWire(delta), dot: intent.voteDot, kind: "unvote" }, clock };
    }
  }
}

function dotEquals(a: Dot, b: Dot): boolean {
  return a.actor === b.actor && a.counter === b.counter;
}

export function createSyncClient(config: SyncClientConfig, ports: ClientCorePorts): SyncClient {
  const actorId = ports.newActorId();
  const maxPending = config.maxPending ?? DEFAULT_MAX_PENDING;

  let confirmed: State = empty();
  let pending: PendingEntry[] = [];
  let clock: Clock = newClock(actorId);
  let status: ClientStatus = "offline";
  let lastSeq: number | null = null;
  let role: Role | null = null;
  let meta: BoardMeta | null = null;
  let voterToken: string | null = null;
  let rejections: Rejection[] = [];

  function viewState(): State {
    let acc = confirmed;
    for (const entry of pending) acc = merge(acc, fromWire(entry.delta));
    return acc;
  }

  function saveOutbox(): void {
    ports.outbox.save(pending);
  }

  function takeFirstMatch(dot: Dot): PendingEntry | null {
    const index = pending.findIndex((entry) => dotEquals(entry.dot, dot));
    if (index === -1) return null;
    const [entry] = pending.slice(index, index + 1);
    pending = [...pending.slice(0, index), ...pending.slice(index + 1)];
    saveOutbox();
    return entry ?? null;
  }

  function connected(): string[] {
    if (status !== "offline") return [];
    status = "connecting";
    return [
      JSON.stringify({
        type: "hello",
        protocol: PROTOCOL_VERSION,
        guestId: config.guestId,
        displayName: config.displayName,
        actorId,
        lastSeq,
      }),
    ];
  }

  function disconnected(): void {
    status = "offline";
  }

  function act(intent: Intent): ActResult {
    if (pending.length >= maxPending) return { ok: false, reason: "queue_full" };
    if ((intent.type === "vote" || intent.type === "unvote") && voterToken === null) {
      return { ok: false, reason: "not_welcomed_yet" };
    }

    const built = buildEntry(viewState(), clock, intent, voterToken);

    const validation = clientDeltaSchema.safeParse(built.entry.delta);
    if (!validation.success) return { ok: false, reason: "invalid_intent" };

    pending = [...pending, { ...built.entry, intent }];
    clock = built.clock;
    saveOutbox();

    if (status === "welcomed") {
      return { ok: true, send: [JSON.stringify({ type: "op", delta: built.entry.delta })] };
    }
    return { ok: true, send: [] };
  }

  function command(cmd: Command): string[] {
    if (status !== "welcomed") return [];
    return [JSON.stringify({ type: "command", id: ports.newCommandId(), command: cmd })];
  }

  function applyWelcome(msg: Extract<ServerMessage, { type: "welcome" }>): string[] {
    role = msg.role;
    voterToken = msg.voterToken;
    meta = msg.meta;
    if (msg.snapshot) {
      confirmed = merge(confirmed, fromWire(msg.snapshot.state));
      lastSeq = lastSeq === null ? msg.snapshot.upToSeq : Math.max(lastSeq, msg.snapshot.upToSeq);
    }
    for (const row of msg.ops) {
      confirmed = merge(confirmed, fromWire(row.delta));
      lastSeq = lastSeq === null ? row.seq : Math.max(lastSeq, row.seq);
    }
    status = "welcomed";
    return pending.map((entry) => JSON.stringify({ type: "op", delta: entry.delta }));
  }

  function receive(raw: string): string[] {
    const parsed = serverMessageSchema.parse(JSON.parse(raw));
    switch (parsed.type) {
      case "welcome":
        return applyWelcome(parsed);
      case "op":
        confirmed = merge(confirmed, fromWire(parsed.delta));
        lastSeq = lastSeq === null ? parsed.seq : Math.max(lastSeq, parsed.seq);
        return [];
      case "ack": {
        const entry = takeFirstMatch(parsed.dot);
        if (entry) confirmed = merge(confirmed, fromWire(entry.delta));
        return [];
      }
      case "reject": {
        const entry = takeFirstMatch(parsed.dot);
        if (entry) rejections = [...rejections, { dot: parsed.dot, reason: parsed.reason }];
        return [];
      }
      case "meta":
        meta = parsed.meta;
        return [];
      case "commandResult":
        return [];
      case "error":
        status = "offline";
        return [];
    }
  }

  function inspect(): ClientSnapshot {
    return {
      actorId,
      confirmed,
      pending,
      view: materialize(viewState()),
      lastSeq,
      status,
      role,
      meta,
      voterToken,
      rejections,
    };
  }

  return { connected, receive, disconnected, act, command, inspect };
}
