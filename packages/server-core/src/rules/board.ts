// T-024 — правила метаданных доски (не CRDT-операции): роль гостя,
// разрешение сменить фазу (`setPhase`), разрешение сбросить голоса
// (`resetVotes`). Выделены из apps/server/src/boards/service.ts, которая
// раньше делала выборки из БД и проверку роли одной функцией — здесь только
// проверка, доступ к хранилищу — дело `store.board`/`store.memberRole`
// (порт `BoardStore`) в `handlers/command.ts`.

import type { Phase, Role } from "@retro/protocol";

/**
 * REQ-002 (кр. 8), REQ-003 (кр. 1): владелец доски получает роль `owner` не
 * через запись в `members` (её для него нет отдельно от создания доски), а
 * по совпадению `guestId` с `board.ownerId`. Для всех остальных — роль из
 * `members`, `null` — гость не участник (доска не «нащупывается» по голому
 * `boardId`).
 */
export function resolveRole(params: {
  readonly ownerId: string;
  readonly guestId: string;
  readonly memberRole: Role | null;
}): Role | null {
  if (params.ownerId === params.guestId) return "owner";
  return params.memberRole;
}

export type SetPhaseCheckResult = "ok" | "forbidden" | "irreversible_phase";

/**
 * REQ-004 (кр. 2, 4). Роль проверяется отдельно от `rules/permissions.ts`
 * (V6) — та про CRDT-операции над стикерами/action item, смена фазы —
 * метаданные доски. `irreversible_phase` (кр. 2): доска уже покидала
 * `collect`, если её текущая фаза — не `collect`; отдельного флага «уже
 * раскрыта» не нужно — вернуться в `collect` можно только из него самого,
 * значит текущая фаза сама по себе доказывает факт ухода (по индукции: если
 * бы уход был возможен, эта же проверка отклонила бы более раннюю попытку).
 * И `forbidden`, и `irreversible_phase` — сами по себе валидные `RejectReason`
 * (protocol.md § 5) — вызывающий шлёт результат как есть, без перевода.
 */
export function checkSetPhase(
  role: Role | null,
  currentPhase: Phase,
  requestedPhase: Phase,
): SetPhaseCheckResult {
  if (role !== "owner" && role !== "facilitator") return "forbidden";
  if (currentPhase !== "collect" && requestedPhase === "collect") return "irreversible_phase";
  return "ok";
}

export type ResetVotesCheckResult = "ok" | "forbidden";

/** REQ-016. Только роль — сам массовый отзыв (по одному `unvote` на активный голос) делает `handlers/command.ts`. */
export function checkResetVotes(role: Role | null): ResetVotesCheckResult {
  if (role !== "owner" && role !== "facilitator") return "forbidden";
  return "ok";
}
