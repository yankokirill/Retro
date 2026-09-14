// T-008 — «Журнал операций и снапшоты»: приёмочные тесты для контракта
// `apps/server/src/ops/log.ts` (docs/spec/requirements.md REQ-023 кр. 3,
// REQ-027; docs/spec/consistency-model.md § 6 — Log, X_S(n), replay,
// compact, snapshot, восстановление; § 8 — I5; § 9 — доказательство Т6).
//
// `appendOp`/`opsSince`/`replay`/`replayFromSnapshot`/`loadLatestSnapshot`/
// `saveSnapshot` в `apps/server/src/ops/log.ts` сейчас — заглушки (см.
// контракт, приведённый в задаче T-008). Каждый вызов ниже поэтому либо
// бросает `Error: ...: not implemented`, либо (если заглушка ничего не
// пишет в БД) возвращает пустой/несогласованный результат — тесты падают
// из-за отсутствия реализации, а не из-за ошибки в самом тесте.
//
// Все состояния/дельты собираются ТОЛЬКО через публичный API `@retro/crdt`
// (`empty`, `merge`, `newClock`, `createSticker`, `editText`, `move`,
// `deleteEntity`, `restoreEntity`, `vote`, `unvote`, `materialize`,
// `compact`, `toWire`, `dotKey`, `activeVotes`) — внутренности
// `apps/server/src` (кроме `db/schema.ts`/`ops/log.ts`, чей контракт дан в
// задаче verbatim) не читались.

import {
  activeVotes,
  type CardView,
  compact,
  createSticker,
  type Delta,
  type Dot,
  deleteEntity,
  dotKey,
  editText,
  empty,
  type GroupView,
  type Item,
  materialize,
  merge,
  move,
  newClock,
  restoreEntity,
  type State,
  toWire,
  unvote,
  type View,
  vote,
} from "@retro/crdt";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import fc from "fast-check";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { foldDeltas, scenarioArb } from "../../../packages/crdt/test/arbitraries.js";
import * as schema from "../src/db/schema.js";
import { boards } from "../src/db/schema.js";
import {
  appendOp,
  loadLatestSnapshot,
  opsSince,
  replay,
  replayFromSnapshot,
  saveSnapshot,
} from "../src/ops/log.js";

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

async function newBoard(): Promise<string> {
  const [row] = await db
    .insert(boards)
    .values({ title: "T-008 test board", ownerId: crypto.randomUUID() })
    .returning({ id: boards.id });
  if (!row) throw new Error("newBoard: insert returned no row");
  return row.id;
}

/**
 * Оборачивает `appendOp` для дельты с собственным dot (create/write/vote —
 * §3.1). Метка берётся из первой записи `entries` (все записи одной
 * операции несут одну и ту же метку, §3.1); у `vote` записей в `entries`
 * нет, поэтому лямпорт автоматически получается `null`, как и требует
 * контракт.
 */
async function appendWithDot(boardId: string, delta: State, dot: Dot): Promise<{ seq: number }> {
  const lamport = [...delta.entries.values()][0]?.stamp.lamport ?? null;
  return appendOp(db, { boardId, dot, lamport, delta: toWire(delta) });
}

/** unvote (§3.1) — своего dot не имеет: dot/lamport всегда null (см. контракт AppendOpParams). */
async function appendUnvote(boardId: string, delta: Delta): Promise<{ seq: number }> {
  return appendOp(db, { boardId, dot: null, lamport: null, delta: toWire(delta) });
}

// ---------------------------------------------------------------------------
// Снимок View как обычных данных для сравнения — локальная копия паттерна
// из materialize.test.ts/compact.test.ts, не импорт (T-008 пишет свой файл).
// ---------------------------------------------------------------------------

function isGroup(item: Item): item is GroupView {
  return "cards" in item;
}

function viewSnapshot(view: View) {
  const summarizeCard = (card: CardView) => ({
    kind: "card" as const,
    id: card.id,
    text: [...card.text],
    conflict: card.conflict,
    color: card.color,
    votes: card.votes,
  });
  const summarizeItem = (item: Item) =>
    isGroup(item)
      ? {
          kind: "group" as const,
          id: item.id,
          title: [...item.title],
          conflict: item.conflict,
          votes: item.votes,
          cards: item.cards.map(summarizeCard),
        }
      : summarizeCard(item);

  const columns: Record<string, unknown[]> = {};
  for (const column of ["start", "stop", "continue"] as const) {
    columns[column] = (view.columns.get(column) ?? []).map(summarizeItem);
  }
  return {
    columns,
    trash: [...view.trash].sort(),
    actions: view.actions.map((a) => ({
      id: a.id,
      text: [...a.text],
      conflict: a.conflict,
      assignee: a.assignee,
      done: a.done,
    })),
  };
}

