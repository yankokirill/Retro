// S1–S11 — docs/spec/simulator.md § 8, docs/design/T-005-simulator.md § 5.5.
// Каждая функция — чистая проверка над миром/наблюдением одного шага,
// возвращает `Violation | null`. Вызывающий (apply.ts/drain.ts/run.ts)
// решает, в какой момент какую функцию вызвать (таблица «Когда» § 8
// спецификации); здесь фиксируются только сигнатуры и точный смысл каждой
// проверки, без предположений о внутренностях `World`, кроме его публичной
// формы (world.ts).

import type { Dot, EntityId } from "@retro/crdt";
import type { RejectReason } from "@retro/protocol";
import type { OpRow } from "@retro/server-core";
import type { World } from "./world.js";
import type { Violation } from "./violation.js";
import type { WellFormedState } from "./well-formed.js";

// ---------------------------------------------------------------------------
// S1 — обёртка над well-formed.ts с проставленным ID свойства.
// ---------------------------------------------------------------------------

export function checkWellFormedIncremental(
  state: WellFormedState,
  row: OpRow,
  step: number,
): Violation | null {
  throw new Error("checkWellFormedIncremental: not implemented");
}

/** Полный проход по журналу с нуля в контрольной точке — сверяется с инкрементальным результатом (§ 6 проекта). */
export function checkWellFormedFull(rows: readonly OpRow[], step: number): Violation | null {
  throw new Error("checkWellFormedFull: not implemented");
}

// ---------------------------------------------------------------------------
// S2 — I6: у каждого voterToken не больше voteLimit активных голосов в X_S.
// Вызывается после каждой принятой операции.
// ---------------------------------------------------------------------------

export function checkVoteLimit(world: World, step: number): Violation | null {
  throw new Error("checkVoteLimit: not implemented");
}

// ---------------------------------------------------------------------------
// S3 — при каждой доставке `ack` клиенту: в журнале есть строка с этим `seq`,
// содержащая операцию с этим dot (для unvote — пара (dot, target)); в
// журнале нет двух строк с одинаковым (actor, counter).
// ---------------------------------------------------------------------------

export interface AckObservation {
  readonly seq: number;
  readonly dot: Dot;
  readonly kind: "op" | "unvote";
  readonly target?: EntityId;
}

export function checkAck(world: World, ack: AckObservation, step: number): Violation | null {
  throw new Error("checkAck: not implemented");
}

// ---------------------------------------------------------------------------
// S4 — в покое: для каждого клиента u, equals(compact(X_c(u)), compact(proj_u(X_S)))
// (ВС-6, docs/spec/simulator.md § 13).
// ---------------------------------------------------------------------------

export function checkClientsMatchOracle(world: World, step: number): Violation | null {
  throw new Error("checkClientsMatchOracle: not implemented");
}

// ---------------------------------------------------------------------------
// S5 — в покое: клиенты с одинаковой видимостью показывают один materialize;
// после reveal — все клиенты равны materialize(X_S).
// ---------------------------------------------------------------------------

export function checkScreensAgree(world: World, step: number): Violation | null {
  throw new Error("checkScreensAgree: not implemented");
}

// ---------------------------------------------------------------------------
// S6 — в покое: каждая операция, на которую хоть один клиент получил ack,
// присутствует в X_S.
// ---------------------------------------------------------------------------

export function checkAckedOpsPersist(world: World, step: number): Violation | null {
  throw new Error("checkAckedOpsPersist: not implemented");
}

// ---------------------------------------------------------------------------
// S7 — при каждой доставке reject/error и в покое: отклонённая операция
// отсутствует в журнале; причина ограничена множеством, зависящим от того,
// сопоставленный это отказ (dot ещё в P клиента) или устаревший (dot уже
// убран каскадом ADR-0010) — ВС-7, docs/spec/simulator.md § 13.
// ---------------------------------------------------------------------------

export interface RejectObservation {
  readonly kind: "reject";
  readonly dot: Dot;
  readonly reason: RejectReason | "irreversible_phase";
  /** Оставался ли этот dot в P клиента непосредственно перед обработкой ответа. */
  readonly wasPending: boolean;
  /** Добавила ли обработка этого сообщения сервером хоть одну строку в журнал (должно быть false). */
  readonly logGrew: boolean;
}

export interface ErrorObservation {
  readonly kind: "error";
  /** true — этот `error` пришёл сразу после E9 (единственный законный случай, § 8 таблица S7). */
  readonly afterStoreFault: boolean;
}

export function checkReject(
  world: World,
  observation: RejectObservation | ErrorObservation,
  step: number,
): Violation | null {
  throw new Error("checkReject: not implemented");
}

/** В покое: у каждого клиента confirmed/pending не содержат dot из его же rejections (§ 8 таблица S7, «в покое»). */
export function checkNoRejectedResidue(world: World, step: number): Violation | null {
  throw new Error("checkNoRejectedResidue: not implemented");
}

// ---------------------------------------------------------------------------
// S8 — в покое, для каждого снапшота E8: materialize(snapshot ⊔ хвост) и
// materialize(currentState) равны materialize(X_S).
// ---------------------------------------------------------------------------

export interface SnapshotObservation {
  readonly uptoSeq: number;
}

export function checkSnapshotConsistency(
  world: World,
  snapshots: readonly SnapshotObservation[],
  step: number,
): Violation | null {
  throw new Error("checkSnapshotConsistency: not implemented");
}

// ---------------------------------------------------------------------------
// S10 — пока фаза collect в момент отправки сервером: ни одно сообщение
// гостю u не содержит элементов, принадлежащих стикерам других гостей.
// ---------------------------------------------------------------------------

export interface OutgoingObservation {
  readonly raw: string;
  readonly recipientGuestId: string;
  /** Фаза на шаге, когда СЕРВЕР отправил это сообщение (не когда оно доставлено), § 13 п.4 перепроверки 2026-09-16. */
  readonly phaseAtSend: string;
}

export function checkNoAuthorLeak(
  world: World,
  observation: OutgoingObservation,
  step: number,
): Violation | null {
  throw new Error("checkNoAuthorLeak: not implemented");
}

// ---------------------------------------------------------------------------
// S11 — каждое сообщение проходит соответствующую схему; «клиент → сервер»
// дополнительно ограничено 16 KiB.
// ---------------------------------------------------------------------------

export function checkMessageSchema(
  direction: "toServer" | "toClient",
  raw: string,
  step: number,
): Violation | null {
  throw new Error("checkMessageSchema: not implemented");
}
