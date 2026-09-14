// T-011 — права и фазы для операций CRDT над стикерами/action item (V6,
// docs/spec/consistency-model.md § 7; матрица — CLAUDE.md § 5,
// docs/security/permissions.md). Права на смену фазы — отдельно,
// `boards/service.ts` `setPhase` (это не CRDT-операция).
//
// Сознательно НЕ гейтится в T-011 (см. REQ, которые задача заявляет —
// docs/tasks.md): создание/переименование группы (REQ-012), поля action
// item assignee/done/удаление (REQ-018/019), vote/unvote (V7, T-012). Эти
// операции проходят `classifyAction` → `null` → пропускаются без проверки
// прав — не потому что всем можно, а потому что правило ещё не назначено
// ни одной задаче.

import type { State, WireDelta } from "@retro/crdt";
import { entityKind } from "@retro/crdt";
import type { Phase, RejectReason, Role } from "@retro/protocol";

export type StickerAction = "createSticker" | "createAction" | "editSticker" | "assignGroup";

/**
 * Какое действие представляет клиентская дельта, если T-011 вообще его
 * гейтит; `null` — не гейтится (см. шапку файла). `state` нужен, чтобы для
 * `write`-дельты (не `created`) узнать вид сущности — по имени поля
 * однозначно определить вид нельзя: `place`/`deleted` есть и у стикера, и
 * у группы; `text` — и у стикера, и у action item (§ 1.4 `consistency-model.md`).
 */
export function classifyAction(state: State, delta: WireDelta): StickerAction | null {
  throw new Error("classifyAction: not implemented");
}

export interface CheckPermissionParams {
  readonly role: Role;
  readonly phase: Phase;
  readonly action: StickerAction;
  /**
   * Только для `editSticker` — правит ли участник свою же сущность
   * (`ops/authors.ts` `authorOf`). Для остальных действий не используется:
   * `createSticker`/`createAction` — всегда «свой» по построению;
   * `assignGroup` — REQ-011 не требует владения (любой стикер в фазе `group`).
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
 *  - `assignGroup`: фаза === `group`, владение не требуется (REQ-011).
 */
export function checkPermission(params: CheckPermissionParams): CheckPermissionResult {
  throw new Error("checkPermission: not implemented");
}
