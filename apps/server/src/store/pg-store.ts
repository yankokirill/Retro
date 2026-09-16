// T-024 (docs/design/T-005-simulator.md § 3.2, уточнение при реализации).
// Тонкий адаптер порта `BoardStore` (@retro/server-core) над Postgres: сами
// запросы остаются в `ops/log.ts`/`ops/authors.ts` (их использует напрямую
// `oplog.int.test.ts`/`boards.int.test.ts` — критерий готовности T-024
// требует не трогать существующие `test:int`), `PgBoardStore` только
// собирает их в объект по форме порта. `board`/`memberRole`/`updatePhase` —
// новые, прямые запросы к `boards`/`members` (в `boards/service.ts` для них
// нет отдельной функции такой формы — там всё завязано на «роль гостя»,
// не на голое чтение/запись доски).

import type { Dot, EntityId } from "@retro/crdt";
import type { Phase, Role } from "@retro/protocol";
import type {
  ActorClock,
  AppendOpParams,
  AppendOpResult,
  BoardRecord,
  BoardStore,
  BoardStoreTx,
  OpRow,
  ReplayResult,
  SnapshotRecord,
} from "@retro/server-core";
import { and, eq, isNull } from "drizzle-orm";
import { boards, members } from "../db/schema.js";
import { authorsDisplayNames, authorsForBoard, recordAuthor } from "../ops/authors.js";
import {
  actorClock,
  appendOp,
  type Db,
  findOp,
  findUnvoteSeq,
  loadLatestSnapshot,
  opsSince,
  opsUpTo,
  lastSeq as queryLastSeq,
  replayFromSnapshot,
} from "../ops/log.js";

export class PgBoardStore implements BoardStore {
  constructor(private readonly db: Db) {}

  async board(boardId: string): Promise<BoardRecord | null> {
    const [row] = await this.db
      .select({
        id: boards.id,
        title: boards.title,
        ownerId: boards.ownerId,
        phase: boards.phase,
        settings: boards.settings,
        revealSeq: boards.revealSeq,
      })
      .from(boards)
      .where(and(eq(boards.id, boardId), isNull(boards.deletedAt)));
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      ownerId: row.ownerId,
      phase: row.phase as Phase,
      voteLimit: row.settings.voteLimit,
      revealSeq: row.revealSeq,
    };
  }

  async memberRole(boardId: string, guestId: string): Promise<Role | null> {
    const [row] = await this.db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.boardId, boardId), eq(members.userId, guestId)));
    return (row?.role as Role | undefined) ?? null;
  }

  async updatePhase(boardId: string, phase: Phase, revealSeq: number | null): Promise<void> {
    await this.db.update(boards).set({ phase, revealSeq }).where(eq(boards.id, boardId));
  }

  async findOpSeq(boardId: string, dot: Dot): Promise<number | null> {
    const found = await findOp(this.db, boardId, dot.actor, dot.counter);
    return found?.seq ?? null;
  }

  findUnvoteSeq(boardId: string, voteDot: Dot, target: EntityId): Promise<number | null> {
    return findUnvoteSeq(this.db, boardId, voteDot, target);
  }

  actorClock(boardId: string, actor: string): Promise<ActorClock> {
    return actorClock(this.db, boardId, actor);
  }

  opsSince(boardId: string, sinceSeq: number): Promise<OpRow[]> {
    return opsSince(this.db, boardId, sinceSeq);
  }

  opsUpTo(boardId: string, uptoSeq: number): Promise<OpRow[]> {
    return opsUpTo(this.db, boardId, uptoSeq);
  }

  lastSeq(boardId: string): Promise<number> {
    return queryLastSeq(this.db, boardId);
  }

  latestSnapshot(boardId: string): Promise<SnapshotRecord | null> {
    return loadLatestSnapshot(this.db, boardId);
  }

  /** ≈ replay(журнал), I5 — снапшот + хвост дешевле полного replay, эквивалентно после materialize. */
  currentState(boardId: string): Promise<ReplayResult> {
    return replayFromSnapshot(this.db, boardId);
  }

  authors(boardId: string): Promise<ReadonlyMap<EntityId, string>> {
    return authorsForBoard(this.db, boardId);
  }

  authorDisplayNames(boardId: string): Promise<Record<EntityId, string>> {
    return authorsDisplayNames(this.db, boardId);
  }

  transaction<T>(fn: (tx: BoardStoreTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => {
      const boardStoreTx: BoardStoreTx = {
        appendOp: (params: AppendOpParams): Promise<AppendOpResult> => appendOp(tx, params),
        recordAuthor: (boardId: string, entityId: EntityId, guestId: string): Promise<void> =>
          recordAuthor(tx, boardId, entityId, guestId),
      };
      return fn(boardStoreTx);
    });
  }
}
