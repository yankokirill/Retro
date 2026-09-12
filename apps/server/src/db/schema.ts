import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Минимальная схема вехи В1 — доказывает, что миграции работают.
 *
 * Полная схема (members, ops, snapshots, audit, usage) появится вехой В2+
 * вместе со спецификацией протокола и CRDT-инвариантами
 * (docs/spec/consistency-model.md, CLAUDE.md § 3 «Хранилище»).
 */
export const boards = pgTable("boards", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  template: text("template").notNull().default("start-stop-continue"),
  phase: text("phase").notNull().default("collect"),
  settings: jsonb("settings").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
