import type { WireDelta } from "@retro/crdt";
import {
  bigint,
  bigserial,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Схема доски. `ownerId` и оба `*LinkToken` — с T-007 (ADR-0007): создатель
 * доски заносится в `members` сразу (owner), остальные роли —
 * (participant/viewer) присваиваются по одному из двух неугадываемых
 * токенов-приглашений (128 бит, как у `id`), а не порядком захода.
 *
 * `ops`/`snapshots` — с T-008 (журнал операций и снапшоты). Остаток
 * (audit, usage) появится на В5+ (docs/spec/consistency-model.md,
 * CLAUDE.md § 3 «Хранилище»).
 */
export interface BoardSettings {
  readonly voteLimit: number;
}

export const boards = pgTable("boards", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  template: text("template").notNull().default("start-stop-continue"),
  phase: text("phase").notNull().default("collect"),
  // voteLimit всегда явно задан вызывающим (boards/service.ts createBoard),
  // значение по умолчанию здесь — только чтобы колонка была NOT NULL корректно.
  settings: jsonb("settings").$type<BoardSettings>().notNull().default({ voteLimit: 3 }),
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

/**
 * Журнал принятых операций (T-008, REQ-023 кр.3, REQ-027; § 6
 * `consistency-model.md`). `seq` — общий по всем доскам bigserial: клиент
 * сравнивает его только в пределах своей доски (`protocol.md` § 5–6), гэпы от
 * других досок не мешают. `delta` — ровно то, что несла одна операция
 * (`WireDelta` из `@retro/crdt`, § 3 protocol.md), без отдельной метки типа
 * операции — в протоколе её нет (см. правку `CLAUDE.md` § 3 при T-008).
 *
 * `actor`/`counter`/`lamport` — **nullable**, и это не одна и та же причина:
 * `lamport` отсутствует у `vote`/`unvote` (§ 3.1 — 2P-set, метки не бывает
 * вообще). `actor`/`counter` дополнительно отсутствуют именно у `unvote`:
 * в отличие от остальных операций, `Unvote.dot` в CRDT-модели — это dot
 * **отзываемого голоса**, а не свежий dot самой операции отзыва (T-002,
 * `packages/crdt/src/index.ts`: `unvote` намеренно не тикает часы). Поэтому
 * `(board_id, actor, counter)` как ключ идемпотентности к unvote не
 * применим — пара `(actor, counter)` уже занята исходной операцией `vote`.
 * `UNIQUE(board_id, actor, counter)` — идемпотентность приёма для операций,
 * у которых dot есть (V1, REQ-023 кр.3): повтор не создаёт вторую строку.
 * Postgres не считает NULL равным NULL в UNIQUE, поэтому строки `unvote`
 * (actor=counter=NULL) в это ограничение не попадают — повторная отправка
 * одного и того же unvote может завести лишнюю строку, но это безопасно:
 * merge по нему идемпотентен на уровне состояния (I2.5, REQ-023 кр.3 держится
 * для итогового состояния, а не для количества строк в журнале). Полная
 * защита от дублирования unvote на уровне протокола — вопрос V1 для T-010,
 * не решается здесь.
 */
export const ops = pgTable(
  "ops",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id),
    actor: uuid("actor"),
    counter: integer("counter"),
    lamport: integer("lamport"),
    delta: jsonb("delta").$type<WireDelta>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.boardId, table.actor, table.counter)],
);

/**
 * Снапшоты (T-008, REQ-027; § 6 `consistency-model.md`). `state` —
 * `compact(X_S(uptoSeq))` в проводном формате. Несколько строк на доску
 * допустимы (история); действующий — с максимальным `uptoSeq`
 * (`loadLatestSnapshot` в `ops/log.ts`). Инвариант I5:
 * `materialize(replay(ops)) == materialize(snapshot ⊔ ops после uptoSeq)`.
 */
export const snapshots = pgTable(
  "snapshots",
  {
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id),
    uptoSeq: bigint("upto_seq", { mode: "number" }).notNull(),
    state: jsonb("state").$type<WireDelta>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.boardId, table.uptoSeq] })],
);
