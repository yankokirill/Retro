// Самопроверка контрактного набора (задача 2 T-024, test-author): пока ни
// `PgBoardStore`, ни `MemoryBoardStore` (T-025) не существуют,
// `store-contract.ts` нельзя прогнать вообще — а значит нельзя быть
// уверенным, что сам набор не содержит ошибку. `ReferenceBoardStore` —
// маленькая, заведомо корректная in-memory реализация порта `BoardStore`
// «в лоб» (массив строк журнала + `Map` для досок/участников/авторов/
// снапшотов), без претензии на прод-качество — это НЕ `MemoryBoardStore`
// T-025, только чтобы прогнать `describeBoardStoreContract` прямо сейчас.
//
// Эта часть ОБЯЗАНА быть зелёной уже сейчас: красный прогон здесь означает
// баг в контрактном наборе или в этой эталонной реализации, а не
// «ожидаемую красноту до реализации» (в отличие от board-server.test.ts).

import type { Dot, EntityId, State, WireDelta } from "@retro/crdt";
import { empty, fromWire, merge } from "@retro/crdt";
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
} from "../src/store.js";
import { type BoardStoreContractSetup, describeBoardStoreContract } from "./store-contract.js";

interface LogRow {
  readonly seq: number;
  readonly boardId: string;
  readonly actor: string | null;
  readonly counter: number | null;
  readonly lamport: number | null;
  readonly delta: WireDelta;
}

interface BoardRow {
  title: string;
  ownerId: string;
  phase: Phase;
  voteLimit: number;
  revealSeq: number | null;
}

interface MemberRow {
  role: Role;
  displayName?: string;
}

class ReferenceBoardStore implements BoardStore {
  private readonly boards = new Map<string, BoardRow>();
  private readonly members = new Map<string, Map<string, MemberRow>>();
  private readonly log: LogRow[] = [];
  private readonly authorsByBoard = new Map<string, Map<EntityId, string>>();
  private readonly snapshots = new Map<string, SnapshotRecord>();
  private nextSeq = 1;

  async board(boardId: string): Promise<BoardRecord | null> {
    const row = this.boards.get(boardId);
    if (!row) return null;
    return {
      id: boardId,
      title: row.title,
      ownerId: row.ownerId,
      phase: row.phase,
      voteLimit: row.voteLimit,
      revealSeq: row.revealSeq,
    };
  }

  async memberRole(boardId: string, guestId: string): Promise<Role | null> {
    return this.members.get(boardId)?.get(guestId)?.role ?? null;
  }

  async updatePhase(boardId: string, phase: Phase, revealSeq: number | null): Promise<void> {
    const row = this.boards.get(boardId);
    if (!row) throw new Error(`ReferenceBoardStore.updatePhase: unknown board ${boardId}`);
    row.phase = phase;
    row.revealSeq = revealSeq;
  }

  async findOpSeq(boardId: string, dot: Dot): Promise<number | null> {
    const row = this.log.find(
      (entry) =>
        entry.boardId === boardId && entry.actor === dot.actor && entry.counter === dot.counter,
    );
    return row?.seq ?? null;
  }

  async findUnvoteSeq(boardId: string, voteDot: Dot, target: EntityId): Promise<number | null> {
    const row = this.log.find(
      (entry) =>
        entry.boardId === boardId &&
        entry.delta.unvotes.some(
          (unvote) =>
            unvote.dot.actor === voteDot.actor &&
            unvote.dot.counter === voteDot.counter &&
            unvote.target === target,
        ),
    );
    return row?.seq ?? null;
  }

  async actorClock(boardId: string, actor: string): Promise<ActorClock> {
    let lastCounter = 0;
    let lastLamport = 0;
    let boardMaxLamport = 0;
    for (const row of this.log) {
      if (row.boardId !== boardId) continue;
      if (row.lamport !== null && row.lamport > boardMaxLamport) boardMaxLamport = row.lamport;
      if (row.actor === actor) {
        if (row.counter !== null && row.counter > lastCounter) lastCounter = row.counter;
        if (row.lamport !== null && row.lamport > lastLamport) lastLamport = row.lamport;
      }
    }
    return { lastCounter, lastLamport, boardMaxLamport };
  }

  async opsSince(boardId: string, sinceSeq: number): Promise<OpRow[]> {
    return this.log
      .filter((row) => row.boardId === boardId && row.seq > sinceSeq)
      .sort((a, b) => a.seq - b.seq)
      .map((row) => ({ seq: row.seq, delta: row.delta }));
  }

  async opsUpTo(boardId: string, uptoSeq: number): Promise<OpRow[]> {
    return this.log
      .filter((row) => row.boardId === boardId && row.seq <= uptoSeq)
      .sort((a, b) => a.seq - b.seq)
      .map((row) => ({ seq: row.seq, delta: row.delta }));
  }

  async lastSeq(boardId: string): Promise<number> {
    const seqs = this.log.filter((row) => row.boardId === boardId).map((row) => row.seq);
    return seqs.length === 0 ? 0 : Math.max(...seqs);
  }

  async latestSnapshot(boardId: string): Promise<SnapshotRecord | null> {
    return this.snapshots.get(boardId) ?? null;
  }

