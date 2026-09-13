// Генераторы fast-check и построители сценариев для приёмочных тестов T-001.
//
// Важно: сценарии строятся ТОЛЬКО через публичный API `packages/crdt/src/index.ts`
// (empty, merge, newClock, createSticker, editText, move, setField) — а не через
// произвольные Map, чтобы результат заведомо был корректной формы (W1–W4,
// consistency-model.md § 7). Пока функции API — заглушки, сама генерация значений
// бросает "not implemented"; это ожидаемо и обнаруживается в момент запуска
// свойства (fc.assert), а не при импорте файла.

import fc from "fast-check";
import {
  type ActorId,
  type Clock,
  type Color,
  type Column,
  createSticker,
  type Delta,
  type Dot,
  type EntityId,
  type Entry,
  editText,
  empty,
  type Field,
  type Key,
  merge,
  move,
  newClock,
  type Place,
  type State,
  setField,
  type Value,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Примитивные генераторы значений по типам § 1.4
// ---------------------------------------------------------------------------

export const COLUMNS: readonly Column[] = ["start", "stop", "continue"];
export const COLORS: readonly Color[] = ["yellow", "green", "blue", "pink", "purple"];

/** Поля стикера из таблицы § 1.4 (без учёта group/action-специфичных полей). */
export const STICKER_FIELDS: readonly Field[] = ["text", "color", "place", "group", "deleted"];

export const columnArb: fc.Arbitrary<Column> = fc.constantFrom(...COLUMNS);
export const colorArb: fc.Arbitrary<Color> = fc.constantFrom(...COLORS);

export const textArb = (maxLength = 24): fc.Arbitrary<string> => fc.string({ maxLength });

export const fracArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 6 })
  .map((s) => `${s}|frac`);

export const placeArb: fc.Arbitrary<Place> = fc.record({ column: columnArb, frac: fracArb });

/** Значение для поля `field` — по домену из таблицы § 1.4. */
export function fieldValueArb(field: Field): fc.Arbitrary<Value> {
  switch (field) {
    case "text":
      return textArb();
    case "color":
      return colorArb;
    case "place":
      return placeArb;
    case "group":
      // GroupId ∪ {none}; на уровне CRDT-состояния существование группы не
      // проверяется (это V3, забота сервера), поэтому годится произвольная строка.
      return fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 8 }));
    case "deleted":
      return fc.boolean();
    default:
      throw new Error(`fieldValueArb: неожиданное поле стикера ${field}`);
  }
}

/**
 * Пул уникальных actorId. `tag` разделяет пулы разных сценариев в одном
 * property-запуске (например "A"/"B"/"C" для законов ассоциативности), чтобы
 * dot из разных сценариев никогда не совпадали — это разные акторы.
 */
export function actorPoolArb(tag: string, min = 2, max = 4): fc.Arbitrary<ActorId[]> {
  return fc
    .uniqueArray(fc.integer({ min: 0, max: 1_000_000 }), { minLength: min, maxLength: max })
    .map((ns) => ns.map((n) => `${tag}-actor-${n}`));
}

// ---------------------------------------------------------------------------
// Описания операций (чистые данные — без вызовов CRDT API)
// ---------------------------------------------------------------------------

export interface CreateOp {
  readonly kind: "create";
  readonly actor: ActorId;
  readonly column: Column;
  readonly frac: string;
  readonly text: string;
  readonly color: Color;
}

export interface EditTextOp {
  readonly kind: "editText";
  readonly actor: ActorId;
  readonly pick: number;
  readonly text: string;
}

export interface MoveOp {
  readonly kind: "move";
  readonly actor: ActorId;
  readonly pick: number;
  readonly place: Place;
}

export interface SetFieldOp {
  readonly kind: "setField";
  readonly actor: ActorId;
  readonly pick: number;
  readonly field: Field;
  readonly value: Value;
}

export type OpDescriptor = CreateOp | EditTextOp | MoveOp | SetFieldOp;

