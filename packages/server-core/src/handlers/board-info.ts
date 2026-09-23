// T-024 — перенос `boardsService.getBoardForGuest` (apps/server/src/boards/
// service.ts) на порт `BoardStore`: та же логика (роль через `resolveRole`,
// `revealed`/`authors` по фазе), только через `store.board`/`store.memberRole`/
// `store.authorDisplayNames` вместо прямых запросов Drizzle. Используется и
// `handlers/hello.ts` (сборка `welcome`), и `handlers/command.ts` (рассылка
// `meta` после успешного `setPhase`) — вынесено сюда, чтобы не дублировать.

import type { BoardMeta, Role } from "@retro/protocol";
import { phaseSchema } from "@retro/protocol";
import { resolveRole } from "../rules/board.js";
import type { BoardStore } from "../store.js";

export interface GuestBoardInfo {
  readonly title: string;
  readonly phase: string;
  readonly revealed: boolean;
  /** T-026 (ВС-2 б): seq доски на момент reveal; `null`, пока `collect`. */
  readonly revealSeq: number | null;
  readonly voteLimit: number;
  readonly timerEndsAt: string | null;
  readonly authors: Record<string, string>;
  readonly role: Role;
}

/**
 * `null` — доска не существует, либо `guestId` не `owner` и не встречается
 * в участниках (недостижимо по голому `boardId`, как и в оригинале). `authors`
 * — пусто до `reveal` (REQ-006), после — `store.authorDisplayNames`.
 */
export async function getBoardForGuest(
  store: BoardStore,
  boardId: string,
  guestId: string,
): Promise<GuestBoardInfo | null> {
  const board = await store.board(boardId);
  if (!board) return null;

  const memberRole = await store.memberRole(boardId, guestId);
  const role = resolveRole({ ownerId: board.ownerId, guestId, memberRole });
  if (!role) return null;

  const revealed = board.phase !== "collect";
  return {
    title: board.title,
    phase: board.phase,
    revealed,
    revealSeq: board.revealSeq,
    voteLimit: board.voteLimit,
    timerEndsAt: board.timerEndsAt,
    authors: revealed ? await store.authorDisplayNames(boardId) : {},
    role,
  };
}

/** `BoardMeta` (protocol.md § 5) из `GuestBoardInfo` — общая для `welcome`/`meta`. */
export function buildMeta(boardId: string, guest: GuestBoardInfo): BoardMeta {
  return {
    boardId,
    title: guest.title,
    phase: phaseSchema.parse(guest.phase),
    revealed: guest.revealed,
    voteLimit: guest.voteLimit,
    timer: guest.timerEndsAt === null ? null : { endsAt: guest.timerEndsAt },
    authors: guest.authors,
  };
}
