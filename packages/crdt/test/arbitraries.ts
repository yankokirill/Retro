// Генераторы fast-check и построители сценариев для приёмочных тестов T-001.
//
// Важно: сценарии строятся ТОЛЬКО через публичный API `packages/crdt/src/index.ts`
// (empty, merge, newClock, createSticker, editText, move, setField) — а не через
// произвольные Map, чтобы результат заведомо был корректной формы (W1–W4,
// consistency-model.md § 7). Пока функции API — заглушки, сама генерация значений
// бросает "not implemented"; это ожидаемо и обнаруживается в момент запуска
// свойства (fc.assert), а не при импорте файла.

import fc from "fast-check";
import * as CrdtModule from "../src/index.js";
import {
  type ActorId,
  type Clock,
  type Color,
  type Column,
  createSticker,
  type Delta,
  type Dot,
  dotKey,
  type EntityId,
  type Entry,
  editText,
  empty,
  type Field,
  type Key,
  merge,
  move,
  newClock,
  type OpResult,
  type Place,
  type State,
  setField,
  type UserId,
  type Value,
  type Vote,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// T-002 ещё не начат: в src/index.ts нет даже throwing-заглушек для setColor,
// setGroup, deleteEntity, restoreEntity, createGroup, renameGroup,
// createAction, assign, setDone, vote, unvote, activeVotes (в отличие от
// T-001, где на момент написания этого файла заглушки уже существовали —
// отсюда исторический комментарий выше). Сигнатуры ниже — контракт из
// `docs/spec/consistency-model.md` § 3.1 (все поля/операции описаны в
// таблице § 1.4 и § 3.1), а не подсмотренная реализация: тело этого пакета
// (`packages/crdt/src`), кроме index.ts/types.ts, агент test-author не
// читает. Приведение типа делает файл компилируемым уже сейчас; вызов любой
// из этих функций до реализации бросает `TypeError: ... is not a function`
// — тесты падают из-за отсутствия реализации, а не из-за ошибки в тесте.
// Как только `src/index.ts` экспортирует настоящие функции с такими
// сигнатурами, приведение станет тождественным без правки тестов.
// ---------------------------------------------------------------------------
export interface PendingT2Ops {
  setColor(state: State, clock: Clock, id: EntityId, color: Color): OpResult;
  setGroup(state: State, clock: Clock, id: EntityId, group: EntityId | null): OpResult;
  deleteEntity(state: State, clock: Clock, id: EntityId): OpResult;
  restoreEntity(state: State, clock: Clock, id: EntityId): OpResult;
  createGroup(
    state: State,
    clock: Clock,
    params: { column: Column; frac: string; title: string },
  ): OpResult;
  renameGroup(state: State, clock: Clock, id: EntityId, title: string): OpResult;
  createAction(state: State, clock: Clock, params: { text: string }): OpResult;
  assign(state: State, clock: Clock, id: EntityId, guestId: string | null): OpResult;
  setDone(state: State, clock: Clock, id: EntityId, done: boolean): OpResult;
  vote(state: State, clock: Clock, target: EntityId, user: UserId): OpResult;
  unvote(state: State, voteDot: Dot, target: EntityId): Delta;
  activeVotes(state: State, target?: EntityId): Vote[];
}

export const pendingOps: PendingT2Ops = CrdtModule as unknown as PendingT2Ops;

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

/**
 * GroupId ∪ {none}; на уровне CRDT-состояния существование группы не
 * проверяется (это V3, забота сервера), поэтому годится произвольная строка.
 */
export const groupValueArb: fc.Arbitrary<EntityId | null> = fc.oneof(
  fc.constant(null),
  fc.string({ minLength: 1, maxLength: 8 }),
);

/** U ∪ {none} для `assignee` — на уровне состояния тоже произвольная строка (V3 — забота сервера). */
export const guestIdArb: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  fc.string({ minLength: 1, maxLength: 8 }).map((s) => `guest-${s}`),
);

/** Обезличенный voterToken для `vote` (docs/spec/protocol.md § 2) — произвольная строка на этом уровне. */
export const userIdArb: fc.Arbitrary<UserId> = fc
  .string({ minLength: 1, maxLength: 8 })
  .map((s) => `user-${s}`);

