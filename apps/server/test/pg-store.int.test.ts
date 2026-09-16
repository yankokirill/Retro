// T-024 (docs/design/T-005-simulator.md § 3.2, SIM-03 кр. 1): проверяет
// `PgBoardStore` (apps/server/src/store/pg-store.ts) общим контрактным
// набором `describeBoardStoreContract` (packages/server-core/test/
// store-contract.ts, написан test-author'ом ДО этого адаптера) — тем же
// набором, что T-025 прогонит на `MemoryBoardStore`. Сама проверочная логика
// живёт в контракте; этот файл только подключает реальный Postgres
// (Testcontainers) и даёт контракту способ завести доску/участника/снапшот
// напрямую в БД, минуя протокол (SIM-03 кр. 1 — «адаптер передаётся
// параметром», `setup` — тестовая надстройка сверх порта, см. JSDoc
// `BoardStoreContractSetup`).

import type { Role } from "@retro/protocol";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";
import {
  type BoardStoreContractSetup,
  describeBoardStoreContract,
} from "../../../packages/server-core/test/store-contract.js";
import * as schema from "../src/db/schema.js";
import { authors, boards, members, ops, snapshots } from "../src/db/schema.js";
import { saveSnapshot as saveSnapshotRow } from "../src/ops/log.js";
import { PgBoardStore } from "../src/store/pg-store.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

// store-contract.ts использует один и тот же литерал BOARD.id/GUEST_1/… во
// всех `it` — рассчитано на свежее in-memory хранилище на каждый вызов
// makeStore() (так и есть у ReferenceBoardStore, store-contract.smoke.test.ts).
// Реальный Postgres — общая БД на весь файл (один контейнер, поднятый в
// beforeAll), поэтому без очистки второй `it` упал бы на UNIQUE-конфликте
// "boards_pkey", а не на настоящем нарушении контракта. Порядок — по внешним
// ключам (ops/authors/snapshots/members → boards).
beforeEach(async () => {
  await db.delete(ops);
  await db.delete(authors);
  await db.delete(snapshots);
  await db.delete(members);
  await db.delete(boards);
});

const setup: BoardStoreContractSetup = {
  async createBoard(_store, board) {
    await db.insert(boards).values({
      id: board.id,
      title: board.title,
      ownerId: board.ownerId,
      phase: board.phase,
      settings: { voteLimit: board.voteLimit },
    });
  },
  async addMember(_store, boardId, guestId, role: Role, displayName = "Guest") {
    await db.insert(members).values({ boardId, userId: guestId, role, displayName });
  },
  async saveSnapshot(_store, boardId, snapshot) {
    // Существующая saveSnapshot компактит state перед записью (ops/log.ts) —
    // безопасно для контракта: materialize инвариантен к компактизации (I5),
    // сравнения в store-contract.ts идут через materialize, не побитово.
    await saveSnapshotRow(db, boardId, snapshot.uptoSeq, snapshot.state);
  },
};

describeBoardStoreContract("pg", () => new PgBoardStore(db), setup);
