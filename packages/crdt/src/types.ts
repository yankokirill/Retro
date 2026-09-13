// Типы модели согласованности доски — docs/spec/consistency-model.md § 1–2.

export type ActorId = string;
export type UserId = string;

/** § 1.2. Уникальный идентификатор операции: «кто и какая по счёту». */
export interface Dot {
  readonly actor: ActorId;
  readonly counter: number;
}

/** § 1.3. Метка Lamport; полный порядок: сначала lamport, затем actor. */
export interface Stamp {
  readonly lamport: number;
  readonly actor: ActorId;
}

export type Kind = "sticker" | "group" | "action";

/** Идентификатор сущности = dotKey(dot операции её создания). */
export type EntityId = string;

export type Column = "start" | "stop" | "continue";
export type Color = "yellow" | "green" | "blue" | "pink" | "purple";

export interface Place {
  readonly column: Column;
  readonly frac: string;
}

export type Field =
  | "text"
  | "color"
  | "place"
  | "group"
  | "deleted"
  | "title"
  | "assignee"
  | "done";

/** `null` — «нет группы» / «нет ответственного». */
export type Value = string | boolean | Place | null;

/** Ячейка: конкретное поле конкретной сущности. */
export interface Key {
  readonly entity: EntityId;
  readonly field: Field;
}

export interface Created {
  readonly id: EntityId;
  readonly kind: Kind;
}

export interface Entry {
  readonly key: Key;
  readonly dot: Dot;
  readonly stamp: Stamp;
  readonly value: Value;
}

export interface Supersede {
  readonly key: Key;
  readonly dot: Dot;
}

export interface Vote {
  readonly dot: Dot;
  /** На проводе и в состоянии — обезличенный токен голосующего (docs/spec/protocol.md § 2). */
  readonly user: UserId;
  readonly target: EntityId;
}

export interface Unvote {
  readonly dot: Dot;
  readonly target: EntityId;
}

/**
 * § 2: X = (C, E, S, V⁺, V⁻). Каждая компонента — множество; ключ Map —
 * каноническая строка идентичности элемента, значение — сам элемент.
 */
export interface State {
  readonly created: ReadonlyMap<string, Created>;
  readonly entries: ReadonlyMap<string, Entry>;
  readonly supersedes: ReadonlyMap<string, Supersede>;
  readonly votes: ReadonlyMap<string, Vote>;
  readonly unvotes: ReadonlyMap<string, Unvote>;
}

/** Дельта — состояние того же типа, обычно маленькое (§ 2). */
export type Delta = State;

/** Проводное представление состояния/дельты: массивы вместо множеств, порядок не значим. */
export interface WireDelta {
  readonly created: readonly Created[];
  readonly entries: readonly Entry[];
  readonly supersedes: readonly Supersede[];
  readonly votes: readonly Vote[];
  readonly unvotes: readonly Unvote[];
}

/** Логические часы реплики (§ 1.2–1.3). */
export interface Clock {
  readonly actor: ActorId;
  /** Счётчик последней выданной операции; у новой реплики 0. */
  readonly counter: number;
  /** Последнее значение Lamport, известное реплике; у новой реплики 0. */
  readonly lamport: number;
}

/** Результат конструктора операции. */
export interface OpResult {
  readonly delta: Delta;
  readonly clock: Clock;
  readonly dot: Dot;
}
