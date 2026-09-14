// T-008 — журнал операций и снапшоты (REQ-023 кр.3, REQ-027; § 6
// `docs/spec/consistency-model.md`). Функции берут `db` параметром, как
// `boards/service.ts` — тестируемо без переменных окружения.
import type { Dot, State, WireDelta } from "@retro/crdt";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";

export type Db = NodePgDatabase<typeof schema>;

export interface AppendOpParams {
  readonly boardId: string;
  /**
   * `null` — только для `unvote`: `Unvote.dot` в CRDT-модели (T-002) — dot
   * **отзываемого голоса**, не свежий dot самой операции отзыва (`unvote`
   * не тикает часы), поэтому у него нет собственной пары `(actor, counter)`
   * для идемпотентности на уровне журнала (см. JSDoc `ops` в `db/schema.ts`).
   * Для всех остальных операций (create/write/vote) — их собственный dot.
   */
  readonly dot: Dot | null;
  /** `null` — у `vote`/`unvote` метки нет (§ 3.1, 2P-set); для остальных операций — метка её записи. */
  readonly lamport: number | null;
  /** Ровно то, что несла одна операция (§ 3 `protocol.md`) — уже в проводном формате. */
  readonly delta: WireDelta;
}

export interface AppendOpResult {
  readonly seq: number;
}

/**
 * REQ-023 (кр. 3). Для `dot !== null` — идемпотентно по
 * `(boardId, dot.actor, dot.counter)`: повторно отправленная операция (тот
 * же dot — переподключение, дубль доставки) не создаёт вторую строку,
 * возвращает уже присвоенный `seq`. Для `dot === null` (только `unvote`,
 * см. JSDoc `AppendOpParams.dot`) дедупликации на уровне строк журнала нет
 * — каждый вызов добавляет строку; итоговое материализованное состояние
 * при этом не меняется от повтора (merge идемпотентен, I2.5), только объём
 * журнала может немного вырасти — полная защита от дублей unvote на уровне
 * протокола остаётся за V1 в T-010.
 */
export async function appendOp(_db: Db, _params: AppendOpParams): Promise<AppendOpResult> {
  throw new Error("appendOp: not implemented");
}

export interface OpRow {
  readonly seq: number;
  readonly delta: WireDelta;
}

/** Операции доски со `seq > sinceSeq`, по возрастанию `seq` (переподключение, protocol.md § 6). */
export async function opsSince(_db: Db, _boardId: string, _sinceSeq: number): Promise<OpRow[]> {
  throw new Error("opsSince: not implemented");
}

export interface ReplayResult {
  readonly state: State;
  readonly uptoSeq: number;
}

/** X_S(n) — replay всего журнала доски с начала (§ 6). `uptoSeq` — seq последней применённой операции (0, если журнал пуст). */
export async function replay(_db: Db, _boardId: string): Promise<ReplayResult> {
  throw new Error("replay: not implemented");
}

/**
 * REQ-027. `compact(X_S(m)) ⊔ δ_{m+1..n}` — последний снапшот (или ⊥, если
 * его нет) плюс хвост журнала после него. Инвариант I5 (§ 8): для любого
 * состояния журнала `materialize` этого результата равен `materialize`
 * полного `replay`.
 */
export async function replayFromSnapshot(_db: Db, _boardId: string): Promise<ReplayResult> {
  throw new Error("replayFromSnapshot: not implemented");
}

export interface SnapshotResult {
  readonly uptoSeq: number;
  readonly state: State;
}

/** `null` — снапшотов для доски ещё нет. Среди нескольких строк — с максимальным `uptoSeq`. */
export async function loadLatestSnapshot(
  _db: Db,
  _boardId: string,
): Promise<SnapshotResult | null> {
  throw new Error("loadLatestSnapshot: not implemented");
}

/** Сохраняет `compact(state)` как снапшот на `uptoSeq`. Когда именно снимать снапшот — вне T-008 (эксплуатационная политика, не инвариант). */
export async function saveSnapshot(
  _db: Db,
  _boardId: string,
  _uptoSeq: number,
  _state: State,
): Promise<void> {
  throw new Error("saveSnapshot: not implemented");
}
