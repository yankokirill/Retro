// Публичный API ядра CRDT доски — docs/spec/consistency-model.md.
//
// Пакет чистый: без I/O, Date.now(), Math.random() (CLAUDE.md, правило 7).
// Валидация размеров и прав — не здесь, а в packages/protocol и на сервере.

import type {
  ActorId,
  Clock,
  Color,
  Column,
  Created,
  Dot,
  EntityId,
  Entry,
  Key,
  OpResult,
  Place,
  Stamp,
  State,
  Supersede,
  Value,
} from "./types.js";

export type * from "./types.js";

// Идентичность элемента множества — JSON-кортеж: разделители внутри actorId не ломают ключ.
const identity = (...parts: (string | number)[]): string => JSON.stringify(parts);
const cellDotIdentity = (key: Key, dot: Dot): string =>
  identity(key.entity, key.field, dot.actor, dot.counter);

/** Стабильная сериализация: ключи объектов отсортированы, порядок свойств не влияет. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort()
    .map((field) => `${JSON.stringify(field)}:${canonical(record[field])}`);
  return `{${fields.join(",")}}`;
}

const NO_ELEMENTS: ReadonlyMap<string, never> = new Map<string, never>();

const EMPTY: State = {
  created: NO_ELEMENTS,
  entries: NO_ELEMENTS,
  supersedes: NO_ELEMENTS,
  votes: NO_ELEMENTS,
  unvotes: NO_ELEMENTS,
};

/** ⊥ — пустое состояние. */
export function empty(): State {
  return EMPTY;
}

/** Каноническая строка dot: `${actor}:${counter}`. Она же EntityId созданной сущности. */
export function dotKey(dot: Dot): string {
  return `${dot.actor}:${dot.counter}`;
}

/** Порядок меток (§ 1.3): отрицательное, если a < b; 0 только для равных. */
export function compareStamps(a: Stamp, b: Stamp): number {
  if (a.lamport !== b.lamport) return a.lamport < b.lamport ? -1 : 1;
  if (a.actor === b.actor) return 0;
  return a.actor < b.actor ? -1 : 1;
}

/** Часы новой реплики: counter = 0, lamport = 0. */
export function newClock(actor: ActorId): Clock {
  return { actor, counter: 0, lamport: 0 };
}

/**
 * Объединение множеств. Корректные реплики никогда не порождают два разных элемента
 * с одной идентичностью (W1); если такое всё же пришло, берётся канонически
 * наибольший — так законы полурешётки держатся для любых входов.
 */
function union<T>(a: ReadonlyMap<string, T>, b: ReadonlyMap<string, T>): ReadonlyMap<string, T> {
  if (b.size === 0) return a;
  if (a.size === 0) return b;
  const result = new Map(a);
  for (const [id, element] of b) {
    const existing = result.get(id);
    if (
      existing === undefined ||
      (existing !== element && canonical(element) > canonical(existing))
    ) {
      result.set(id, element);
    }
  }
  return result;
}

/**
 * X ⊔ Y — покомпонентное объединение (§ 2). Коммутативно, ассоциативно,
 * идемпотентно для любых состояний.
 */
export function merge(a: State, b: State): State {
  return {
    created: union(a.created, b.created),
    entries: union(a.entries, b.entries),
    supersedes: union(a.supersedes, b.supersedes),
    votes: union(a.votes, b.votes),
    unvotes: union(a.unvotes, b.unvotes),
  };
}

function sameElements<T>(a: ReadonlyMap<string, T>, b: ReadonlyMap<string, T>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, element] of a) {
    const other = b.get(id);
    if (other === undefined) return false;
    if (other !== element && canonical(other) !== canonical(element)) return false;
  }
  return true;
}

/** Равенство состояний как множеств — не зависит от порядка вставки. */
export function equals(a: State, b: State): boolean {
  return (
    sameElements(a.created, b.created) &&
    sameElements(a.entries, b.entries) &&
    sameElements(a.supersedes, b.supersedes) &&
    sameElements(a.votes, b.votes) &&
    sameElements(a.unvotes, b.unvotes)
  );
}

// Равные метки у разных записей возможны только при нарушении W2; тогда порядок
// всё равно детерминирован — по dot. Без localeCompare: он зависит от локали.
const compareDots = (a: Dot, b: Dot): number =>
  a.actor !== b.actor ? (a.actor < b.actor ? -1 : 1) : a.counter - b.counter;