// ---------------------------------------------------------------------------
// REQ-023 кр.3 — идемпотентность appendOp по (board, actor, counter)
// ---------------------------------------------------------------------------

describe("REQ-023 кр.3: appendOp идемпотентен по (board, actor, counter)", () => {
  it("REQ-023 кр.3: повторная отправка одной и той же операции не создаёт вторую строку журнала", async () => {
    const boardId = await newBoard();
    const created = createSticker(empty(), newClock("actor-dup"), {
      column: "start",
      frac: "1",
      text: "hello",
      color: "yellow",
    });

    const first = await appendWithDot(boardId, created.delta, created.dot);
    const second = await appendWithDot(boardId, created.delta, created.dot);

    expect(second.seq).toBe(first.seq);

    const rows = await opsSince(db, boardId, 0);
    expect(rows.length).toBe(1);
    expect(rows[0]?.seq).toBe(first.seq);
    expect(rows[0]?.delta.created).toHaveLength(1);
    expect(rows[0]?.delta.created[0]?.id).toBe(dotKey(created.dot));
  });

  it("REQ-023 кр.3: дубль после нескольких других операций всё равно возвращает исходный seq и не удваивает журнал", async () => {
    const boardId = await newBoard();
    const created = createSticker(empty(), newClock("actor-dup-2"), {
      column: "start",
      frac: "1",
      text: "hello",
      color: "yellow",
    });
    const id = dotKey(created.dot);
    const { seq: createSeq } = await appendWithDot(boardId, created.delta, created.dot);

    const state = merge(empty(), created.delta);
    const edited = editText(state, created.clock, id, "world");
    await appendWithDot(boardId, edited.delta, edited.dot);

    // Повторная доставка исходной операции создания приходит позже других.
    const redelivered = await appendWithDot(boardId, created.delta, created.dot);
    expect(redelivered.seq).toBe(createSeq);

    const rows = await opsSince(db, boardId, 0);
    expect(rows.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// appendOp с dot === null (unvote): не требует дедупликации строк, но
// итоговое materialize/activeVotes не зависит от числа повторов (merge
// идемпотентен, I2.5).
// ---------------------------------------------------------------------------

describe("appendOp(dot: null) — unvote: без дедупликации строк, но безопасен для итогового состояния", () => {
  it("unvote применённый дважды через appendOp(dot: null) не падает и голос остаётся отозванным ровно один раз в materialize", async () => {
    const boardId = await newBoard();

    const created = createSticker(empty(), newClock("actor-vote-target"), {
      column: "start",
      frac: "1",
      text: "vote me",
      color: "yellow",
    });
    const id = dotKey(created.dot);
    await appendWithDot(boardId, created.delta, created.dot);

    let state = merge(empty(), created.delta);
    const voted = vote(state, newClock("voter-actor"), id, "user-1");
    state = merge(state, voted.delta);
    await appendWithDot(boardId, voted.delta, voted.dot);

    const unvoteDelta = unvote(state, voted.dot, id);

    const first = await appendUnvote(boardId, unvoteDelta);
    const second = await appendUnvote(boardId, unvoteDelta);
    expect(typeof first.seq).toBe("number");
    expect(typeof second.seq).toBe("number");

    const rows = await opsSince(db, boardId, 0);
    // §7 контракта: dedup строк журнала не гарантирован для dot === null —
    // обе доставки unvote должны остаться в журнале как отдельные строки,
    // в дополнение к create и vote.
    const unvoteRows = rows.filter((r) => r.delta.unvotes.length > 0);
    expect(unvoteRows.length).toBe(2);
    expect(rows.length).toBe(4);

    const replayed = await replay(db, boardId);
    // Голос отозван — активных голосов на эту сущность больше нет (I2.5),
    // независимо от того, что unvote был доставлен дважды.
    expect(activeVotes(replayed.state, id)).toHaveLength(0);

    const view = materialize(replayed.state);
    const card = view.columns.get("start")?.find((item) => item.id === id);
    expect(card?.votes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// REQ-027 / I5 — детерминированный сценарий: снапшот + хвост журнала равны
// полному replay, для нескольких точек разреза, включая границы.
// ---------------------------------------------------------------------------

describe("REQ-027 / I5: снапшот + хвост журнала на Postgres равны полному replay", () => {
  it("REQ-027: явный сценарий create → конкурентная правка текста → move → vote → delete → restore — снапшот в трёх точках разреза (включая границы) даёт то же materialize, что и полный replay", async () => {
    const boardId = await newBoard();

    const deltas: Delta[] = [];
    const dots: Dot[] = [];
    const seqs: number[] = [];
    const states: State[] = [empty()];

    const record = async (delta: Delta, dot: Dot) => {
      const { seq } = await appendWithDot(boardId, delta, dot);
      deltas.push(delta);
      dots.push(dot);
      seqs.push(seq);
      states.push(merge(states[states.length - 1] as State, delta));
    };

    const created = createSticker(empty(), newClock("actor-1"), {
      column: "start",
      frac: "1",
      text: "исходный текст",
      color: "yellow",
    });
    await record(created.delta, created.dot);
    const id = dotKey(created.dot);

    // Конкурентная правка текста от второго актора, не видевшего первую (REQ-007).
    const edited = editText(
      merge(empty(), created.delta),
      newClock("actor-2"),
      id,
      "правка от actor-2",
    );
    await record(edited.delta, edited.dot);

    const moved = move(states[2] as State, created.clock, id, { column: "stop", frac: "1" });
    await record(moved.delta, moved.dot);

    const voted = vote(states[3] as State, newClock("voter-1"), id, "user-1");
    await record(voted.delta, voted.dot);

    const deleted = deleteEntity(states[4] as State, moved.clock, id);
    await record(deleted.delta, deleted.dot);

    const restored = restoreEntity(states[5] as State, deleted.clock, id);
    await record(restored.delta, restored.dot);

    const n = deltas.length;
    const full = viewSnapshot(materialize((await replay(db, boardId)).state));

    for (const m of [0, 3, n]) {
      const uptoSeq = m === 0 ? 0 : (seqs[m - 1] as number);
      const snapshotState = states[m] as State;
      await saveSnapshot(db, boardId, uptoSeq, snapshotState);

      const fromSnapshot = await replayFromSnapshot(db, boardId);
      expect(fromSnapshot.uptoSeq).toBe(seqs[n - 1]);
      expect(viewSnapshot(materialize(fromSnapshot.state))).toEqual(full);

      const viaFullReplay = await replay(db, boardId);
      expect(viewSnapshot(materialize(viaFullReplay.state))).toEqual(full);
    }
  }, 60_000);
});

describe("REQ-027 / I5, property: replayFromSnapshot равен replay для случайной точки разреза", () => {
  it("REQ-027: property — для случайного сценария и случайного m, materialize(replayFromSnapshot) равен materialize(replay)", async () => {
    await fc.assert(
      fc.asyncProperty(
        scenarioArb("oplog-replay", { minOps: 1, maxOps: 10, minActors: 2, maxActors: 3 }).chain(
          (scenario) =>
            fc.tuple(fc.constant(scenario), fc.integer({ min: 0, max: scenario.deltas.length })),
        ),
        async ([scenario, m]) => {
          const boardId = await newBoard();
          const seqs: number[] = [];
          for (let i = 0; i < scenario.deltas.length; i++) {
            const delta = scenario.deltas[i] as State;
            const dot = scenario.dots[i] as Dot;
            const { seq } = await appendWithDot(boardId, delta, dot);
            seqs.push(seq);
          }

          const uptoSeq = m === 0 ? 0 : (seqs[m - 1] as number);
          const snapshotState = foldDeltas(scenario.deltas.slice(0, m));
          await saveSnapshot(db, boardId, uptoSeq, snapshotState);

          const full = viewSnapshot(materialize(scenario.merged));
          const fromSnapshot = await replayFromSnapshot(db, boardId);
          expect(viewSnapshot(materialize(fromSnapshot.state))).toEqual(full);

          const viaFullReplay = await replay(db, boardId);
          expect(viewSnapshot(materialize(viaFullReplay.state))).toEqual(full);
        },
      ),
      { numRuns: 20 },
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// opsSince — базовая корректность: только seq > sinceSeq, по возрастанию,
// не путает операции разных досок.
// ---------------------------------------------------------------------------

describe("opsSince: базовая корректность", () => {
  it("opsSince возвращает только seq > sinceSeq, по возрастанию seq", async () => {
    const boardId = await newBoard();
    const actorClock = newClock("actor-since");

    const first = createSticker(empty(), actorClock, {
      column: "start",
      frac: "1",
      text: "one",
      color: "yellow",
    });
    const { seq: seq1 } = await appendWithDot(boardId, first.delta, first.dot);

    const state1 = merge(empty(), first.delta);
    const second = createSticker(state1, first.clock, {
      column: "stop",
      frac: "1",
      text: "two",
      color: "green",
    });
    const { seq: seq2 } = await appendWithDot(boardId, second.delta, second.dot);

    const state2 = merge(state1, second.delta);
    const third = createSticker(state2, second.clock, {
      column: "continue",
      frac: "1",
      text: "three",
      color: "blue",
    });
    const { seq: seq3 } = await appendWithDot(boardId, third.delta, third.dot);

    const all = await opsSince(db, boardId, 0);
    expect(all.map((r) => r.seq)).toEqual([seq1, seq2, seq3]);

    const sinceFirst = await opsSince(db, boardId, seq1);
    expect(sinceFirst.map((r) => r.seq)).toEqual([seq2, seq3]);

    const sinceLast = await opsSince(db, boardId, seq3);
    expect(sinceLast).toEqual([]);
  });

  it("opsSince не путает операции разных досок", async () => {
    const boardA = await newBoard();
    const boardB = await newBoard();

    const opA = createSticker(empty(), newClock("actor-a"), {
      column: "start",
      frac: "1",
      text: "board A sticker",
      color: "yellow",
    });
    await appendWithDot(boardA, opA.delta, opA.dot);

    const opB = createSticker(empty(), newClock("actor-b"), {
      column: "start",
      frac: "1",
      text: "board B sticker",
      color: "pink",
    });
    await appendWithDot(boardB, opB.delta, opB.dot);

    const rowsA = await opsSince(db, boardA, 0);
    const rowsB = await opsSince(db, boardB, 0);

    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0]?.delta.created[0]?.id).toBe(dotKey(opA.dot));
    expect(rowsB[0]?.delta.created[0]?.id).toBe(dotKey(opB.dot));
  });
});

// ---------------------------------------------------------------------------
// loadLatestSnapshot: null без снапшотов; корректный снапшот после
// saveSnapshot; выбирает снапшот с максимальным uptoSeq среди нескольких.
// ---------------------------------------------------------------------------

describe("loadLatestSnapshot", () => {
  it("возвращает null, когда снапшотов для доски ещё нет", async () => {
    const boardId = await newBoard();
    expect(await loadLatestSnapshot(db, boardId)).toBeNull();
  });

  it("возвращает сохранённый снапшот после saveSnapshot", async () => {
    const boardId = await newBoard();
    const created = createSticker(empty(), newClock("actor-snap"), {
      column: "start",
      frac: "1",
      text: "snap me",
      color: "yellow",
    });
    const { seq } = await appendWithDot(boardId, created.delta, created.dot);

    const state = merge(empty(), created.delta);
    await saveSnapshot(db, boardId, seq, state);

    const loaded = await loadLatestSnapshot(db, boardId);
    expect(loaded).not.toBeNull();
    expect(loaded?.uptoSeq).toBe(seq);
    expect(viewSnapshot(materialize(loaded?.state as State))).toEqual(
      viewSnapshot(materialize(compact(state))),
    );
  });

  it("среди нескольких снапшотов возвращает тот, у которого максимальный uptoSeq", async () => {
    const boardId = await newBoard();

    const first = createSticker(empty(), newClock("actor-snap-2"), {
      column: "start",
      frac: "1",
      text: "one",
      color: "yellow",
    });
    const { seq: seq1 } = await appendWithDot(boardId, first.delta, first.dot);
    const state1 = merge(empty(), first.delta);

    const second = createSticker(state1, first.clock, {
      column: "stop",
      frac: "1",
      text: "two",
      color: "green",
    });
    const { seq: seq2 } = await appendWithDot(boardId, second.delta, second.dot);
    const state2 = merge(state1, second.delta);

    // Снапшоты сохраняются не по порядку (сначала больший seq, потом меньший) —
    // loadLatestSnapshot должен выбирать по uptoSeq, а не по порядку вставки строк.
    await saveSnapshot(db, boardId, seq2, state2);
    await saveSnapshot(db, boardId, seq1, state1);

    const loaded = await loadLatestSnapshot(db, boardId);
    expect(loaded?.uptoSeq).toBe(seq2);
    expect(viewSnapshot(materialize(loaded?.state as State))).toEqual(
      viewSnapshot(materialize(compact(state2))),
    );
  });
});
