// createSyncClient — реализация ядра клиента. Точное поведение каждого
// метода описано в JSDoc `types.ts`; этот файл — только код, следующий
// этому контракту.

import type { Clock, Dot, State, View } from "@retro/crdt";
import {
  assign,
  unvote as crdtUnvote,
  vote as crdtVote,
  createAction,
  createGroup,
  createSticker,
  deleteEntity,
  dotKey,
  editText,
  empty,
  fromWire,
  materialize,
  merge,
  mergeAll,
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

/**
 * `confirmed ⊔ P`. Ожидающие дельты сначала объединяются между собой (они
 * маленькие) и только потом одним слиянием с `confirmed`: `merge`
 * ассоциативен и коммутативен, результат тот же, а копий большого состояния
 * не k, а одна.
 */
function withPending(confirmed: State, pending: readonly PendingEntry[]): State {
  if (pending.length === 0) return confirmed;
  return mergeAll([confirmed, ...pending.map((entry) => fromWire(entry.delta))]);
}

function dotEquals(a: Dot, b: Dot): boolean {
  return a.actor === b.actor && a.counter === b.counter;
}

/** Ключ ячейки+dot для сопоставления `supersedes` с записями `R` (ADR-0010, зависимость (в)). */
function entryKey(entity: string, field: string, dot: Dot): string {
  return `${entity}|${field}|${dotKey(dot)}`;
}

/** Наибольшая метка среди видимых записей `state` — то, к чему откатываются часы при `reject` (ADR-0010, п. 4). */
function maxLamportOf(state: State): number {
  let max = 0;
  for (const entry of state.entries.values()) {
    if (entry.stamp.lamport > max) max = entry.stamp.lamport;
  }
  return max;
}

/**
 * Множество `R` (ADR-0010): сущности, ячейки и голоса, «принесённые» уже
 * отклонённой/каскадно удаляемой частью очереди — растёт по мере обхода.
 * Отдельно от `PendingEntry`, потому что накапливает данные и уже
 * КАСКАДНО удалённых элементов (они больше не лежат в `pending`).
 */
interface RejectClosure {
  readonly createdIds: Set<string>;
  readonly entryKeys: Set<string>;
  readonly voteDotKeys: Set<string>;
}

function extendClosure(closure: RejectClosure, entry: PendingEntry): void {
  for (const created of entry.delta.created) closure.createdIds.add(created.id);
  for (const record of entry.delta.entries) {
    closure.entryKeys.add(entryKey(record.key.entity, record.key.field, record.dot));
  }
  for (const voteEntry of entry.delta.votes) closure.voteDotKeys.add(dotKey(voteEntry.dot));
}

/** (а)/(б) ADR-0010 — `π` ссылается на сущность или голос, принесённые `R`; удаляется насовсем, не пересобирается. */
function dependsOnEntityOrVote(closure: RejectClosure, entry: PendingEntry): boolean {
  const { delta } = entry;
  return (
    delta.entries.some(
      (record) =>
        closure.createdIds.has(record.key.entity) ||
        (record.key.field === "group" &&
          typeof record.value === "string" &&
          closure.createdIds.has(record.value)),
    ) ||
    delta.votes.some((voteEntry) => closure.createdIds.has(voteEntry.target)) ||
    delta.unvotes.some(
      (unvoteEntry) =>
        closure.createdIds.has(unvoteEntry.target) ||
        closure.voteDotKeys.has(dotKey(unvoteEntry.dot)),
    )
  );
}

/** (в) ADR-0010 — `π` перекрывает запись, внесённую `R`; пересобирается заново из своего `intent`. */
function dependsOnSupersede(closure: RejectClosure, entry: PendingEntry): boolean {
  return entry.delta.supersedes.some((supersede) =>
    closure.entryKeys.has(entryKey(supersede.key.entity, supersede.key.field, supersede.dot)),
  );
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

  // X_c ⊔ ⨆P, мемо по идентичности confirmed/pending (оба только заменяются).
  // Одно и то же состояние нужно экрану (view), очередному `act` и проверкам
  // симулятора — копировать большое состояние три раза на действие незачем.
  let fullCache: { confirmed: State; pending: readonly PendingEntry[]; state: State } | null = null;

  function fullOf(c: State, p: readonly PendingEntry[]): State {
    if (fullCache === null || fullCache.confirmed !== c || fullCache.pending !== p) {
      fullCache = { confirmed: c, pending: p, state: withPending(c, p) };
    }
    return fullCache.state;
  }

  function viewState(): State {
    return fullOf(confirmed, pending);
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

  /**
   * `reject(δ)` (ADR-0010, `consistency-model.md` § 6): удаляет `δ`, закрывает
   * очередь от ссылок на неё — зависимые по сущности/голосу удаляются
   * каскадом, зависимые только по перекрытию пересобираются в конец очереди
   * из своего `intent` — и откатывает часы Lamport. `null`, если `dot` уже
   * не в `P` (повтор/устаревший ответ) — тогда ничего не меняется.
   */
  function processReject(dot: Dot, reason: RejectReason): string[] {
    const entry = takeFirstMatch(dot);
    if (!entry) return [];
    rejections = [...rejections, { dot, reason }];

    const closure: RejectClosure = {
      createdIds: new Set(),
      entryKeys: new Set(),
      voteDotKeys: new Set(),
    };
    extendClosure(closure, entry);

    const survivors: PendingEntry[] = [];
    const toReassemble: PendingEntry[] = [];
    for (const candidate of pending) {
      if (dependsOnEntityOrVote(closure, candidate)) {
        rejections = [...rejections, { dot: candidate.dot, reason, cause: entry.dot }];
        extendClosure(closure, candidate);
      } else if (dependsOnSupersede(closure, candidate)) {
        toReassemble.push(candidate);
        extendClosure(closure, candidate);
      } else {
        survivors.push(candidate);
      }
    }

    // Часы — к максимуму того, что реально осталось видно, ДО пересборки
    // (ADR-0010, п. 4): иначе метка следующей операции считалась бы от
    // раздутого clock.lamport, накопленного уже удалённым/отклонённым.
    pending = survivors;
    clock = { ...clock, lamport: maxLamportOf(viewState()) };

    const reassembled: PendingEntry[] = [];
    for (const candidate of toReassemble) {
      const built = buildEntry(viewState(), clock, candidate.intent, voterToken);
      clock = built.clock;
      const next: PendingEntry = { ...built.entry, intent: candidate.intent };
      pending = [...pending, next];
      reassembled.push(next);
    }
    saveOutbox();

    return status === "welcomed"
      ? reassembled.map((next) => JSON.stringify({ type: "op", delta: next.delta }))
      : [];
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
      case "reject":
        return processReject(parsed.dot, parsed.reason);
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

  // Мемо view по идентичности confirmed/pending: оба только заменяются, не
  // мутируются, так что совпадение ссылок = то же состояние.
  let viewCache: { confirmed: State; pending: readonly PendingEntry[]; view: View } | null = null;

  function inspect(): ClientSnapshot {
    // view — по первому обращению: это дорогая материализация, а большинству
    // вызывающих (симулятор, проверки) нужны только confirmed/pending.
    const snapshotConfirmed = confirmed;
    const snapshotPending = pending;
    return {
      actorId,
      confirmed: snapshotConfirmed,
      pending: snapshotPending,
      get full(): State {
        return fullOf(snapshotConfirmed, snapshotPending);
      },
      get view(): View {
        if (
          viewCache === null ||
          viewCache.confirmed !== snapshotConfirmed ||
          viewCache.pending !== snapshotPending
        ) {
          viewCache = {
            confirmed: snapshotConfirmed,
            pending: snapshotPending,
            view: materialize(fullOf(snapshotConfirmed, snapshotPending)),
          };
        }
        return viewCache.view;
      },
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
