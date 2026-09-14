// T-008 — журнал операций и снапшоты (REQ-023 кр.3, REQ-027; § 6
// `docs/spec/consistency-model.md`). Функции берут `db` параметром, как
// `boards/service.ts` — тестируемо без переменных окружения.

import type { Dot, State, WireDelta } from "@retro/crdt";
import { compact as compactState, empty, fromWire, merge, toWire } from "@retro/crdt";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { ops, snapshots } from "../db/schema.js";

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
export async function appendOp(db: Db, params: AppendOpParams): Promise<AppendOpResult> {
  const [inserted] = await db
    .insert(ops)
    .values({
      boardId: params.boardId,
      actor: params.dot?.actor ?? null,
      counter: params.dot?.counter ?? null,
      lamport: params.lamport,
      delta: params.delta,
    })
    .onConflictDoNothing({ target: [ops.boardId, ops.actor, ops.counter] })
    .returning({ seq: ops.seq });
  if (inserted) return { seq: inserted.seq };

  // NULL никогда не конфликтует в UNIQUE (Postgres) — конфликт возможен только
  // когда dot задан и (actor, counter) уже встречались для этой доски.
  if (!params.dot) throw new Error("appendOp: unexpected conflict for dot === null");
  const [existing] = await db
    .select({ seq: ops.seq })
    .from(ops)
    .where(
      and(
        eq(ops.boardId, params.boardId),
        eq(ops.actor, params.dot.actor),
        eq(ops.counter, params.dot.counter),
      ),
    );
  if (!existing) throw new Error("appendOp: row missing after conflict");
  return { seq: existing.seq };
}

export interface OpRow {
  readonly seq: number;
  readonly delta: WireDelta;
}

/** Операции доски со `seq > sinceSeq`, по возрастанию `seq` (переподключение, protocol.md § 6). */
export async function opsSince(db: Db, boardId: string, sinceSeq: number): Promise<OpRow[]> {
  return db
    .select({ seq: ops.seq, delta: ops.delta })
    .from(ops)
    .where(and(eq(ops.boardId, boardId), gt(ops.seq, sinceSeq)))
    .orderBy(asc(ops.seq));
}

export interface ReplayResult {
  readonly state: State;
  readonly uptoSeq: number;
}

/** X_S(n) — replay всего журнала доски с начала (§ 6). `uptoSeq` — seq последней применённой операции (0, если журнал пуст). */
export async function replay(db: Db, boardId: string): Promise<ReplayResult> {
  const rows = await opsSince(db, boardId, 0);
  let state: State = empty();
  let uptoSeq = 0;
  for (const row of rows) {
    state = merge(state, fromWire(row.delta));
    uptoSeq = row.seq;
  }
  return { state, uptoSeq };
}

/**
 * REQ-027. `compact(X_S(m)) ⊔ δ_{m+1..n}` — последний снапшот (или ⊥, если
 * его нет) плюс хвост журнала после него. Инвариант I5 (§ 8): для любого
 * состояния журнала `materialize` этого результата равен `materialize`
 * полного `replay`.
 */
export async function replayFromSnapshot(db: Db, boardId: string): Promise<ReplayResult> {
  const snapshot = await loadLatestSnapshot(db, boardId);
  const tail = await opsSince(db, boardId, snapshot?.uptoSeq ?? 0);

  let state = snapshot?.state ?? empty();
  let uptoSeq = snapshot?.uptoSeq ?? 0;
  for (const row of tail) {
    state = merge(state, fromWire(row.delta));
    uptoSeq = row.seq;
  }
  return { state, uptoSeq };
}

export interface SnapshotResult {
  readonly uptoSeq: number;
  readonly state: State;
}

/** `null` — снапшотов для доски ещё нет. Среди нескольких строк — с максимальным `uptoSeq`. */
export async function loadLatestSnapshot(db: Db, boardId: string): Promise<SnapshotResult | null> {
  const [row] = await db
    .select({ uptoSeq: snapshots.uptoSeq, state: snapshots.state })
    .from(snapshots)
    .where(eq(snapshots.boardId, boardId))
    .orderBy(desc(snapshots.uptoSeq))
    .limit(1);
  if (!row) return null;
  return { uptoSeq: row.uptoSeq, state: fromWire(row.state) };
}

/** Сохраняет `compact(state)` как снапшот на `uptoSeq`. Когда именно снимать снапшот — вне T-008 (эксплуатационная политика, не инвариант). */
export async function saveSnapshot(
  db: Db,
  boardId: string,
  uptoSeq: number,
  state: State,
): Promise<void> {
  await db.insert(snapshots).values({ boardId, uptoSeq, state: toWire(compactState(state)) });
}

export interface WelcomeData {
  readonly snapshot: { readonly upToSeq: number; readonly state: WireDelta } | null;
  readonly ops: OpRow[];
}

/**
 * T-009, `welcome` при подключении (protocol.md § 6 «Подключение»): если
 * `lastSeq` не задан или старше последнего снапшота — снапшот целиком плюс
 * хвост журнала после него (`snapshot` непустой, если снапшот вообще
 * существует; иначе `snapshot: null`, а `ops` — весь журнал с начала);
 * иначе (клиент уже видел снапшот или новее) — `snapshot: null`, только
 * операции с `seq > lastSeq`. Снапшоты в T-009 не создаются автоматически
 * (`saveSnapshot` вызывается вручную/из будущей эксплуатационной политики) —
 * в первой версии `welcome` почти всегда шлёт весь журнал с начала.
 */
export async function welcomeData(
  db: Db,
  boardId: string,
  lastSeq: number | null,
): Promise<WelcomeData> {
  const snapshot = await loadLatestSnapshot(db, boardId);
  const baseline = snapshot?.uptoSeq ?? 0;
  const needsSnapshot = lastSeq === null || lastSeq < baseline;
  const ops = await opsSince(db, boardId, needsSnapshot ? baseline : lastSeq);
  return {
    snapshot:
      needsSnapshot && snapshot
        ? { upToSeq: snapshot.uptoSeq, state: toWire(snapshot.state) }
        : null,
    ops,
  };
}
