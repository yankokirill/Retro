// T-007 — создание доски, гостевая сессия, роли (REQ-001, REQ-002, REQ-003,
// ADR-0007). Функции берут `db` параметром, а не импортируют синглтон из
// `db/client.ts` — тестируемо без переменных окружения (Testcontainers
// передаёт своё подключение).

import type { Role } from "@retro/protocol";
import { and, eq, isNull, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { boards, members } from "../db/schema.js";

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
export async function createBoard(db: Db, params: CreateBoardParams): Promise<CreateBoardResult> {
  const [board] = await db
    .insert(boards)
    .values({
      title: params.title,
      settings: { voteLimit: params.voteLimit },
      ownerId: params.ownerId,
    })
    .returning({
      id: boards.id,
      participantLinkToken: boards.participantLinkToken,
      viewerLinkToken: boards.viewerLinkToken,
    });
  if (!board) throw new Error("createBoard: insert returned no row");

  await db.insert(members).values({
    boardId: board.id,
    userId: params.ownerId,
    role: "owner",
    displayName: params.displayName,
  });

  return {
    boardId: board.id,
    participantLink: board.participantLinkToken,
    viewerLink: board.viewerLinkToken,
  };
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
 * `onConflictDoNothing` + повторное чтение делает первый заход race-safe:
 * при двух одновременных запросах одного гостя выигрывает только один
 * insert, второй читает уже вставленную роль, а не дублирует запись.
 */
export async function joinByLink(
  db: Db,
  params: JoinByLinkParams,
): Promise<JoinByLinkResult | null> {
  const [board] = await db
    .select({
      id: boards.id,
      participantLinkToken: boards.participantLinkToken,
      viewerLinkToken: boards.viewerLinkToken,
    })
    .from(boards)
    .where(
      and(
        or(
          eq(boards.participantLinkToken, params.linkToken),
          eq(boards.viewerLinkToken, params.linkToken),
        ),
        isNull(boards.deletedAt),
      ),
    );
  if (!board) return null;

  const role: Role = board.participantLinkToken === params.linkToken ? "participant" : "viewer";

  const [inserted] = await db
    .insert(members)
    .values({ boardId: board.id, userId: params.guestId, role, displayName: params.displayName })
    .onConflictDoNothing({ target: [members.boardId, members.userId] })
    .returning({ role: members.role });
  if (inserted) return { boardId: board.id, role: inserted.role as Role };

  const [existing] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.boardId, board.id), eq(members.userId, params.guestId)));
  if (!existing) throw new Error("joinByLink: membership missing after insert conflict");
  return { boardId: board.id, role: existing.role as Role };
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
  db: Db,
  params: GetBoardForGuestParams,
): Promise<BoardForGuest | null> {
  const [board] = await db
    .select()
    .from(boards)
    .where(and(eq(boards.id, params.boardId), isNull(boards.deletedAt)));
  if (!board) return null;

  let role: Role;
  if (board.ownerId === params.guestId) {
    role = "owner";
  } else {
    const [member] = await db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.boardId, board.id), eq(members.userId, params.guestId)));
    if (!member) return null;
    role = member.role as Role;
  }

  return {
    boardId: board.id,
    title: board.title,
    phase: board.phase,
    revealed: false,
    voteLimit: board.settings.voteLimit,
    timer: null,
    authors: {},
    role,
  };
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
  db: Db,
  params: GrantFacilitatorParams,
): Promise<GrantFacilitatorResult> {
  const [board] = await db
    .select({ ownerId: boards.ownerId })
    .from(boards)
    .where(and(eq(boards.id, params.boardId), isNull(boards.deletedAt)));
  if (!board || board.ownerId !== params.granterGuestId) return "not_owner";

  const [target] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.boardId, params.boardId), eq(members.userId, params.targetGuestId)));
  if (!target) return "target_not_member";

  await db
    .update(members)
    .set({ role: "facilitator" })
    .where(and(eq(members.boardId, params.boardId), eq(members.userId, params.targetGuestId)));

  return "ok";
}
