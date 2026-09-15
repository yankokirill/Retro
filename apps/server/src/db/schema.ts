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
  // T-026, ВС-2(б) (docs/spec/simulator.md § 13, H1): seq доски на момент
  // первого ухода из collect (reveal); null, пока доска ещё в collect.
  // Позволяет welcome досылать переподключившемуся гостю строки, скрытые
  // от него во время collect, seq которых уже <= его собственного lastSeq
  // (см. JSDoc gateway.ts, обработчик hello).
  revealSeq: bigint("reveal_seq", { mode: "number" }),
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
    // text, не uuid: ActorId в packages/crdt — непрозрачная строка без
    // формата (CLAUDE.md правило 7, пакет "чистый"); реальные клиенты шлют
    // UUID (protocol.md § 2), но это проверяется на границе протокола
    // (V1-V5, T-010), не здесь. Тестовые сценарии (packages/crdt/test/
    // arbitraries.ts, переиспользуемые test-author) используют
    // человекочитаемые id вида "actor-1" — uuid здесь их бы отверг.
    actor: text("actor"),
    counter: integer("counter"),
    lamport: integer("lamport"),
    delta: jsonb("delta").$type<WireDelta>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.boardId, table.actor, table.counter)],
);

/**
 * Автор сущности (T-011, REQ-006, REQ-007/REQ-009 «только свой стикер»).
 * `protocol.md` § 2: «Автор хранится только на сервере, в CRDT его нет» —
 * это и есть механизм. Заполняется один раз, когда принимается `create`
 * (`ws/gateway.ts`, после успешного `appendOp`); сейчас только для
 * стикеров (`kind === "sticker"`) — только они упомянуты в REQ-006/007/009,
 * авторство групп/action item в T-011 не нужно и не пишется.
 * `entityId` — `text`, не `uuid`: `EntityId = dotKey(dot)` = `"${actor}:${counter}"`,
 * составная строка, как `ops.actor` (см. её же JSDoc).
 */
export const authors = pgTable(
  "authors",
  {
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id),
    entityId: text("entity_id").notNull(),
    guestId: uuid("guest_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.boardId, table.entityId] })],
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
