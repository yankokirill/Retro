// T-010 — правила приёма операции сервером: V1 (свежий dot), V3 (цель
// существует), V4 (перекрытие обосновано), V5 (метка) — docs/spec/
// consistency-model.md § 7, REQ-024 кр. 2. V2 (форма) уже обеспечена
// zod-схемой `clientDeltaSchema` (packages/protocol) на входе (сервер:
// handlers/op.ts; симулятор: генератор через ядро клиента, SIM-06) — сюда
// попадает только уже валидная по форме дельта, эту проверку заново не
// делаем. V6 (права/фазы) и V7 (голоса) — T-011, T-012, тоже не здесь.
//
// ADR-0008: V1 (весь целиком, включая привязку к actorId соединения) НЕ
// применяется к `unvote` — его `dot` в проводном формате это dot ОТЗЫВАЕМОГО
// голоса (чужая, более ранняя операция `vote`), не собственный dot операции
// отзыва. Принадлежность голоса пользователю — V7 (`rules/votes.ts`
// `checkVoteOwnership`, сравнивает по `voterToken`, не по `actorId`).
//
// T-024: переехала из apps/server/src/ops/validate.ts (реэкспорт там
// остаётся) без изменения поведения; `ActorClock` теперь из `../store.js`
// (порт `BoardStore`), не из `apps/server` `ops/log.ts`.

import type { EntityId, Field, Kind, State, WireDelta } from "@retro/crdt";
import { entityKind, entryAt, supersedeRecorded } from "@retro/crdt";
import type { RejectReason } from "@retro/protocol";
import { operationDot } from "@retro/protocol";
import type { ActorClock } from "../store.js";

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
  /** X_S — текущее состояние доски: `store.currentState(boardId)`. */
  readonly state: State;
  /**
   * actorId, заявленный этим соединением в `hello`. V1 «owner(a) = u»: dot
   * операции обязан принадлежать этому актору — иначе `stale_dot`.
   * Применяется к `create`/`write`/`vote`; НЕ применяется к `unvote`
   * (ADR-0008, см. шапку файла) — его `dot` не собственный.
   */
  readonly connectionActorId: string;
  /** Один клиентский `op` — уже прошёл `clientDeltaSchema` (ровно одна операция). */
  readonly delta: WireDelta;
  /**
   * `null` — только для `unvote`. У `unvote` нет собственного свежего dot
   * (его `dot` в проводном формате — dot **отзываемого голоса**, T-002,
   * `unvote` не тикает часы) и нет метки (2P-set, § 3.1) — поэтому V1
   * целиком (и свежесть по счётчику, и привязка к актору соединения,
   * ADR-0008) и V5 (метка) к нему не применяются вовсе. Корректность unvote
   * (голос существует, принадлежит u, ещё не отозван) — V7, T-012, не эта
   * функция. Для всех остальных операций (create/write/vote — у vote тоже
   * есть свежий dot, хоть и без метки) — обязателен.
   */
  readonly actorClock: ActorClock | null;
}

export type ValidateOpResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RejectReason; readonly message: string };

function reject(reason: RejectReason, message: string): ValidateOpResult {
  return { ok: false, reason, message };
}

/**
 * Ровно один из V1/V3/V4/V5 нарушений даёт `reject` с соответствующей
 * причиной (`docs/spec/protocol.md` § 5); все правила выполнены — `ok: true`.
 * Не имеет побочных эффектов и не обращается к БД/сети — тестируется
 * напрямую на сконструированных `State`/`WireDelta` без Testcontainers.
 */