export function opsArb(
  actors: readonly ActorId[],
  opts: { minLength?: number; maxLength?: number } = {},
): fc.Arbitrary<OpDescriptor[]> {
  const actorArb = fc.constantFrom(...actors);

  const createArb: fc.Arbitrary<CreateOp> = fc.record({
    kind: fc.constant("create" as const),
    actor: actorArb,
    column: columnArb,
    frac: fracArb,
    text: textArb(),
    color: colorArb,
  });

  const editTextArb: fc.Arbitrary<EditTextOp> = fc.record({
    kind: fc.constant("editText" as const),
    actor: actorArb,
    pick: fc.nat(),
    text: textArb(),
  });

  const moveArb: fc.Arbitrary<MoveOp> = fc.record({
    kind: fc.constant("move" as const),
    actor: actorArb,
    pick: fc.nat(),
    place: placeArb,
  });

  const setFieldArb: fc.Arbitrary<SetFieldOp> = fc.constantFrom(...STICKER_FIELDS).chain((field) =>
    fc.record({
      kind: fc.constant("setField" as const),
      actor: actorArb,
      pick: fc.nat(),
      field: fc.constant(field),
      value: fieldValueArb(field),
    }),
  );

  const opArb: fc.Arbitrary<OpDescriptor> = fc.oneof(createArb, editTextArb, moveArb, setFieldArb);

  return fc.array(opArb, { minLength: opts.minLength ?? 1, maxLength: opts.maxLength ?? 12 });
}

// ---------------------------------------------------------------------------
// Исполнение сценария через настоящий API — единая синхронная временная
// линия: каждая операция немедленно "сливается" в общее состояние, поэтому
// результат заведомо достижим легитимной последовательностью операций
// (корректная форма W1–W4). Конкурентность (несколько акторов, не видевших
// операций друг друга) моделируется отдельно в register.test.ts через
// createForkScenario — там разветвление явное и осознанное.
// ---------------------------------------------------------------------------

export interface ScenarioResult {
  readonly actors: readonly ActorId[];
  /** Дельта каждой выполненной операции, в порядке выполнения. */
  readonly deltas: readonly Delta[];
  /** EntityId стикеров в порядке создания. */
  readonly createdIds: readonly EntityId[];
  /** Итоговое состояние — merge всех дельт по порядку выполнения. */
  readonly merged: State;
}

const FALLBACK_CREATE: Omit<CreateOp, "actor"> = {
  kind: "create",
  column: "start",
  frac: "seed|frac",
  text: "seed",
  color: "yellow",
};

export function runScenario(
  actors: readonly ActorId[],
  ops: readonly OpDescriptor[],
): ScenarioResult {
  if (actors.length === 0) {
    throw new Error("runScenario: нужен хотя бы один актор");
  }
  const clocks = new Map<ActorId, Clock>(actors.map((a) => [a, newClock(a)]));
  let world: State = empty();
  const deltas: Delta[] = [];
  const createdIds: EntityId[] = [];

  const doCreate = (actor: ActorId, params: Omit<CreateOp, "actor" | "kind">) => {
    const clock = clocks.get(actor);
    if (!clock) throw new Error(`runScenario: неизвестный актор ${actor}`);
    const result = createSticker(world, clock, params);
    clocks.set(actor, result.clock);
    world = merge(world, result.delta);
    deltas.push(result.delta);
    const created = [...result.delta.created.values()][0];
    if (!created) throw new Error("runScenario: createSticker не создал сущность");
    createdIds.push(created.id);
  };

  for (const op of ops) {
    if (op.kind === "create") {
      doCreate(op.actor, op);
      continue;
    }
    if (createdIds.length === 0) {
      // Ещё нет ни одной сущности — операция над несуществующим id заменяется
      // созданием, чтобы сценарий оставался причинно корректным.
      doCreate(op.actor, FALLBACK_CREATE);
      continue;
    }
    const index = ((op.pick % createdIds.length) + createdIds.length) % createdIds.length;
    const id = createdIds[index];
    if (id === undefined) throw new Error("runScenario: индекс сущности вне диапазона");
    const clock = clocks.get(op.actor);
    if (!clock) throw new Error(`runScenario: неизвестный актор ${op.actor}`);

    const result =
      op.kind === "editText"
        ? editText(world, clock, id, op.text)
        : op.kind === "move"
          ? move(world, clock, id, op.place)
          : setField(world, clock, { entity: id, field: op.field }, op.value);

    clocks.set(op.actor, result.clock);
    world = merge(world, result.delta);
    deltas.push(result.delta);
  }

  return { actors, deltas, createdIds, merged: world };
}