/** Значение для поля `field` — по домену из таблицы § 1.4. */
export function fieldValueArb(field: Field): fc.Arbitrary<Value> {
  switch (field) {
    case "text":
    case "title":
      return textArb();
    case "color":
      return colorArb;
    case "place":
      return placeArb;
    case "group":
      return groupValueArb;
    case "assignee":
      return guestIdArb;
    case "deleted":
    case "done":
      return fc.boolean();
    default:
      throw new Error(`fieldValueArb: неожиданное поле ${field satisfies never}`);
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

// ---------------------------------------------------------------------------
// T-002: операции добавлены сюда, а не в отдельный генератор, чтобы
// существующие property-тесты T1/сходимости (lattice.test.ts,
// convergence.test.ts), построенные на opsArb/scenarioArb, автоматически
// начали покрывать и их (crdt-op SKILL.md, п.6–7). На уровне состояния CRDT
// принадлежность поля конкретному Kind не проверяется (V3 — забота
// сервера), поэтому "pick" ниже может указать на сущность любого вида,
// созданную ранее в сценарии, — это не ошибка теста, а осознанное упрощение
// генератора (см. также STICKER_FIELDS/setField выше).
// ---------------------------------------------------------------------------

export interface CreateGroupOp {
  readonly kind: "createGroup";
  readonly actor: ActorId;
  readonly column: Column;
  readonly frac: string;
  readonly title: string;
}

export interface CreateActionOp {
  readonly kind: "createAction";
  readonly actor: ActorId;
  readonly text: string;
}

export interface SetColorOp {
  readonly kind: "setColor";
  readonly actor: ActorId;
  readonly pick: number;
  readonly color: Color;
}

export interface SetGroupOp {
  readonly kind: "setGroup";
  readonly actor: ActorId;
  readonly pick: number;
  readonly group: EntityId | null;
}

export interface DeleteOp {
  readonly kind: "delete";
  readonly actor: ActorId;
  readonly pick: number;
}

export interface RestoreOp {
  readonly kind: "restore";
  readonly actor: ActorId;
  readonly pick: number;
}

export interface RenameGroupOp {
  readonly kind: "renameGroup";
  readonly actor: ActorId;
  readonly pick: number;
  readonly title: string;
}

export interface AssignOp {
  readonly kind: "assign";
  readonly actor: ActorId;
  readonly pick: number;
  readonly guestId: string | null;
}

export interface SetDoneOp {
  readonly kind: "setDone";
  readonly actor: ActorId;
  readonly pick: number;
  readonly done: boolean;
}

export type OpDescriptor =
  | CreateOp
  | EditTextOp
  | MoveOp
  | SetFieldOp
  | CreateGroupOp
  | CreateActionOp
  | SetColorOp
  | SetGroupOp
  | DeleteOp
  | RestoreOp
  | RenameGroupOp
  | AssignOp
  | SetDoneOp;

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

  const createGroupArb: fc.Arbitrary<CreateGroupOp> = fc.record({
    kind: fc.constant("createGroup" as const),
    actor: actorArb,
    column: columnArb,
    frac: fracArb,
    title: textArb(),
  });

  const createActionArb: fc.Arbitrary<CreateActionOp> = fc.record({
    kind: fc.constant("createAction" as const),
    actor: actorArb,
    text: textArb(),
  });

  const setColorArb: fc.Arbitrary<SetColorOp> = fc.record({
    kind: fc.constant("setColor" as const),
    actor: actorArb,
    pick: fc.nat(),
    color: colorArb,
  });

  const setGroupArb: fc.Arbitrary<SetGroupOp> = fc.record({
    kind: fc.constant("setGroup" as const),
    actor: actorArb,
    pick: fc.nat(),
    group: groupValueArb,
  });

  const deleteArb: fc.Arbitrary<DeleteOp> = fc.record({
    kind: fc.constant("delete" as const),
    actor: actorArb,
    pick: fc.nat(),
  });

  const restoreArb: fc.Arbitrary<RestoreOp> = fc.record({
    kind: fc.constant("restore" as const),
    actor: actorArb,
    pick: fc.nat(),
  });

  const renameGroupArb: fc.Arbitrary<RenameGroupOp> = fc.record({
    kind: fc.constant("renameGroup" as const),
    actor: actorArb,
    pick: fc.nat(),
    title: textArb(),
  });

  const assignArb: fc.Arbitrary<AssignOp> = fc.record({
    kind: fc.constant("assign" as const),
    actor: actorArb,
    pick: fc.nat(),
    guestId: guestIdArb,
  });

  const setDoneArb: fc.Arbitrary<SetDoneOp> = fc.record({
    kind: fc.constant("setDone" as const),
    actor: actorArb,
    pick: fc.nat(),
    done: fc.boolean(),
  });

  const opArb: fc.Arbitrary<OpDescriptor> = fc.oneof(
    createArb,
    editTextArb,
    moveArb,
    setFieldArb,
    createGroupArb,
    createActionArb,
    setColorArb,
    setGroupArb,
    deleteArb,
    restoreArb,
    renameGroupArb,
    assignArb,
    setDoneArb,
  );

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
  /** Dot каждой выполненной операции, в том же порядке, что и `deltas` (для проверок I2/no-loss). */
  readonly dots: readonly Dot[];
  /** EntityId сущностей (стикеров/групп/action) в порядке создания. */
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
  const dots: Dot[] = [];
  const createdIds: EntityId[] = [];

  const recordCreate = (actor: ActorId, result: OpResult) => {
    clocks.set(actor, result.clock);
    world = merge(world, result.delta);
    deltas.push(result.delta);
    dots.push(result.dot);
    const created = [...result.delta.created.values()][0];
    if (!created) throw new Error("runScenario: операция создания не создала сущность");
    createdIds.push(created.id);
  };

  const doCreate = (actor: ActorId, params: Omit<CreateOp, "actor" | "kind">) => {
    const clock = clocks.get(actor);
    if (!clock) throw new Error(`runScenario: неизвестный актор ${actor}`);
    recordCreate(actor, createSticker(world, clock, params));
  };

  const doCreateGroup = (actor: ActorId, params: Omit<CreateGroupOp, "actor" | "kind">) => {
    const clock = clocks.get(actor);
    if (!clock) throw new Error(`runScenario: неизвестный актор ${actor}`);
    recordCreate(actor, pendingOps.createGroup(world, clock, params));
  };

  const doCreateAction = (actor: ActorId, params: Omit<CreateActionOp, "actor" | "kind">) => {
    const clock = clocks.get(actor);
    if (!clock) throw new Error(`runScenario: неизвестный актор ${actor}`);
    recordCreate(actor, pendingOps.createAction(world, clock, params));
  };

  for (const op of ops) {
    if (op.kind === "create") {
      doCreate(op.actor, op);
      continue;
    }
    if (op.kind === "createGroup") {
      doCreateGroup(op.actor, op);
      continue;
    }
    if (op.kind === "createAction") {
      doCreateAction(op.actor, op);
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
          : op.kind === "setColor"
            ? pendingOps.setColor(world, clock, id, op.color)
            : op.kind === "setGroup"
              ? pendingOps.setGroup(world, clock, id, op.group)
              : op.kind === "delete"
                ? pendingOps.deleteEntity(world, clock, id)
                : op.kind === "restore"
                  ? pendingOps.restoreEntity(world, clock, id)
                  : op.kind === "renameGroup"
                    ? pendingOps.renameGroup(world, clock, id, op.title)
                    : op.kind === "assign"
                      ? pendingOps.assign(world, clock, id, op.guestId)
                      : op.kind === "setDone"
                        ? pendingOps.setDone(world, clock, id, op.done)
                        : setField(world, clock, { entity: id, field: op.field }, op.value);

    clocks.set(op.actor, result.clock);
    world = merge(world, result.delta);
    deltas.push(result.delta);
    dots.push(result.dot);
  }

  return { actors, deltas, dots, createdIds, merged: world };
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

export interface CreateGroupParams {
  readonly column: Column;
  readonly frac: string;
  readonly title: string;
}

/**
 * Как `createForkScenario`, но общий предок — группа (REQ-012, REQ-013).
 * Прогрев идёт через `deleted` — поле, не участвующее ни в renameGroup
 * (`title`), ни в moveGroup (`place`), поэтому не создаёт побочного
 * конфликта в поле под тестом.
 */
export function createGroupForkScenario(
  creator: ActorId,
  branchActors: readonly [ActorId, ActorId],
  params: CreateGroupParams,
  warmups: readonly [number, number] = [0, 0],
): ForkScenario {
  const creatorClock = newClock(creator);
  const created = pendingOps.createGroup(empty(), creatorClock, params);
  const base = created.delta;
  const createdEntity = [...base.created.values()][0];
  if (!createdEntity) throw new Error("createGroupForkScenario: createGroup не создал сущность");
  const id = createdEntity.id;

  const branch = (actor: ActorId, warmupCount: number): ForkBranch => {
    let clock = newClock(actor);
    let state = merge(empty(), base);
    for (let i = 0; i < warmupCount; i++) {
      const r = setField(state, clock, { entity: id, field: "deleted" }, i % 2 === 0);
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

export interface CreateActionParams {
  readonly text: string;
}

/**
 * Как `createForkScenario`, но общий предок — action item (REQ-018).
 * Прогрев — через `done`, не участвующее в `assignee`.
 */
export function createActionForkScenario(
  creator: ActorId,
  branchActors: readonly [ActorId, ActorId],
  params: CreateActionParams,
  warmups: readonly [number, number] = [0, 0],
): ForkScenario {
  const creatorClock = newClock(creator);
  const created = pendingOps.createAction(empty(), creatorClock, params);
  const base = created.delta;
  const createdEntity = [...base.created.values()][0];
  if (!createdEntity) throw new Error("createActionForkScenario: createAction не создал сущность");
  const id = createdEntity.id;

  const branch = (actor: ActorId, warmupCount: number): ForkBranch => {
    let clock = newClock(actor);
    let state = merge(empty(), base);
    for (let i = 0; i < warmupCount; i++) {
      const r = setField(state, clock, { entity: id, field: "done" }, i % 2 === 0);
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
// Голоса (REQ-015) — отдельный путь, не через OpDescriptor/runScenario:
// `vote`/`unvote` пишут в V⁺/V⁻ (state.votes/state.unvotes), а не в E, и
// `unvote` не берёт свой dot (см. комментарий у PendingT2Ops.unvote выше и
// docs/spec/consistency-model.md § 3.1) — это не укладывается в общий
// "pick id → write(field, value)" цикл runScenario.
// ---------------------------------------------------------------------------

export interface VoteOp {
  readonly kind: "vote";
  readonly actor: ActorId;
  readonly user: UserId;
  readonly targetPick: number;
}

export interface UnvoteOp {
  readonly kind: "unvote";
  /** Индекс в списке уже поданных голосов сценария (по модулю длины на момент исполнения). */
  readonly votePick: number;
}

export type VoteOpDescriptor = VoteOp | UnvoteOp;

export function voteOpsArb(
  actors: readonly ActorId[],
  users: readonly UserId[],
  targetCount: number,
  opts: { minLength?: number; maxLength?: number } = {},
): fc.Arbitrary<VoteOpDescriptor[]> {
  const actorArb = fc.constantFrom(...actors);
  const userArb = fc.constantFrom(...users);
  const targetPickArb = fc.nat({ max: Math.max(targetCount - 1, 0) });

  const voteArb: fc.Arbitrary<VoteOp> = fc.record({
    kind: fc.constant("vote" as const),
    actor: actorArb,
    user: userArb,
    targetPick: targetPickArb,
  });

  const unvoteArb: fc.Arbitrary<UnvoteOp> = fc.record({
    kind: fc.constant("unvote" as const),
    votePick: fc.nat(),
  });

  return fc.array(fc.oneof(voteArb, unvoteArb), {
    minLength: opts.minLength ?? 1,
    maxLength: opts.maxLength ?? 12,
  });
}

export interface VoteScenarioResult {
  /** Дельта каждой выполненной операции (vote и unvote), в порядке выполнения. */
  readonly deltas: readonly Delta[];
  /** Dot каждого поданного голоса, в порядке подачи (для I2/no-loss — unvote своего dot не имеет). */
  readonly voteDots: readonly Dot[];
  /** Итоговое состояние. */
  readonly merged: State;
}

export function runVoteScenario(
  actors: readonly ActorId[],
  targetIds: readonly EntityId[],
  ops: readonly VoteOpDescriptor[],
): VoteScenarioResult {
  if (actors.length === 0) throw new Error("runVoteScenario: нужен хотя бы один актор");
  if (targetIds.length === 0) throw new Error("runVoteScenario: нужна хотя бы одна цель");

  const clocks = new Map<ActorId, Clock>(actors.map((a) => [a, newClock(a)]));
  let world: State = empty();
  const deltas: Delta[] = [];
  const voteDots: Dot[] = [];
  const voteTargets: EntityId[] = [];

  for (const op of ops) {
    if (op.kind === "vote") {
      const clock = clocks.get(op.actor);
      if (!clock) throw new Error(`runVoteScenario: неизвестный актор ${op.actor}`);
      const targetIndex =
        ((op.targetPick % targetIds.length) + targetIds.length) % targetIds.length;
      const target = targetIds[targetIndex];
      if (target === undefined) throw new Error("runVoteScenario: индекс цели вне диапазона");
      const result = pendingOps.vote(world, clock, target, op.user);
      clocks.set(op.actor, result.clock);
      world = merge(world, result.delta);
      deltas.push(result.delta);
      voteDots.push(result.dot);
      voteTargets.push(target);
      continue;
    }
    // unvote: без поданных голосов отзывать нечего — операция пропускается,
    // сценарий остаётся причинно корректным (аналогично FALLBACK_CREATE выше).
    if (voteDots.length === 0) continue;
    const voteIndex = ((op.votePick % voteDots.length) + voteDots.length) % voteDots.length;
    const voteDot = voteDots[voteIndex];
    const target = voteTargets[voteIndex];
    if (voteDot === undefined || target === undefined) {
      throw new Error("runVoteScenario: индекс голоса вне диапазона");
    }
    const delta = pendingOps.unvote(world, voteDot, target);
    world = merge(world, delta);
    deltas.push(delta);
  }

  return { deltas, voteDots, merged: world };
}

export function voteScenarioArb(
  tag: string,
  opts: {
    minOps?: number;
    maxOps?: number;
    minActors?: number;
    maxActors?: number;
    minUsers?: number;
    maxUsers?: number;
    targets?: number;
  } = {},
): fc.Arbitrary<VoteScenarioResult> {
  const targetCount = opts.targets ?? 2;
  const targetIds = Array.from({ length: targetCount }, (_, i) => `${tag}-target-${i}`);
  return fc
    .tuple(
      actorPoolArb(`${tag}-actor`, opts.minActors ?? 1, opts.maxActors ?? 3),
      actorPoolArb(`${tag}-user`, opts.minUsers ?? 1, opts.maxUsers ?? 3),
    )
    .chain(([actors, users]) =>
      voteOpsArb(actors, users, targetCount, {
        minLength: opts.minOps ?? 1,
        maxLength: opts.maxOps ?? 12,
      }).map((ops) => runVoteScenario(actors, targetIds, ops)),
    );
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

function dotEquals(a: Dot, b: Dot): boolean {
  return a.actor === b.actor && a.counter === b.counter;
}

/**
 * I2 (REQ-025): dot операции остаётся физически в состоянии — в `created`
 * (создание сущности), в `entries` (запись поля) или в `votes` (голос).
 * Не проверяет видимость/активность — только физическое присутствие.
 */
export function dotPresent(state: State, dot: Dot): boolean {
  for (const created of state.created.values()) {
    if (created.id === dotKey(dot)) return true;
  }
  for (const entry of state.entries.values()) {
    if (dotEquals(entry.dot, dot)) return true;
  }
  for (const vote of state.votes.values()) {
    if (dotEquals(vote.dot, dot)) return true;
  }
  return false;
}

export function findVoteByDot(state: State, dot: Dot): Vote | undefined {
  for (const vote of state.votes.values()) {
    if (dotEquals(vote.dot, dot)) return vote;
  }
  return undefined;
}

export function isUnvoted(state: State, voteDot: Dot, target: EntityId): boolean {
  for (const unvote of state.unvotes.values()) {
    if (dotEquals(unvote.dot, voteDot) && unvote.target === target) return true;
  }
  return false;
}