  async currentState(boardId: string): Promise<ReplayResult> {
    let state: State = empty();
    let uptoSeq = 0;
    const rows = this.log.filter((row) => row.boardId === boardId).sort((a, b) => a.seq - b.seq);
    for (const row of rows) {
      state = merge(state, fromWire(row.delta));
      uptoSeq = row.seq;
    }
    return { state, uptoSeq };
  }

  async authors(boardId: string): Promise<ReadonlyMap<EntityId, string>> {
    return new Map(this.authorsByBoard.get(boardId) ?? new Map<EntityId, string>());
  }

  async authorDisplayNames(boardId: string): Promise<Record<EntityId, string>> {
    const result: Record<EntityId, string> = {};
    const authors = this.authorsByBoard.get(boardId);
    if (!authors) return result;
    const members = this.members.get(boardId);
    for (const [entityId, guestId] of authors) {
      const displayName = members?.get(guestId)?.displayName;
      if (displayName !== undefined) result[entityId] = displayName;
    }
    return result;
  }

  async transaction<T>(fn: (tx: BoardStoreTx) => Promise<T>): Promise<T> {
    const pendingLog: LogRow[] = [];
    const pendingAuthors: Array<{ boardId: string; entityId: EntityId; guestId: string }> = [];
    let seqCursor = this.nextSeq;

    const tx: BoardStoreTx = {
      appendOp: async (params: AppendOpParams): Promise<AppendOpResult> => {
        if (params.dot !== null) {
          const existing =
            this.log.find(
              (row) =>
                row.boardId === params.boardId &&
                row.actor === params.dot?.actor &&
                row.counter === params.dot?.counter,
            ) ??
            pendingLog.find(
              (row) =>
                row.boardId === params.boardId &&
                row.actor === params.dot?.actor &&
                row.counter === params.dot?.counter,
            );
          if (existing) return { seq: existing.seq };
        }
        const seq = seqCursor;
        seqCursor += 1;
        pendingLog.push({
          seq,
          boardId: params.boardId,
          actor: params.dot?.actor ?? null,
          counter: params.dot?.counter ?? null,
          lamport: params.lamport,
          delta: params.delta,
        });
        return { seq };
      },
      recordAuthor: async (boardId: string, entityId: EntityId, guestId: string): Promise<void> => {
        pendingAuthors.push({ boardId, entityId, guestId });
      },
    };

    // Если fn бросает — код ниже не выполняется, pendingLog/pendingAuthors
    // отбрасываются вместе со стеком; ничего не попадает в this.log/authors.
    const result = await fn(tx);

    this.log.push(...pendingLog);
    this.nextSeq = seqCursor;
    for (const { boardId, entityId, guestId } of pendingAuthors) {
      const map = this.authorsByBoard.get(boardId) ?? new Map<EntityId, string>();
      // First-writer-wins (SIM-03: расхождение с Postgres из T-025 design
      // § 3.4 — `onConflictDoNothing` там же): повторная запись автора той
      // же сущности не переписывает уже зафиксированного автора.
      if (!map.has(entityId)) map.set(entityId, guestId);
      this.authorsByBoard.set(boardId, map);
    }
    return result;
  }

  // Хелперы только для контрактного набора (не часть порта BoardStore) —
  // заводят доску/участника/снапшот "напрямую в базу", минуя протокол WS.
  seedBoard(board: {
    id: string;
    title: string;
    ownerId: string;
    phase: Phase;
    voteLimit: number;
  }): void {
    this.boards.set(board.id, {
      title: board.title,
      ownerId: board.ownerId,
      phase: board.phase,
      voteLimit: board.voteLimit,
      revealSeq: null,
    });
  }

  seedMember(boardId: string, guestId: string, role: Role, displayName?: string): void {
    const map = this.members.get(boardId) ?? new Map<string, MemberRow>();
    map.set(guestId, { role, displayName });
    this.members.set(boardId, map);
  }

  seedSnapshot(boardId: string, snapshot: SnapshotRecord): void {
    this.snapshots.set(boardId, snapshot);
  }

  // Новая сигнатура `BoardStoreContractSetup.saveSnapshot` (T-025 design
  // § 3.4 уточнение 3) не приносит готовый `SnapshotRecord` — она снимает
  // снапшот с того, что уже накоплено в хранилище, на его текущем `seq`.
  async saveSnapshot(boardId: string): Promise<void> {
    const { state } = await this.currentState(boardId);
    const uptoSeq = await this.lastSeq(boardId);
    this.seedSnapshot(boardId, { uptoSeq, state });
  }
}

const setup: BoardStoreContractSetup = {
  async createBoard(store, board) {
    (store as ReferenceBoardStore).seedBoard(board);
  },
  async addMember(store, boardId, guestId, role, displayName) {
    (store as ReferenceBoardStore).seedMember(boardId, guestId, role, displayName);
  },
  async saveSnapshot(store, boardId) {
    await (store as ReferenceBoardStore).saveSnapshot(boardId);
  },
};

describeBoardStoreContract("reference (smoke)", () => new ReferenceBoardStore(), setup);
