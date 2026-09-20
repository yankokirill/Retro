// Публичный API ядра CRDT доски — docs/spec/consistency-model.md.
//
// Пакет чистый: без I/O, Date.now(), Math.random() (CLAUDE.md, правило 7).
// Валидация размеров и прав — не здесь, а в packages/protocol и на сервере.

import { PersistentMap } from "./persistent-map.js";
import type {
  ActionView,
  ActorId,
  CardView,
  Clock,
  Color,
  Column,
  Created,
  Delta,
  Dot,
  EntityId,
  Entry,
  GroupView,
  Item,
  Key,
  Kind,
  OpResult,
  Place,
  Stamp,
  State,
  Supersede,
  Unvote,
  UserId,
  Value,
  View,
  Vote,
  WireDelta,
} from "./types.js";

export type * from "./types.js";

// Идентичность элемента множества — JSON-кортеж: разделители внутри actorId не ломают ключ.
const identity = (...parts: (string | number)[]): string => JSON.stringify(parts);
const cellDotIdentity = (key: Key, dot: Dot): string =>
  identity(key.entity, key.field, dot.actor, dot.counter);

// ---------------------------------------------------------------------------
// Индекс видимых записей по ячейкам.
//
// `visible(state, key)` раньше сканировал ВСЕ записи состояния: O(n) на каждую
// операцию, на каждую цель генератора и на каждый `materialize`. Индекс
// `ячейка → неперекрытые записи` строится один раз на «линию» состояний и дальше
// инкрементально переносится через `merge`/`mergeAll` (O(|дельты| · log n)).
// Он целиком выводится из `entries` и `supersedes`, поэтому это кэш, а не часть
// состояния: держится в WeakMap и на семантику не влияет (I3).

type CellIndex = PersistentMap<readonly Entry[]>;

const cellKeyOf = (entity: string, field: string): string => `${entity}\u0000${field}`;

const cellIndexCache = new WeakMap<State, CellIndex>();

/** Ниже этого размера индекс лениво строится по первому запросу, а не переносится. */
const CELL_INDEX_EAGER_SIZE = 64;

function buildCellIndex(state: State): CellIndex {
  const groups = new Map<string, Entry[]>();
  for (const entry of state.entries.values()) {
    if (state.supersedes.has(cellDotIdentity(entry.key, entry.dot))) continue;
    const cell = cellKeyOf(entry.key.entity, entry.key.field);
    const list = groups.get(cell);
    if (list) list.push(entry);
    else groups.set(cell, [entry]);
  }
  return PersistentMap.from(groups);
}

function cellsOf(state: State): CellIndex {
  let index = cellIndexCache.get(state);
  if (!index) {
    index = buildCellIndex(state);
    cellIndexCache.set(state, index);
  }
  return index;
}

const sameDot = (a: Dot, b: Dot): boolean => a.actor === b.actor && a.counter === b.counter;

/**
 * Переносит индекс базового состояния на `result = ⨆ states`: добавляет записи
 * остальных состояний, ещё не перекрытые в `result`, и убирает записи, перекрытые
 * их `supersedes`. Ничего не делает, если ни у одного состояния индекса нет и оно
 * мало (тогда индекс построится по первому запросу). Совпадение идентичности с
 * иным элементом (нарушение W1) — индекс не переносим: перестроится лениво.
 */
function carryCellIndex(result: State, states: readonly State[]): void {
  let base: State | undefined;
  for (const state of states) {
    if (base === undefined || state.entries.size > base.entries.size) base = state;
  }
  if (base === undefined) return;
  let cells = cellIndexCache.get(base);
  if (!cells) {
    if (base.entries.size < CELL_INDEX_EAGER_SIZE) return;
    cells = buildCellIndex(base);
    cellIndexCache.set(base, cells);
  }
  let next: CellIndex = cells;
  for (const other of states) {
    if (other === base) continue;
    for (const [id, entry] of other.entries) {
      const known = base.entries.get(id);
      if (known !== undefined) {
        if (known !== entry && !sameValue(known, entry)) return;
        continue;
      }
      if (result.supersedes.has(cellDotIdentity(entry.key, entry.dot))) continue;
      const cell = cellKeyOf(entry.key.entity, entry.key.field);
      next = next.set(cell, [...(next.get(cell) ?? []), entry]);
    }
    for (const [id, superseded] of other.supersedes) {
      if (base.supersedes.has(id)) continue;
      const cell = cellKeyOf(superseded.key.entity, superseded.key.field);
      const list = next.get(cell);
      if (!list) continue;
      const kept = list.filter((entry) => !sameDot(entry.dot, superseded.dot));
      if (kept.length !== list.length) next = next.set(cell, kept);
    }
  }
  cellIndexCache.set(result, next);
}

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

