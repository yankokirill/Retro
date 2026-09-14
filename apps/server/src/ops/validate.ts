// T-010 — правила приёма операции сервером: V1 (свежий dot), V3 (цель
// существует), V4 (перекрытие обосновано), V5 (метка) — docs/spec/
// consistency-model.md § 7, REQ-024 кр. 2. V2 (форма) уже обеспечена
// zod-схемой `clientDeltaSchema` (packages/protocol) на входе в
// `ws/gateway.ts` — сюда попадает только уже валидная по форме дельта, эту
// проверку заново не делаем. V6 (права/фазы) и V7 (голоса) — T-011, T-012,
// тоже не здесь.

import type { Dot, EntityId, Field, Kind, State, WireDelta } from "@retro/crdt";
import { compareStamps, entityKind, entryAt, supersedeRecorded } from "@retro/crdt";
import type { RejectReason } from "@retro/protocol";
import { operationDot } from "@retro/protocol";
import type { ActorClock } from "./log.js";

/** § 1.4 `consistency-model.md`: какие поля есть у какого вида сущности — V3 «правка нужного вида». */
const FIELDS_BY_KIND: Record<Kind, ReadonlySet<Field>> = {
  sticker: new Set(["text", "color", "place", "group", "deleted"]),
  group: new Set(["title", "place", "deleted"]),
  action: new Set(["text", "assignee", "done", "deleted"]),
};

/**
 * V5, «инфляция Lamport-часов» (CLAUDE.md § 5, модель угроз): насколько
 * метка может опережать максимум по доске, чтобы не считаться подозрительной.
 * Точного числа в спецификации нет (только «K ≥ максимального размера
 * очереди клиента», `consistency-model.md` § 7) — взято с запасом под
 * офлайн-очередь REQ-023 (сотни операций, не миллионы). Не финальное
 * значение продукта, при необходимости меняется без ADR.
 */
export const MAX_LAMPORT_AHEAD = 1000;

export interface ValidateOpParams {
  /** X_S — текущее состояние доски: `replay`/`replayFromSnapshot` из `ops/log.ts`. */
  readonly state: State;
  /**
   * actorId, заявленный этим WS-соединением в `hello` (`ws/gateway.ts`).
   * V1 «owner(a) = u»: dot операции обязан принадлежать этому актору — иначе
   * `stale_dot` (T-009 оставлял эту проверку открытым вопросом для T-010,
   * см. `docs/spec/protocol.md` § 5).
   */
  readonly connectionActorId: string;
  /** Один клиентский `op` — уже прошёл `clientDeltaSchema` (ровно одна операция). */
  readonly delta: WireDelta;
  /**
   * `null` — только для `unvote`. У `unvote` нет собственного свежего dot
   * (его `dot` в проводном формате — dot **отзываемого голоса**, T-002,
   * `unvote` не тикает часы) и нет метки (2P-set, § 3.1) — поэтому V1
   * (свежесть по счётчику) и V5 (метка) к нему не применяются вовсе. Это и
   * есть решение открытого вопроса, оставленного T-008/T-010 (см.
   * `docs/tasks.md`): корректность unvote (голос существует, принадлежит u,
   * ещё не отозван) — V7, T-012, не эта функция. Для всех остальных
   * операций (create/write/vote — у vote тоже есть свежий dot, хоть и без
   * метки) — обязателен.
   */
  readonly actorClock: ActorClock | null;
}

export type ValidateOpResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RejectReason; readonly message: string };

/**
 * Ровно один из V1/V3/V4/V5 нарушений даёт `reject` с соответствующей
 * причиной (`docs/spec/protocol.md` § 5); все правила выполнены — `ok: true`.
 * Не имеет побочных эффектов и не обращается к БД/сети — тестируется
 * напрямую на сконструированных `State`/`WireDelta` без Testcontainers.
 */
export function validateOp(params: ValidateOpParams): ValidateOpResult {
  throw new Error("validateOp: not implemented");
}
