// T-007 — создание доски, гостевая сессия, роли (REQ-001, REQ-002, REQ-003,
// ADR-0007). Функции берут `db` параметром, а не импортируют синглтон из
// `db/client.ts` — тестируемо без переменных окружения (Testcontainers
// передаёт своё подключение).

import type { Role } from "@retro/protocol";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";

export type Db = NodePgDatabase<typeof schema>;

export interface CreateBoardParams {
  readonly title: string;
  readonly displayName: string;
  /** Уже применён вызывающим слоем `LIMITS.voteLimit.default`, если не задан клиентом. */
  readonly voteLimit: number;
  readonly ownerId: string;
}

export interface CreateBoardResult {
  readonly boardId: string;
  readonly participantLink: string;
  readonly viewerLink: string;
}

/**
 * REQ-001. Создаёт доску и сразу заносит создателя в `members` с ролью
 * `owner` (REQ-003, кр. 1) — отдельной операции присоединения ему не нужно.
 */
export async function createBoard(_db: Db, _params: CreateBoardParams): Promise<CreateBoardResult> {
  throw new Error("createBoard: not implemented");
}

export interface JoinByLinkParams {
  readonly linkToken: string;
  readonly guestId: string;
  readonly displayName: string;
}

export interface JoinByLinkResult {
  readonly boardId: string;
  readonly role: Role;
}

/**
 * ADR-0007, REQ-002 (кр. 5–7). `null` — токен не соответствует ни одной
 * доске, либо доска удалена. Гость с уже существующей записью в `members`
 * получает эту существующую роль — токен не пересчитывает её задним числом.
 */
export async function joinByLink(
  _db: Db,
  _params: JoinByLinkParams,
): Promise<JoinByLinkResult | null> {
  throw new Error("joinByLink: not implemented");
}

export interface GetBoardForGuestParams {
  readonly boardId: string;
  readonly guestId: string;
}

export interface BoardForGuest {
  readonly boardId: string;
  readonly title: string;
  readonly phase: string;
  readonly revealed: boolean;
  readonly voteLimit: number;
  readonly timer: null;
  readonly authors: Record<string, string>;
  readonly role: Role;
}

/**
 * REQ-002 (кр. 8). `null` — доска не существует, удалена, либо `guestId` не
 * `owner` и не встречается в `members` (не через `join` — доска не
 * «нащупывается» по голому `boardId`). REST-слой превращает `null` в `404`.
 * `revealed`/`timer`/`authors` — фиксированные значения до T-013 (фазы,
 * проекция видимости) ещё не реализованы.
 */
export async function getBoardForGuest(
  _db: Db,
  _params: GetBoardForGuestParams,
): Promise<BoardForGuest | null> {
  throw new Error("getBoardForGuest: not implemented");
}

export type GrantFacilitatorResult = "ok" | "not_owner" | "target_not_member";

export interface GrantFacilitatorParams {
  readonly boardId: string;
  readonly granterGuestId: string;
  readonly targetGuestId: string;
}

/**
 * REQ-003 (кр. 2–3). Внутренняя функция — без REST/WS-обёртки в T-007: по
 * `docs/spec/protocol.md` § 4 `grantFacilitator` — WS `command`, канал
 * появится в T-009/T-011. Уже реализована и протестирована, чтобы тот
 * обработчик был тонкой обёрткой над этой функцией.
 */
export async function grantFacilitator(
  _db: Db,
  _params: GrantFacilitatorParams,
): Promise<GrantFacilitatorResult> {
  throw new Error("grantFacilitator: not implemented");
}
