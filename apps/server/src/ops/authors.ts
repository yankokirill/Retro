// T-011 — авторство сущностей (REQ-006, REQ-007/REQ-009 «только свой
// стикер»). `protocol.md` § 2: автор хранится только на сервере, вне CRDT.

import { and, eq } from "drizzle-orm";
import type { Db } from "../boards/service.js";
import { authors } from "../db/schema.js";

/**
 * Записывает автора сущности один раз (при создании). `onConflictDoNothing`
 * — идемпотентно на случай повторной доставки того же `create` (REQ-023
 * кр.3): вторая попытка не перезаписывает и не падает.
 */
export async function recordAuthor(
  db: Db,
  boardId: string,
  entityId: string,
  guestId: string,
): Promise<void> {
  await db
    .insert(authors)
    .values({ boardId, entityId, guestId })
    .onConflictDoNothing({ target: [authors.boardId, authors.entityId] });
}

/** `null` — авторство не записано (сущность не стикер, либо ещё не создана). */
export async function authorOf(db: Db, boardId: string, entityId: string): Promise<string | null> {
  const [row] = await db
    .select({ guestId: authors.guestId })
    .from(authors)
    .where(and(eq(authors.boardId, boardId), eq(authors.entityId, entityId)));
  return row?.guestId ?? null;
}
