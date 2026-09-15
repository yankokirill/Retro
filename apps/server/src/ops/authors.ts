// T-011 — авторство сущностей (REQ-006, REQ-007/REQ-009 «только свой
// стикер»). `protocol.md` § 2: автор хранится только на сервере, вне CRDT.
// T-013 добавил массовые выборки (`authorsForBoard`/`authorsDisplayNames`)
// для проекции видимости и `BoardMeta.authors` — один запрос на доску вместо
// одного на сущность.

import { and, eq } from "drizzle-orm";
import type { Db } from "../boards/service.js";
import { authors, members } from "../db/schema.js";

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

/**
 * T-013. Все записанные авторства доски разом, `entityId -> guestId` — один
 * запрос вместо `authorOf` на каждую сущность в дельте/снапшоте
 * (`ops/visibility.ts` `projectVisible`/`projectHidden`, каждый вызов на
 * `op`/`welcome`/`reveal`).
 */
export async function authorsForBoard(db: Db, boardId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ entityId: authors.entityId, guestId: authors.guestId })
    .from(authors)
    .where(eq(authors.boardId, boardId));
  return new Map(rows.map((row) => [row.entityId, row.guestId]));
}

/**
 * T-013, `BoardMeta.authors` (protocol.md § 5): `entityId -> displayName`
 * после `reveal` — join с `members` (владелец тоже там, `boards/service.ts`
 * `createBoard`: заносится в `members` с ролью `owner` при создании доски).
 * Гость без записи в `members` для записанного авторства недостижим — автор
 * не может перестать быть участником доски (ADR/тасков на выход из доски
 * нет в MVP), поэтому строки без пары просто отсутствуют в результате
 * `inner join`, а не требуют отдельной обработки `null`.
 */
export async function authorsDisplayNames(
  db: Db,
  boardId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ entityId: authors.entityId, displayName: members.displayName })
    .from(authors)
    .innerJoin(
      members,
      and(eq(members.boardId, authors.boardId), eq(members.userId, authors.guestId)),
    )
    .where(eq(authors.boardId, boardId));
  return Object.fromEntries(rows.map((row) => [row.entityId, row.displayName]));
}