export function validateOp(params: ValidateOpParams): ValidateOpResult {
  const { state, connectionActorId, delta, actorClock } = params;
  const dot = operationDot(delta);
  const isUnvote = delta.unvotes.length > 0;
  const isVote = delta.votes.length > 0;
  const isCreate = delta.created.length > 0;

  // V1 — owner(a) = u, свежесть по счётчику. Не применяется к unvote вовсе
  // (ADR-0008): его dot — dot ОТЗЫВАЕМОГО голоса (чужая, более ранняя
  // операция vote), не собственный dot операции отзыва — актор в общем
  // случае не совпадает с актором этого соединения (другая вкладка того же
  // guestId, или та же вкладка после перезагрузки). Принадлежность голоса
  // этому пользователю — V7 (checkVoteOwnership), не V1.
  if (!isUnvote) {
    if (dot.actor !== connectionActorId) {
      return reject(
        "stale_dot",
        `dot actor ${dot.actor} does not match connection actor ${connectionActorId}`,
      );
    }
    if (!actorClock) throw new Error("validateOp: actorClock required for non-unvote operations");
    if (dot.counter <= actorClock.lastCounter) {
      return reject(
        "stale_dot",
        `counter ${dot.counter} is not fresher than last accepted ${actorClock.lastCounter}`,
      );
    }
  }

  // V3 — цель существует, нужного вида.
  if (isUnvote) {
    const [unvote] = delta.unvotes;
    if (!unvote) throw new Error("validateOp: unvote flag set but delta.unvotes is empty");
    if (entityKind(state, unvote.target) === undefined) {
      return reject("unknown_target", `unvote target ${unvote.target} does not exist`);
    }
  } else if (isVote) {
    const [vote] = delta.votes;
    if (!vote) throw new Error("validateOp: vote flag set but delta.votes is empty");
    if (entityKind(state, vote.target) === undefined) {
      return reject("unknown_target", `vote target ${vote.target} does not exist`);
    }
  } else {
    const [created] = delta.created;
    for (const entry of delta.entries) {
      const kind =
        isCreate && created && entry.key.entity === created.id
          ? created.kind
          : entityKind(state, entry.key.entity);
      if (kind === undefined) {
        return reject("unknown_target", `entity ${entry.key.entity} does not exist`);
      }
      if (!FIELDS_BY_KIND[kind].has(entry.key.field)) {
        return reject("unknown_target", `field ${entry.key.field} is not valid for kind ${kind}`);
      }
      if (entry.key.field === "group" && entry.value !== null) {
        const groupId = typeof entry.value === "string" ? entry.value : undefined;
        if (groupId === undefined || entityKind(state, groupId as EntityId) !== "group") {
          return reject("unknown_target", `group ${String(entry.value)} does not exist`);
        }
      }
    }
  }

  // V4 — перекрытие обосновано.
  for (const supersede of delta.supersedes) {
    if (supersedeRecorded(state, supersede.key, supersede.dot)) continue;
    const target = entryAt(state, supersede.key, supersede.dot);
    if (!target) {
      return reject(
        "unjustified_supersede",
        `no entry to supersede at ${JSON.stringify(supersede)}`,
      );
    }
    const ownEntry = delta.entries.find(
      (entry) =>
        entry.key.entity === supersede.key.entity && entry.key.field === supersede.key.field,
    );
    if (!ownEntry) {
      return reject("unjustified_supersede", "supersede has no matching entry in this delta");
    }
    // Сравниваем именно lamport, не полный порядок Stamp (compareStamps):
    // честный клиент тикает lamport строго выше всего видимого им (tick(),
    // packages/crdt/src/index.ts) — равный lamport у e и δ невозможен для
    // честного клиента ни при каком исходе тай-брейка по actor, это всегда
    // подделка. Тай-брейк по actor в compareStamps существует для выбора
    // победителя среди truly concurrent записей (R2), не для этой проверки
    // причинности — актор target здесь мог случайно отсортироваться раньше.
    if (target.stamp.lamport >= ownEntry.stamp.lamport) {
      return reject(
        "unjustified_supersede",
        "superseded entry's lamport is not older than the new entry's",
      );
    }
  }

  // V5 — метка. Только для операций с записями; у vote/unvote метки нет.
  if (delta.entries.length > 0) {
    if (!actorClock) throw new Error("validateOp: actorClock required when delta has entries");
    for (const entry of delta.entries) {
      if (entry.stamp.actor !== dot.actor) {
        return reject("invalid_stamp", "stamp actor does not match operation actor");
      }
      if (entry.stamp.lamport <= actorClock.lastLamport) {
        return reject("invalid_stamp", "lamport is not fresher than actor's last accepted lamport");
      }
      if (entry.stamp.lamport > actorClock.boardMaxLamport + MAX_LAMPORT_AHEAD) {
        return reject("invalid_stamp", "lamport is too far ahead of the board's maximum");
      }
    }
  }

  return { ok: true };
}
