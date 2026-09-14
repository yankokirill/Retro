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

/**
 * § 4. Материализованный стикер. `text`/`conflict` — R2 (vals_(id,text),
 * |text| > 1); `color` — R2 (win_(id,color).v); `votes` — R6
 * (|{v ∈ active(X) | v.target = id}|; голоса за удалённый стикер в счётчик
 * не входят, т.к. удалённый стикер сюда не попадает).
 */
export interface CardView {
  readonly id: EntityId;
  readonly text: readonly string[];
  readonly conflict: boolean;
  readonly color: Color;
  readonly votes: number;
}

/**
 * § 4. Материализованная группа. `title`/`conflict` — R2, как у `text`
 * стикера. `cards` — стикеры этой группы (R3: g* = win_(id,group).v этой
 * группы), в порядке R5; их собственное поле `place` не используется (R4).
 * `votes` — R6, как у `CardView`: группу можно голосовать наравне со
 * стикером (REQ-015 кр. 1; ADR-0006 — исходная § 4 не включала это поле,
 * хотя R6 определена для произвольного `id`, а не только стикера).
 */
export interface GroupView {
  readonly id: EntityId;
  readonly title: readonly string[];
  readonly conflict: boolean;
  readonly cards: readonly CardView[];
  readonly votes: number;
}

/** Элемент колонки — стикер вне группы или группа целиком (R4). */
export type Item = CardView | GroupView;

/**
 * Материализованный action item. § 4 не выписывает эту форму отдельно —
 * она выведена из таблицы полей `action` (§ 1.4): `text` — «все варианты»
 * (как у CardView/GroupView), `assignee`/`done` — победитель по метке.
 */
export interface ActionView {
  readonly id: EntityId;
  readonly text: readonly string[];
  readonly conflict: boolean;
  readonly assignee: UserId | null;
  readonly done: boolean;
}

/**
 * § 4. `View = (columns, trash, actions)`.
 * `trash` — существующие удалённые стикеры и группы (R1), отсортированные
 * по `id` (R7). Action items в `trash` не попадают: у `action` нет поля
 * `place`, R1–R4 к ним не применяются — удалённый action item просто не
 * входит в `actions` (REQ-019: без корзины, это сознательная асимметрия,
 * а не пропуск).
 */
export interface View {
  readonly columns: ReadonlyMap<Column, readonly Item[]>;
  readonly trash: readonly EntityId[];
  /** Отсортированы по `id` (R7). */
  readonly actions: readonly ActionView[];
}
