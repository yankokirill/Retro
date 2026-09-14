import { jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Схема доски. `ownerId` и оба `*LinkToken` — с T-007 (ADR-0007): создатель
 * доски заносится в `members` сразу (owner), остальные роли —
 * (participant/viewer) присваиваются по одному из двух неугадываемых
 * токенов-приглашений (128 бит, как у `id`), а не порядком захода.
 *
 * Полная схема (ops, snapshots, audit, usage) появится вехами В4/В5+
 * вместе с журналом операций и CRDT-инвариантами
 * (docs/spec/consistency-model.md, CLAUDE.md § 3 «Хранилище»).
 */
export const boards = pgTable("boards", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  template: text("template").notNull().default("start-stop-continue"),
  phase: text("phase").notNull().default("collect"),
  settings: jsonb("settings").notNull().default({}),
  ownerId: uuid("owner_id").notNull(),
  participantLinkToken: uuid("participant_link_token").notNull().defaultRandom().unique(),
  viewerLinkToken: uuid("viewer_link_token").notNull().defaultRandom().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/**
 * Членство гостя на доске (T-007, REQ-002/003). `userId` = `guestId`
 * (`docs/spec/protocol.md` § 2) — переживает перезагрузку страницы, в
 * отличие от `actorId` из `consistency-model.md` § 1.1. Роль присваивается
 * один раз (по ссылке-приглашению или при создании доски — owner) и после
 * этого читается из этой таблицы, не пересчитывается (REQ-002, кр. 6).
 */
export const members = pgTable(
  "members",
  {
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id),
    userId: uuid("user_id").notNull(),
    role: text("role", { enum: ["owner", "facilitator", "participant", "viewer"] }).notNull(),
    displayName: text("display_name").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.boardId, table.userId] })],
);