const byStampDescending = (a: Entry, b: Entry): number =>
  compareStamps(b.stamp, a.stamp) || compareDots(b.dot, a.dot);

/** vis_k(X): неперекрытые записи ячейки, по убыванию метки (§ 2). */
export function visible(state: State, key: Key): Entry[] {
  const result: Entry[] = [];
  for (const entry of state.entries.values()) {
    if (entry.key.entity !== key.entity || entry.key.field !== key.field) continue;
    if (state.supersedes.has(cellDotIdentity(key, entry.dot))) continue;
    result.push(entry);
  }
  return result.sort(byStampDescending);
}

/** win_k(X): видимая запись с наибольшей меткой; undefined, если записей нет. */
export function winner(state: State, key: Key): Entry | undefined {
  return visible(state, key)[0];
}

/** vals_k(X): значения видимых записей, по убыванию метки. */
export function values(state: State, key: Key): Value[] {
  return visible(state, key).map((entry) => entry.value);
}

function maxLamport(state: State): number {
  let max = 0;
  for (const entry of state.entries.values()) {
    if (entry.stamp.lamport > max) max = entry.stamp.lamport;
  }
  return max;
}

/** Свежие dot и метка (§ 1.2–1.3): всё, что реплика видела, «раньше» новой операции. */
function tick(state: State, clock: Clock): { clock: Clock; dot: Dot; stamp: Stamp } {
  const counter = clock.counter + 1;
  const lamport = Math.max(clock.lamport, maxLamport(state)) + 1;
  return {
    clock: { actor: clock.actor, counter, lamport },
    dot: { actor: clock.actor, counter },
    stamp: { lamport, actor: clock.actor },
  };
}

function entryElement(entry: Entry): [string, Entry] {
  return [cellDotIdentity(entry.key, entry.dot), entry];
}

/**
 * Конструкторы операций (§ 3). Каждый берёт свежие dot и метку:
 * counter = clock.counter + 1; lamport = max(clock.lamport, максимум lamport в state) + 1.
 * Возвращают дельту и новые часы; state не меняют — применение: merge(state, delta).
 */

/** write(k, v): новая запись + перекрытие всех видимых в state записей ячейки k. */
export function setField(state: State, clock: Clock, key: Key, value: Value): OpResult {
  const next = tick(state, clock);
  const supersedes = new Map<string, Supersede>(
    visible(state, key).map((seen) => [cellDotIdentity(key, seen.dot), { key, dot: seen.dot }]),
  );
  return {
    delta: {
      ...EMPTY,
      entries: new Map([entryElement({ key, dot: next.dot, stamp: next.stamp, value })]),
      supersedes,
    },
    clock: next.clock,
    dot: next.dot,
  };
}

/**
 * createSticker: C = {(id, sticker)}, id = dotKey(dot); записи text, color, place,
 * group = null, deleted = false — все с dot операции, без перекрытий.
 */
export function createSticker(
  state: State,
  clock: Clock,
  params: { column: Column; frac: string; text: string; color: Color },
): OpResult {
  const next = tick(state, clock);
  const id = dotKey(next.dot);
  const created: Created = { id, kind: "sticker" };
  const initial: [Key["field"], Value][] = [
    ["text", params.text],
    ["color", params.color],
    ["place", { column: params.column, frac: params.frac }],
    ["group", null],
    ["deleted", false],
  ];
  return {
    delta: {
      ...EMPTY,
      created: new Map([[identity(id), created]]),
      entries: new Map(
        initial.map(([field, value]) =>
          entryElement({ key: { entity: id, field }, dot: next.dot, stamp: next.stamp, value }),
        ),
      ),
    },
    clock: next.clock,
    dot: next.dot,
  };
}

/** editText(id, text) = setField({entity: id, field: "text"}, text). */
export function editText(state: State, clock: Clock, id: EntityId, text: string): OpResult {
  return setField(state, clock, { entity: id, field: "text" }, text);
}

/** move(id, place) = setField({entity: id, field: "place"}, place). */
export function move(state: State, clock: Clock, id: EntityId, place: Place): OpResult {
  return setField(state, clock, { entity: id, field: "place" }, place);
}
