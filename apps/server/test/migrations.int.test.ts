// T-026 — code-review PR #19, находка 2 (низкая) — `docs/tasks.md` T-026:
// «миграция reveal_seq не заполняет колонку для досок, уже покинувших
// collect, — для них досылка H1 не срабатывает никогда»
// (`apps/server/drizzle/0008_lucky_dexter_bennett.sql`).
//
// Ожидаемое поведение после исправления (сформулировано в задаче агенту
// test-author, докладывая целевое поведение "вдогонку" к уже описанному в
// docs/spec/simulator.md § 13 ВС-2(б)): после применения миграции у каждой
// доски с `phase <> 'collect'` `reveal_seq` равен максимальному `seq` её
// строк в `ops` (или 0, если строк нет); у досок в `collect` — `NULL`.
//
// Этот тест НЕ поднимает `apps/server` (`buildApp`) — он проверяет
// непосредственно SQL миграции 0008 на настоящем Postgres в Testcontainers,
// без реализации сервера. Тестовые данные вставляются напрямую SQL-ом
// (валидность delta как WireDelta здесь не имеет значения — миграция это не
// проверяет). Схема таблиц взята из самих файлов миграций
// `apps/server/drizzle/000*.sql` (это схема хранилища, читать разрешено
// правилами агента) — `apps/server/src/**` не читался.
//
// Механика: применяем ВСЕ миграции как обычно (0000…0008 — это и создаёт
// колонку `reveal_seq`), затем эмулируем состояние "непосредственно перед
// применением 0008" (создаём доски/ops, выставляем `reveal_seq = NULL`
// вручную) и повторно выполняем операторы файла 0008, КРОМЕ
// `ALTER TABLE ... ADD COLUMN` (колонка уже существует — это единственная
// часть, которая могла бы что-то доделать, если бы backfill существовал).
// Сейчас в файле нет ничего, кроме `ADD COLUMN`, поэтому отфильтрованный
// список операторов пуст, ничего не выполняется, и `reveal_seq` остаётся
// `NULL` у уже раскрытой доски — тест должен упасть по этой причине.

import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

/**
 * Операторы файла 0008, кроме `ALTER TABLE ... ADD COLUMN` (колонка уже
 * создана обычным прогоном всех миграций в `beforeAll` — этот набор
 * эмулирует backfill, которого сейчас в файле нет вовсе).
 */
function backfillStatementsFrom0008(): string[] {
  const sql = readFileSync(
    new URL("../drizzle/0008_lucky_dexter_bennett.sql", import.meta.url),
    "utf-8",
  );
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .filter((statement) => !/^ALTER TABLE\s+"?boards"?\s+ADD COLUMN/i.test(statement));
}

async function insertBoard(phase: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO boards (title, phase, owner_id) VALUES ($1, $2, gen_random_uuid()) RETURNING id`,
    [`migration test board (${phase})`, phase],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("insertBoard: no id returned");
  return id;
}

/** Вставляет строку `ops` для доски и возвращает её реальный `seq` (bigserial). */
async function insertOp(boardId: string, tag: number): Promise<number> {
  const result = await pool.query<{ seq: string }>(
    `INSERT INTO ops (board_id, actor, counter, lamport, delta)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING seq`,
    [boardId, `actor-${tag}`, tag, tag, "{}"],
  );
  const seq = result.rows[0]?.seq;
  if (seq === undefined) throw new Error("insertOp: no seq returned");
  return Number(seq);
}

async function revealSeqOf(boardId: string): Promise<number | null> {
  const result = await pool.query<{ reveal_seq: string | null }>(
    `SELECT reveal_seq FROM boards WHERE id = $1`,
    [boardId],
  );
  const value = result.rows[0]?.reveal_seq;
  return value === null || value === undefined ? null : Number(value);
}

async function markAsNotYetBackfilled(boardId: string): Promise<void> {
  await pool.query(`UPDATE boards SET reveal_seq = NULL WHERE id = $1`, [boardId]);
}

describe("REQ-006 (кр. 3), code-review: миграция reveal_seq заполняет колонку для досок, уже покинувших collect", () => {
  it("REQ-006 кр.3, code-review: доска в фазе не-collect с несколькими строками ops получает reveal_seq = max(seq), доска в collect остаётся NULL", async () => {
    const revealedBoardId = await insertBoard("group");
    const seqA = await insertOp(revealedBoardId, 1);
    const seqB = await insertOp(revealedBoardId, 2);
    const seqC = await insertOp(revealedBoardId, 3);
    const expectedMaxSeq = Math.max(seqA, seqB, seqC);
    await markAsNotYetBackfilled(revealedBoardId);

    const collectBoardId = await insertBoard("collect");
    await insertOp(collectBoardId, 1);
    await markAsNotYetBackfilled(collectBoardId);

    const statements = backfillStatementsFrom0008();
    for (const statement of statements) {
      await pool.query(statement);
    }

    expect(await revealSeqOf(revealedBoardId)).toBe(expectedMaxSeq);
    expect(await revealSeqOf(collectBoardId)).toBeNull();
  });

  it("REQ-006 кр.3, code-review: доска в фазе не-collect без строк ops получает reveal_seq = 0 после миграции", async () => {
    const revealedEmptyBoardId = await insertBoard("vote");
    await markAsNotYetBackfilled(revealedEmptyBoardId);

    const statements = backfillStatementsFrom0008();
    for (const statement of statements) {
      await pool.query(statement);
    }

    expect(await revealSeqOf(revealedEmptyBoardId)).toBe(0);
  });
});