export function scenarioArb(
  tag: string,
  opts: { minOps?: number; maxOps?: number; minActors?: number; maxActors?: number } = {},
): fc.Arbitrary<ScenarioResult> {
  return actorPoolArb(tag, opts.minActors ?? 2, opts.maxActors ?? 4).chain((actors) =>
    opsArb(actors, { minLength: opts.minOps ?? 1, maxLength: opts.maxOps ?? 12 }).map((ops) =>
      runScenario(actors, ops),
    ),
  );
}

export function foldDeltas(deltas: readonly Delta[]): State {
  return deltas.reduce<State>((acc, d) => merge(acc, d), empty());
}

/** Все перестановки списка (для полного перебора на малых входах). */
export function* permutations<T>(items: readonly T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) {
      yield [items[i] as T, ...perm];
    }
  }
}

// ---------------------------------------------------------------------------
// Сценарий "развилки" — общий предок, затем два актора расходятся, не видя
// операций друг друга (REQ-007, REQ-008): реалистичная конкурентность.
// ---------------------------------------------------------------------------

export interface ForkBranch {
  readonly actor: ActorId;
  readonly clock: Clock;
  readonly state: State;
}

export interface ForkScenario {
  readonly id: EntityId;
  /** Состояние с одним стикером — общий предок, известный обеим ветвям. */
  readonly base: State;
  readonly branchA: ForkBranch;
  readonly branchB: ForkBranch;
}

export interface CreateParams {
  readonly column: Column;
  readonly frac: string;
  readonly text: string;
  readonly color: Color;
}

/**
 * `warmups` — число «прогревочных» правок цвета, которые ветка делает над
 * своим локальным состоянием до конфликтующей операции. Продвигает часы
 * ветки (lamport) вперёд, не трогая поле под тестом, поэтому конфликт
 * остаётся настоящим конкурентным (никто не видел операцию другого), но
 * позволяет генерировать случаи как с равными, так и с разными lamport —
 * чтобы разрешение конфликта по compareStamps проверялось в обоих режимах.
 */
export function createForkScenario(
  creator: ActorId,
  branchActors: readonly [ActorId, ActorId],
  params: CreateParams,
  warmups: readonly [number, number] = [0, 0],
): ForkScenario {
  const creatorClock = newClock(creator);
  const created = createSticker(empty(), creatorClock, params);
  const base = created.delta;
  const createdEntity = [...base.created.values()][0];
  if (!createdEntity) throw new Error("createForkScenario: createSticker не создал сущность");
  const id = createdEntity.id;

  const branch = (actor: ActorId, warmupCount: number): ForkBranch => {
    let clock = newClock(actor);
    let state = merge(empty(), base);
    for (let i = 0; i < warmupCount; i++) {
      const r = setField(
        state,
        clock,
        { entity: id, field: "color" },
        i % 2 === 0 ? "green" : "blue",
      );
      clock = r.clock;
      state = merge(state, r.delta);
    }
    return { actor, clock, state };
  };

  return {
    id,
    base,
    branchA: branch(branchActors[0], warmups[0]),
    branchB: branch(branchActors[1], warmups[1]),
  };
}

// ---------------------------------------------------------------------------
// Мелкие предикаты-помощники для сравнения Value (Place — структура, не
// примитив) и поиска записи по dot без знания внутреннего формата ключа Map.
// ---------------------------------------------------------------------------

export function valueEquals(a: Value, b: Value): boolean {
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    return a.column === b.column && a.frac === b.frac;
  }
  return a === b;
}

export function findEntryByDot(state: State, key: Key, dot: Dot): Entry | undefined {
  for (const e of state.entries.values()) {
    if (
      e.key.entity === key.entity &&
      e.key.field === key.field &&
      e.dot.actor === dot.actor &&
      e.dot.counter === dot.counter
    ) {
      return e;
    }
  }
  return undefined;
}

export function soleEntry(delta: Delta): Entry {
  const entry = [...delta.entries.values()][0];
  if (!entry) throw new Error("soleEntry: дельта не содержит ни одной записи");
  return entry;
}
