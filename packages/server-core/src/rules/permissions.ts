// T-011 — права и фазы для операций CRDT над стикерами/action item (V6,
// docs/spec/consistency-model.md § 7; матрица — CLAUDE.md § 5,
// docs/security/permissions.md). Права на смену фазы — отдельно,
// `rules/board.ts` `checkSetPhase` (это не CRDT-операция).
//
// Сознательно НЕ гейтится в T-011 (см. REQ, которые задача заявляет —
// docs/tasks.md): создание/переименование группы (REQ-012), поля action
// item assignee/done/удаление (REQ-018/019), vote/unvote (V7, T-012). Эти
// операции проходят `classifyAction` → `null` → пропускаются без проверки
// прав — не потому что всем можно, а потому что правило ещё не назначено
// ни одной задаче.
//
// T-024: переехала из apps/server/src/ops/permissions.ts (реэкспорт там
// остаётся) без изменения поведения.

import type { State, WireDelta } from "@retro/crdt";
import { entityKind } from "@retro/crdt";
import type { Phase, RejectReason, Role } from "@retro/protocol";

export type StickerAction =
  | "createSticker"
  | "createAction"
  | "editSticker"
  | "assignGroup"
  | "moveSticker";

/**
 * Какое действие представляет клиентская дельта, если T-011 вообще его
 * гейтит; `null` — не гейтится (см. шапку файла). `state` нужен, чтобы для
 * `write`-дельты (не `created`) узнать вид сущности — по имени поля
 * однозначно определить вид нельзя: `place`/`deleted` есть и у стикера, и
 * у группы; `text` — и у стикера, и у action item (§ 1.4 `consistency-model.md`).
 *
 * `place` классифицируется отдельно от `text`/`color`/`deleted`
 * (`moveSticker`, не `editSticker`) — находка code-review, `fix/T-011-op-
 * single-entity`: REQ-011/`CLAUDE.md` § 5 требуют, чтобы в фазе `group`
 * можно было переместить ЛЮБОЙ стикер (как и назначить группу), а не
 * только свой — правило владения у `place` отличается от `text`/`color`/
 * `deleted` в зависимости от фазы (см. `checkPermission`).
 */
export function classifyAction(state: State, delta: WireDelta): StickerAction | null {
  const [created] = delta.created;
  if (created) {
    if (created.kind === "sticker") return "createSticker";
    if (created.kind === "action") return "createAction";
    return null; // group
  }
  if (delta.votes.length > 0 || delta.unvotes.length > 0) return null;

  const [entry] = delta.entries;
  if (!entry) return null;
  if (entityKind(state, entry.key.entity) !== "sticker") return null;
  if (entry.key.field === "group") return "assignGroup";
  if (entry.key.field === "place") return "moveSticker";
  return "editSticker";
}

export interface CheckPermissionParams {
  readonly role: Role;
  readonly phase: Phase;
  readonly action: StickerAction;
  /**
   * Для `editSticker` — всегда, и для `moveSticker` — только в фазе
   * `collect` (в фазе `group` владение не проверяется, см. `checkPermission`):
   * правит ли участник свою же сущность (`ops/authors.ts` `authorOf`). Для
   * остальных действий не используется: `createSticker`/`createAction` —
   * всегда «свой» по построению; `assignGroup` — REQ-011 не требует
   * владения (любой стикер в фазе `group`).
   */
  readonly isOwn: boolean;
}

export type CheckPermissionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RejectReason; readonly message: string };

/**
 * V6. `owner`/`facilitator` — всегда `ok` (любая фаза, любая сущность).
 * `viewer` — всегда `forbidden`. `participant` — по действию:
 *  - `createSticker`: фаза ∈ {collect, group} (REQ-005 кр.2);
 *  - `createAction`: фаза ∈ {discuss, actions} (REQ-017);
 *  - `editSticker`: фаза ∈ {collect, group} **и** `isOwn` (REQ-007/009) —
 *    фаза не подходит → `wrong_phase`; чужая сущность (даже в подходящей
 *    фазе) → `forbidden`;
 *  - `moveSticker`: фаза ∈ {collect, group}; в `collect` — **и** `isOwn`
 *    (до `reveal` чужие стикеры не видны, REQ-006), в `group` — владение не
 *    требуется, любой стикер (REQ-011, находка code-review `fix/T-011-op-
 *    single-entity`);
 *  - `assignGroup`: фаза === `group`, владение не требуется (REQ-011).
 */
function reject(reason: RejectReason, message: string): CheckPermissionResult {
  return { ok: false, reason, message };
}

export function checkPermission(params: CheckPermissionParams): CheckPermissionResult {
  const { role, phase, action, isOwn } = params;
  if (role === "owner" || role === "facilitator") return { ok: true };
  if (role === "viewer") return reject("forbidden", `viewer cannot perform ${action}`);

  // role === "participant"
  switch (action) {
    case "createSticker":
      if (phase !== "collect" && phase !== "group") {
        return reject("wrong_phase", `createSticker not allowed in phase ${phase}`);
      }
      return { ok: true };
    case "createAction":
      if (phase !== "discuss" && phase !== "actions") {
        return reject("wrong_phase", `createAction not allowed in phase ${phase}`);
      }
      return { ok: true };
    case "editSticker":
      if (phase !== "collect" && phase !== "group") {
        return reject("wrong_phase", `editSticker not allowed in phase ${phase}`);
      }
      if (!isOwn) return reject("forbidden", "participant can only edit their own sticker");
      return { ok: true };
    case "moveSticker":
      if (phase !== "collect" && phase !== "group") {
        return reject("wrong_phase", `moveSticker not allowed in phase ${phase}`);
      }
      // В group — любой стикер (REQ-011); в collect владение ещё нужно
      // (чужие стикеры до reveal и так не видны, REQ-006 — это лишь defence
      // in depth, не единственная защита).
      if (phase === "collect" && !isOwn) {
        return reject("forbidden", "participant can only move their own sticker in collect phase");
      }
      return { ok: true };
    case "assignGroup":
      if (phase !== "group") {
        return reject("wrong_phase", `assignGroup not allowed in phase ${phase}`);
      }
      return { ok: true };
  }
}