/** Структурное равенство JSON-подобных значений без выделения строк (быстрый путь перед `canonical`). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index]));
  }
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && sameValue(left[key], right[key]));
}

/** `element` вытесняет `existing` при одной идентичности: канонически наибольший (W1). */
function replaces<T>(existing: T, element: T): boolean {
  return (
    existing !== element &&
    !sameValue(existing, element) &&
    canonical(element) > canonical(existing)
  );
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

/** Персистентная версия таблицы: обычный `Map` превращается один раз, `PersistentMap` остаётся как есть. */
function persistent<T>(map: ReadonlyMap<string, T>): PersistentMap<T> {
  return map instanceof PersistentMap ? map : PersistentMap.from(map);
}

/**
 * Объединение множеств. Корректные реплики никогда не порождают два разных элемента
 * с одной идентичностью (W1); если такое всё же пришло, берётся канонически
 * наибольший — так законы полурешётки держатся для любых входов.
 *
 * Меньшее множество вливается в большее: результат тот же (правило «побеждает
 * канонически наибольший» симметрично), а стоимость — O(|меньшего| · log n)
 * вместо копирования большего. Дубли (b ⊆ a) не создают новых версий вовсе.
 */
function union<T>(a: ReadonlyMap<string, T>, b: ReadonlyMap<string, T>): ReadonlyMap<string, T> {
  if (b.size === 0) return a;
  if (a.size === 0) return b;
  const [big, small] = a.size >= b.size ? [a, b] : [b, a];
  let result: PersistentMap<T> | null = null;
  for (const [id, element] of small) {
    const existing = (result ?? big).get(id);
    if (existing === undefined || replaces(existing, element)) {
      result = (result ?? persistent(big)).set(id, element);
    }
  }
  return result ?? big;
}

function unionAll<T>(maps: readonly ReadonlyMap<string, T>[]): ReadonlyMap<string, T> {
  const nonEmpty = maps.filter((map) => map.size > 0);
  if (nonEmpty.length === 0) return NO_ELEMENTS as ReadonlyMap<string, T>;
  let largest = nonEmpty[0] as ReadonlyMap<string, T>;
  for (const map of nonEmpty) if (map.size > largest.size) largest = map;
  let result: PersistentMap<T> | null = null;
  for (const map of nonEmpty) {
    if (map === largest) continue;
    for (const [id, element] of map) {
      const existing = (result ?? largest).get(id);
      if (existing === undefined || replaces(existing, element)) {
        result = (result ?? persistent(largest)).set(id, element);
      }
    }
  }
  return result ?? largest;
}

/**
 * ⨆ states — то же, что левая свёртка `merge` по списку, но за один проход и
 * с одной копией: `states.reduce(merge)` копирует растущий накопитель на каждом
 * шаге, O(k²) при длинной очереди дельт.
 */
export function mergeAll(states: readonly State[]): State {
  const result: State = {
    created: unionAll(states.map((state) => state.created)),
    entries: unionAll(states.map((state) => state.entries)),
    supersedes: unionAll(states.map((state) => state.supersedes)),
    votes: unionAll(states.map((state) => state.votes)),
    unvotes: unionAll(states.map((state) => state.unvotes)),
  };
  carryCellIndex(result, states);
  carryMaxLamport(result, states);
  return result;
}

/**
 * X ⊔ Y — покомпонентное объединение (§ 2). Коммутативно, ассоциативно,
 * идемпотентно для любых состояний.
 */
export function merge(a: State, b: State): State {
  const result: State = {
    created: union(a.created, b.created),
    entries: union(a.entries, b.entries),
    supersedes: union(a.supersedes, b.supersedes),
    votes: union(a.votes, b.votes),
    unvotes: union(a.unvotes, b.unvotes),
  };
  carryCellIndex(result, [a, b]);
  carryMaxLamport(result, [a, b]);
  return result;
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
  const list = cellsOf(state).get(cellKeyOf(key.entity, key.field));
  return list ? [...list].sort(byStampDescending) : [];
}

/** win_k(X): видимая запись с наибольшей меткой; undefined, если записей нет. */
export function winner(state: State, key: Key): Entry | undefined {
  return visible(state, key)[0];
}

/** vals_k(X): значения видимых записей, по убыванию метки. */
export function values(state: State, key: Key): Value[] {
  return visible(state, key).map((entry) => entry.value);
}

/**
 * V3 (docs/spec/consistency-model.md § 7): вид сущности `id` в `C(X)`,
 * `undefined` — сущности с таким id ещё нет. Сервер (T-010) использует это,
 * чтобы отличить «правку существующей сущности» (id должен уже быть в C) от
 * «создания» (id придёт в этой же дельте — проверять нечего).
 */
export function entityKind(state: State, id: EntityId): Kind | undefined {
  return state.created.get(identity(id))?.kind;
}

/** V4: запись `e ∈ E(X)` с `e.k = key, e.d = dot`, если она ещё присутствует в состоянии. */
export function entryAt(state: State, key: Key, dot: Dot): Entry | undefined {
  return state.entries.get(cellDotIdentity(key, dot));
}

/**
 * V4: пара `(key, dot)` уже отмечена как перекрытая в `S(X)`. Отдельно от
 * `entryAt`, потому что после компактизации (§ 6) сама запись `e` могла
 * быть удалена из `E`, а пара в `S` — нет (T5, `consistency-model.md`
 * § 9): «уже перекрыта» проверяется этим, а не отсутствием `entryAt`.
 */
export function supersedeRecorded(state: State, key: Key, dot: Dot): boolean {
  return state.supersedes.has(cellDotIdentity(key, dot));
}

/**
 * Наибольший `lamport` среди записей. Нужен каждой новой операции (`tick`), и скан
 * всех записей на каждую — O(n) на действие. Как и индекс ячеек, это кэш: считается
 * один раз на «линию» состояний и переносится через `merge`/`mergeAll`.
 */
const maxLamportCache = new WeakMap<State, number>();

function computeMaxLamport(state: State): number {
  let max = 0;
  for (const entry of state.entries.values()) {
    if (entry.stamp.lamport > max) max = entry.stamp.lamport;
  }
  return max;
}

function maxLamport(state: State): number {
  let max = maxLamportCache.get(state);
  if (max === undefined) {
    max = computeMaxLamport(state);
    maxLamportCache.set(state, max);
  }
  return max;
}

/** Максимум результата слияния = максимум максимумов; перебираются только записи не-базовых состояний. */
function carryMaxLamport(result: State, states: readonly State[]): void {
  let base: State | undefined;
  for (const state of states) {
    if (base === undefined || state.entries.size > base.entries.size) base = state;
  }
  if (base === undefined) return;
  let max = maxLamportCache.get(base);
  if (max === undefined) {
    if (base.entries.size < CELL_INDEX_EAGER_SIZE) return;
    max = computeMaxLamport(base);
    maxLamportCache.set(base, max);
  }
  for (const other of states) {
    if (other === base) continue;
    for (const entry of other.entries.values()) {
      if (entry.stamp.lamport > max) max = entry.stamp.lamport;
    }
  }
  maxLamportCache.set(result, max);
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
 * Общий конструктор создания сущности (§ 3.1): C = {(id, kind)}, id = dotKey(dot);
 * перечисленные поля получают записи с тем же dot, без перекрытий (сущность новая).
 * Используется createSticker/createGroup/createAction — они отличаются только
 * набором начальных полей.
 */
function createEntity(
  state: State,
  clock: Clock,
  kind: Kind,
  fields: readonly (readonly [Key["field"], Value])[],
): OpResult {
  const next = tick(state, clock);
  const id = dotKey(next.dot);
  const created: Created = { id, kind };
  return {
    delta: {
      ...EMPTY,
      created: new Map([[identity(id), created]]),
      entries: new Map(
        fields.map(([field, value]) =>
          entryElement({ key: { entity: id, field }, dot: next.dot, stamp: next.stamp, value }),
        ),
      ),
    },
    clock: next.clock,
    dot: next.dot,
  };
}

/** createSticker: text, color, place, group = null, deleted = false (§ 3.1). */
export function createSticker(
  state: State,
  clock: Clock,
  params: { column: Column; frac: string; text: string; color: Color },
): OpResult {
  return createEntity(state, clock, "sticker", [
    ["text", params.text],
    ["color", params.color],
    ["place", { column: params.column, frac: params.frac }],
    ["group", null],
    ["deleted", false],
  ]);
}

/** editText(id, text) = setField({entity: id, field: "text"}, text). */
export function editText(state: State, clock: Clock, id: EntityId, text: string): OpResult {
  return setField(state, clock, { entity: id, field: "text" }, text);
}

/** move(id, place) = setField({entity: id, field: "place"}, place). Обслуживает и moveGroup — поле одно и то же для любого Kind. */
export function move(state: State, clock: Clock, id: EntityId, place: Place): OpResult {
  return setField(state, clock, { entity: id, field: "place" }, place);
}

/** setColor(id, c) = setField({entity: id, field: "color"}, c). */
export function setColor(state: State, clock: Clock, id: EntityId, color: Color): OpResult {
  return setField(state, clock, { entity: id, field: "color" }, color);
}

/** setGroup(id, g): g = null означает «нет группы» (∅ из § 3.1). */
export function setGroup(
  state: State,
  clock: Clock,
  id: EntityId,
  group: EntityId | null,
): OpResult {
  return setField(state, clock, { entity: id, field: "group" }, group);
}

/**
 * delete(id)/restore(id) — один генерик на все виды сущностей (§ 3.1: этот же
 * примитив обслуживает deleteGroup/restoreGroup и deleteAction — поле `deleted`
 * устроено одинаково для sticker/group/action).
 */
export function deleteEntity(state: State, clock: Clock, id: EntityId): OpResult {
  return setField(state, clock, { entity: id, field: "deleted" }, true);
}
export function restoreEntity(state: State, clock: Clock, id: EntityId): OpResult {
  return setField(state, clock, { entity: id, field: "deleted" }, false);
}

/** createGroup: title, place, deleted=false — без text/color/group (§ 3.1). */
export function createGroup(
  state: State,
  clock: Clock,
  params: { column: Column; frac: string; title: string },
): OpResult {
  return createEntity(state, clock, "group", [
    ["title", params.title],
    ["place", { column: params.column, frac: params.frac }],
    ["deleted", false],
  ]);
}

/** renameGroup(id, title) = setField({entity: id, field: "title"}, title). Политика «все варианты» — как у text. */
export function renameGroup(state: State, clock: Clock, id: EntityId, title: string): OpResult {
  return setField(state, clock, { entity: id, field: "title" }, title);
}

/**
 * createAction: text, assignee=null, done=false, deleted=false (§ 3.1).
 * REQ-019 отказывается от восстановления в UI/протоколе, но на уровне CRDT
 * это то же поле `deleted`, что и у стикера/группы — отдельного примитива
 * «необратимое удаление» в этом пакете нет.
 */
export function createAction(state: State, clock: Clock, params: { text: string }): OpResult {
  return createEntity(state, clock, "action", [
    ["text", params.text],
    ["assignee", null],
    ["done", false],
    ["deleted", false],
  ]);
}

/** assign(id, guestId) = setField({entity: id, field: "assignee"}, guestId). null — нет ответственного. */
export function assign(state: State, clock: Clock, id: EntityId, guestId: string | null): OpResult {
  return setField(state, clock, { entity: id, field: "assignee" }, guestId);
}

/** setDone(id, done) = setField({entity: id, field: "done"}, done). */
export function setDone(state: State, clock: Clock, id: EntityId, done: boolean): OpResult {
  return setField(state, clock, { entity: id, field: "done" }, done);
}

/**
 * vote(target, user): V⁺ = {(d, user, target)} (§ 3.1). `user` — обезличенный
 * voterToken (docs/spec/protocol.md § 2), не guestId — анонимность голосов
 * (REQ-015, кр. 5) обеспечивается на уровне того, что кладут в это поле, а не
 * здесь. Тратит dot и лемпорт-метку из `clock`, как и любая другая операция
 * актора, но не пишет в E — голос не является записью ячейки, поэтому не
 * участвует в vis/win/values (у Vote нет Stamp, § 1.4 типов).
 */
export function vote(state: State, clock: Clock, target: EntityId, user: UserId): OpResult {
  const next = tick(state, clock);
  const entry: Vote = { dot: next.dot, user, target };
  return {
    delta: { ...EMPTY, votes: new Map([[identity(next.dot.actor, next.dot.counter), entry]]) },
    clock: next.clock,
    dot: next.dot,
  };
}

/**
 * unvote(vd, target): V⁻ = {(vd, target)} (§ 3.1). `vd` — dot ОТЗЫВАЕМОГО
 * голоса (элемент V⁺), а не новый dot этой операции: 2P-set идемпотентен по
 * самому факту членства (vd, target) ∈ V⁻, поэтому отдельного тика часов не
 * требует и `clock` не принимает и не возвращает — только `state`.
 * Проверка «это мой голос» (V7, not_own_vote) — забота сервера, не CRDT.
 */
export function unvote(_state: State, voteDot: Dot, target: EntityId): Delta {
  const entry: Unvote = { dot: voteDot, target };
  return {
    ...EMPTY,
    unvotes: new Map([[identity(voteDot.actor, voteDot.counter, target), entry]]),
  };
}

/**
 * `index`-й элемент таблицы состояния (`created`/`entries`/`votes`/…) по порядку
 * итерации — O(log n) для персистентной таблицы (то есть для любого состояния,
 * прошедшего `merge`), O(index) для обычной. Нужен выборке случайной цели без
 * обхода всего состояния; порядок не имеет смысла ни для чего, кроме выборки.
 */
export function elementAt<T>(map: ReadonlyMap<string, T>, index: number): T | undefined {
  if (map instanceof PersistentMap) return map.nth(index)?.[1];
  if (!Number.isInteger(index) || index < 0 || index >= map.size) return undefined;
  let position = 0;
  for (const value of map.values()) {
    if (position === index) return value;
    position += 1;
  }
  return undefined;
}

/** Голос `vote` из `V⁺` ещё не отозван: `(dot, target) ∉ V⁻` — O(1) вместо `activeVotes` по всем голосам. */
export function isVoteActive(state: State, vote: Vote): boolean {
  return !state.unvotes.has(identity(vote.dot.actor, vote.dot.counter, vote.target));
}

/** Голоса участника, ещё не отозванные: active(X) из § 2. */
export function activeVotes(state: State, target?: EntityId): Vote[] {
  const result: Vote[] = [];
  for (const entry of state.votes.values()) {
    if (target !== undefined && entry.target !== target) continue;
    if (state.unvotes.has(identity(entry.dot.actor, entry.dot.counter, entry.target))) continue;
    result.push(entry);
  }
  return result;
}

/**
 * materialize: X → View (§ 4) — то, что видно на экране: чистая функция
 * **множества** `state`, не порядка, в котором его собирали (I3).
 *
 * Ограничение M1: результат зависит от `state` только через `created`,
 * функции `visible`/`winner`/`values` (vis_k/win_k/vals_k) и `activeVotes`
 * (active(X)) — реализация не должна использовать ничего сверх этого
 * (например, порядок вставки в исходные Map).
 *
 * Правила R1–R7 (§ 4):
 * - R1: сущность видна, если `exists(id) ∧ ¬deleted(id)`; удалённая — в
 *   `trash` (только sticker/group — action items в trash не попадают, у
 *   них нет `place`, см. JSDoc `View` в types.ts). Записи ячеек без записи
 *   в `created` игнорируются (операция создания ещё не пришла).
 * - R2: `text`/`title` = vals_k, `conflict = text.length > 1`; `color` =
 *   победитель по метке.
 * - R3: эффективная группа стикера `g* = winner(id, "group").value`, если
 *   она существует, это `group` и не удалена; иначе `none`.
 * - R4: стикер с `g* = none` — в своей колонке по `place`; иначе — внутри
 *   группы, свой `place` не используется.
 * - R5: порядок внутри колонки/группы — по `(frac, id)` по возрастанию, при
 *   равных `frac` решает порядок `Dot` (`dotKey`).
 * - R6: `votes(id) = |{v ∈ activeVotes(state) | v.target === id}|`; голоса
 *   за удалённый стикер не показываются (удалённый стикер не попадает в
 *   `CardView`), но остаются в `activeVotes`.
 * - R7: `trash` и `actions` отсортированы по `id`.
 */
/** Dot, закодированный в EntityId (§ 1.4: id сущности = dotKey dot её создания). */
function entityDot(id: EntityId): Dot {
  const separator = id.lastIndexOf(":");
  return { actor: id.slice(0, separator), counter: Number(id.slice(separator + 1)) };
}

/** R5: порядок по (frac, id) по возрастанию, тай-брейк по Dot (§ 1.2). */
function compareOrder(
  a: { frac: string; id: EntityId },
  b: { frac: string; id: EntityId },
): number {
  if (a.frac !== b.frac) return a.frac < b.frac ? -1 : 1;
  return compareDots(entityDot(a.id), entityDot(b.id));
}

/**
 * Индекс для одного вызова `materialize`: те же `visible`/`activeVotes`, но
 * группировка записей по ячейке и голосов по цели строится за один проход,
 * а не сканом всех `entries`/`votes` на каждую сущность×поле (O(n²)).
 * Результаты совпадают с `visible`/`winner`/`values`/`activeVotes` (M1).
 */
function buildLookup(state: State): {
  visibleOf: (entity: EntityId, field: string) => Entry[];
  votesOf: (id: EntityId) => number;
} {
  const cells = new Map<string, Entry[]>();
  for (const entry of state.entries.values()) {
    if (state.supersedes.has(cellDotIdentity(entry.key, entry.dot))) continue;
    const cellKey = `${entry.key.entity}\u0000${entry.key.field}`;
    const list = cells.get(cellKey);
    if (list) list.push(entry);
    else cells.set(cellKey, [entry]);
  }
  for (const list of cells.values()) list.sort(byStampDescending);

  const voteCounts = new Map<EntityId, number>();
  for (const vote of state.votes.values()) {
    if (state.unvotes.has(identity(vote.dot.actor, vote.dot.counter, vote.target))) continue;
    voteCounts.set(vote.target, (voteCounts.get(vote.target) ?? 0) + 1);
  }

  return {
    visibleOf: (entity, field) => cells.get(`${entity}\u0000${field}`) ?? [],
    votesOf: (id) => voteCounts.get(id) ?? 0,
  };
}

export function materialize(state: State): View {
  const kindOf = new Map<EntityId, Kind>();
  for (const created of state.created.values()) kindOf.set(created.id, created.kind);

  const { visibleOf, votesOf } = buildLookup(state);
  const winnerOf = (entity: EntityId, field: string): Entry | undefined =>
    visibleOf(entity, field)[0];
  const textValues = (entity: EntityId, field: "text" | "title"): string[] =>
    visibleOf(entity, field).map((entry) => entry.value) as string[];
  const isDeleted = (id: EntityId): boolean => winnerOf(id, "deleted")?.value === true;

  const trash: EntityId[] = [];
  const actions: ActionView[] = [];
  const groupMeta = new Map<
    EntityId,
    {
      readonly title: string[];
      readonly conflict: boolean;
      readonly votes: number;
      readonly place: Place;
    }
  >();
  const stickers: Array<{ card: CardView; place: Place; effectiveGroup: EntityId | null }> = [];

  for (const created of state.created.values()) {
    const { id, kind } = created;

    if (kind === "action") {
      if (isDeleted(id)) continue; // R1: удалённый action item — не в actions и не в trash (см. JSDoc View)
      const text = textValues(id, "text");
      const assignee = (winnerOf(id, "assignee")?.value ?? null) as UserId | null;
      const done = winnerOf(id, "done")?.value === true;
      actions.push({ id, text, conflict: text.length > 1, assignee, done });
      continue;
    }

    if (isDeleted(id)) {
      trash.push(id);
      continue;
    }

    const place = winnerOf(id, "place")?.value as Place;

    if (kind === "group") {
      const title = textValues(id, "title");
      groupMeta.set(id, { title, conflict: title.length > 1, votes: votesOf(id), place });
      continue;
    }

    const text = textValues(id, "text");
    const color = winnerOf(id, "color")?.value as Color;
    const card: CardView = { id, text, conflict: text.length > 1, color, votes: votesOf(id) };

    const groupField = winnerOf(id, "group")?.value as EntityId | null | undefined;
    // R3: эффективная группа — только существующая, невыудалённая сущность вида group.
    const effectiveGroup =
      groupField != null && kindOf.get(groupField) === "group" && !isDeleted(groupField)
        ? groupField
        : null;

    stickers.push({ card, place, effectiveGroup });
  }

  const groupCards = new Map<EntityId, Array<{ card: CardView; place: Place }>>();
  const topLevel: Array<{ item: Item; place: Place }> = [];

  for (const sticker of stickers) {
    if (sticker.effectiveGroup !== null) {
      const list = groupCards.get(sticker.effectiveGroup) ?? [];
      list.push({ card: sticker.card, place: sticker.place });
      groupCards.set(sticker.effectiveGroup, list);
    } else {
      topLevel.push({ item: sticker.card, place: sticker.place });
    }
  }

  for (const [id, meta] of groupMeta) {
    const cards = (groupCards.get(id) ?? [])
      .sort((a, b) =>
        compareOrder({ frac: a.place.frac, id: a.card.id }, { frac: b.place.frac, id: b.card.id }),
      )
      .map((entry) => entry.card);
    const group: GroupView = {
      id,
      title: meta.title,
      conflict: meta.conflict,
      votes: meta.votes,
      cards,
    };
    topLevel.push({ item: group, place: meta.place });
  }

  const buckets = new Map<Column, Array<{ item: Item; place: Place }>>();
  for (const column of ["start", "stop", "continue"] as const) buckets.set(column, []);
  for (const placed of topLevel) {
    buckets.get(placed.place.column)?.push(placed);
  }

  const columns = new Map<Column, Item[]>();
  for (const [column, placed] of buckets) {
    columns.set(
      column,
      [...placed]
        .sort((a, b) =>
          compareOrder(
            { frac: a.place.frac, id: a.item.id },
            { frac: b.place.frac, id: b.item.id },
          ),
        )
        .map((entry) => entry.item),
    );
  }

  trash.sort();
  actions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { columns, trash, actions };
}

/**
 * compact(X) — § 6: выбрасывает из `state` только перекрытые записи (те, чей
 * `(key, dot)` уже встречается в `supersedes`) и отозванные голоса (те, чей
 * `(dot, target)` уже встречается в `unvotes`). `created`, `supersedes`,
 * `unvotes` не меняются — они маленькие (пары идентификаторов) и нужны,
 * чтобы поздно пришедшая старая запись/голос всё равно остались невидимы.
 *
 * I4 (§ 8): для любого достижимого `state` и любого `y`,
 * `materialize(compact(state) ⊔ y) = materialize(state ⊔ y)`.
 */
export function compact(state: State): State {
  const entries = new Map<string, Entry>();
  for (const [key, entry] of state.entries) {
    if (state.supersedes.has(cellDotIdentity(entry.key, entry.dot))) continue;
    entries.set(key, entry);
  }

  const votes = new Map<string, Vote>();
  for (const [key, vote] of state.votes) {
    if (state.unvotes.has(identity(vote.dot.actor, vote.dot.counter, vote.target))) continue;
    votes.set(key, vote);
  }

  return {
    created: state.created,
    entries,
    supersedes: state.supersedes,
    votes,
    unvotes: state.unvotes,
  };
}

/**
 * toWire(X): `State` (пять `Map`) → `WireDelta` (пять массивов, порядок не
 * значим) — проводной формат из `packages/protocol` (`wireDeltaSchema`).
 * Чистая проекция значений `Map`, без изменения их состава.
 */
export function toWire(state: State): WireDelta {
  return {
    created: [...state.created.values()],
    entries: [...state.entries.values()],
    supersedes: [...state.supersedes.values()],
    votes: [...state.votes.values()],
    unvotes: [...state.unvotes.values()],
  };
}

/**
 * fromWire(w): обратное `toWire` — `WireDelta` → `State`. Для любого
 * достижимого `state`, `equals(fromWire(toWire(state)), state)` (сравнение
 * как множеств, не порядка) — `toWire`/`fromWire` не теряют и не добавляют
 * элементы.
 */
export function fromWire(wire: WireDelta): State {
  const created = new Map<string, Created>();
  for (const c of wire.created) created.set(identity(c.id), c);

  const entries = new Map<string, Entry>();
  for (const e of wire.entries) entries.set(cellDotIdentity(e.key, e.dot), e);

  const supersedes = new Map<string, Supersede>();
  for (const s of wire.supersedes) supersedes.set(cellDotIdentity(s.key, s.dot), s);

  const votes = new Map<string, Vote>();
  for (const v of wire.votes) votes.set(identity(v.dot.actor, v.dot.counter), v);

  const unvotes = new Map<string, Unvote>();
  for (const u of wire.unvotes) unvotes.set(identity(u.dot.actor, u.dot.counter, u.target), u);

  return { created, entries, supersedes, votes, unvotes };
}
