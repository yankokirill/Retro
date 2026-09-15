// T-007 — создание доски, гостевая сессия, роли (REQ-001, REQ-002, REQ-003,
// ADR-0007). Функции берут `db` параметром, а не импортируют синглтон из
// `db/client.ts` — тестируемо без переменных окружения (Testcontainers
// передаёт своё подключение).

import type { Phase, Role } from "@retro/protocol";
import { and, eq, isNull, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import { boards, members } from "../db/schema.js";
import { authorsDisplayNames } from "../ops/authors.js";

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
 * `revealed` (T-013, REQ-004 кр.1): доска раскрыта ⇔ текущая фаза не
 * `collect` — тот же аргумент по индукции, что и `irreversible_phase` в
 * `setPhase` ниже: вернуться в `collect` нельзя, значит любая другая фаза
 * доказывает, что доска его уже покинула. `authors` — пусто до reveal
 * (REQ-006), после — из `authorsDisplayNames` (T-013, `ops/authors.ts`).
 * `timer` — фиксированное значение, вне T-013 (REQ-019, отдельная задача).
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

  const revealed = board.phase !== "collect";

  return {
    boardId: board.id,
    title: board.title,
    phase: board.phase,
    revealed,
    voteLimit: board.settings.voteLimit,
    timer: null,
    authors: revealed ? await authorsDisplayNames(db, board.id) : {},
    role,
  };
}

/** Текущая фаза доски; `null` — доска не существует/удалена (T-011, V6). */
export async function getBoardPhase(db: Db, boardId: string): Promise<string | null> {
  const [board] = await db
    .select({ phase: boards.phase })
    .from(boards)
    .where(and(eq(boards.id, boardId), isNull(boards.deletedAt)));
  return board?.phase ?? null;
}

export type SetPhaseResult = "ok" | "forbidden" | "irreversible_phase" | "not_found";

export interface SetPhaseParams {
  readonly boardId: string;
  readonly guestId: string;
  readonly phase: Phase;
}

/**
 * REQ-004 (кр. 2, 4). Роль проверяется здесь же (не через `ops/permissions.ts`
 * — та про CRDT-операции над стикерами/action item, `setPhase` — метаданные
 * доски, ближе по духу к `grantFacilitator` выше). `irreversible_phase`
 * (кр. 2): доска уже покидала `collect`, если её текущая фаза — не `collect`;
 * отдельного флага «уже раскрыта» не нужно — вернуться в `collect` можно
 * только из него самого, значит текущая фаза сама по себе доказывает факт
 * ухода (по индукции: если бы уход был возможен, эта же проверка отклонила
 * бы более раннюю попытку).
 */
export async function setPhase(db: Db, params: SetPhaseParams): Promise<SetPhaseResult> {
  const [board] = await db
    .select({ ownerId: boards.ownerId, phase: boards.phase })
    .from(boards)
    .where(and(eq(boards.id, params.boardId), isNull(boards.deletedAt)));
  if (!board) return "not_found";

  let role: Role;
  if (board.ownerId === params.guestId) {
    role = "owner";
  } else {
    const [member] = await db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.boardId, params.boardId), eq(members.userId, params.guestId)));
    if (!member) return "not_found";
    role = member.role as Role;
  }
  if (role !== "owner" && role !== "facilitator") return "forbidden";
  if (board.phase !== "collect" && params.phase === "collect") return "irreversible_phase";

  await db.update(boards).set({ phase: params.phase }).where(eq(boards.id, params.boardId));
  return "ok";
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

export interface BoardVoteSettings {
  readonly phase: Phase;
  readonly voteLimit: number;
}

/**
 * Фаза и лимит голосов доски одним запросом — оба нужны `ws/gateway.ts` для
 * V7 (`ops/votes.ts` `checkVotePermission`/`checkVoteLimit`) на каждый
 * `vote`/`unvote`. `null` — доска не существует/удалена.
 */
export async function getBoardVoteSettings(
  db: Db,
  boardId: string,
): Promise<BoardVoteSettings | null> {
  const [board] = await db
    .select({ phase: boards.phase, settings: boards.settings })
    .from(boards)
    .where(and(eq(boards.id, boardId), isNull(boards.deletedAt)));
  if (!board) return null;
  return { phase: board.phase as Phase, voteLimit: board.settings.voteLimit };
}

export type ResetVotesResult = "ok" | "forbidden" | "not_found";

export interface ResetVotesParams {
  readonly boardId: string;
  readonly guestId: string;
}

/**
 * REQ-016. Проверяет только роль (owner/facilitator) — сам массовый отзыв
 * голосов реализуется как по одному `unvote` на активный голос (REQ-016,
 * «не отдельная примитивная операция CRDT»), а для этого нужны и состояние
 * доски (`replayFromSnapshot`), и `BoardHub` для рассылки каждого `unvote`
 * как обычного `op` — недоступны на уровне `boards/service.ts` (только
 * `db`), поэтому сам отзыв делает `ws/gateway.ts` после `"ok"` отсюда.
 */
export async function resetVotes(db: Db, params: ResetVotesParams): Promise<ResetVotesResult> {
  const [board] = await db
    .select({ ownerId: boards.ownerId })
    .from(boards)
    .where(and(eq(boards.id, params.boardId), isNull(boards.deletedAt)));
  if (!board) return "not_found";

  let role: Role;
  if (board.ownerId === params.guestId) {
    role = "owner";
  } else {
    const [member] = await db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.boardId, params.boardId), eq(members.userId, params.guestId)));
    if (!member) return "not_found";
    role = member.role as Role;
  }
  if (role !== "owner" && role !== "facilitator") return "forbidden";

  return "ok";
}
