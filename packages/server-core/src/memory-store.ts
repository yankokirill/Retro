// T-025 (docs/design/T-005-simulator.md § 3.4). `MemoryBoardStore` —
// адаптер порта `BoardStore` в памяти: та же контрактная логика, что
// `PgBoardStore` (T-024), без БД — для `packages/sim` (T-005, детерминизм
// и скорость) и для `test:unit` (SIM-03: контрактный набор зелёный на
// обоих адаптерах). Помимо порта несёт настройку мира (доска/участники —
// вне протокола WS, REST в симуляторе не моделируется) и управляемые
// неисправности/наблюдение для оракула и тестов.

import type { Dot, EntityId, State, WireDelta } from "@retro/crdt";
import { compact, empty, fromWire, merge } from "@retro/crdt";
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
} from "./store.js";

export interface MemoryBoardStore extends BoardStore {
  /**
   * Заводит доску и сразу владельца в участниках с ролью `owner`
   * (как `boardsService.createBoard`, apps/server) — отдельного вызова
   * `addMember` для владельца не нужно.
   */
  createBoard(input: {
    readonly id: string;
    readonly title: string;
    readonly ownerId: string;
    readonly ownerName: string;
    readonly voteLimit: number;
  }): void;
  addMember(boardId: string, guestId: string, role: Role, displayName: string): void;
  /** E8 (docs/spec/simulator.md § 4.2): снапшот текущего состояния доски на её `lastSeq`. */
  saveSnapshot(boardId: string): void;
  /**
   * E9: следующая транзакция (`tx.appendOp`/`tx.recordAuthor`) хранилища
   * падает после `afterWrites`-й успешной записи в её буфер, ничего не
   * применив; если записей в транзакции меньше — падает при попытке
   * зафиксироваться. Неисправность одноразовая.
   */
  failNextTransaction(afterWrites: number): void;
  /** Сырые строки журнала доски, по возрастанию `seq` — для оракула симулятора. */
  log(boardId: string): readonly OpRow[];
  /**
   * Дешёвые аналоги `log()` для симулятора (T-005): `log()` копирует весь журнал,
   * а проверкам на каждое сообщение нужны число строк, хвост и строка по `seq`.
   * Журнал только дописывается, `seq` по возрастанию.
   */
  logSize(boardId: string): number;
  /** Строки журнала начиная с позиции `index` (0 — весь журнал). */
  logFrom(boardId: string, index: number): readonly OpRow[];
  /** Строка журнала с данным `seq` или `null` (двоичный поиск). */
  opRowSync(boardId: string, seq: number): OpRow | null;
  /**
   * Синхронный аналог `board()` — только у адаптера в памяти (у Postgres
   * такого не может быть, поэтому вне порта `BoardStore`). Нужен
   * `packages/sim`: `checks.ts` объявлен синхронным (S2/S3/S4/... — не
   * `Promise`, см. `docs/design/T-005-simulator.md` § 5.5), а свойства
   * доски вроде `voteLimit` не меняются после создания — их можно
   * прочитать разом с миром, не дожидаясь `await`.
   */
  boardSync(boardId: string): BoardRecord | null;
  /** Синхронный аналог `latestSnapshot()` — тот же повод, что `boardSync` (S8). */
  latestSnapshotSync(boardId: string): SnapshotRecord | null;
  /** Синхронный аналог `currentState()` — тот же повод, что `boardSync` (S8). */
  currentStateSync(boardId: string): ReplayResult;
}

export interface MemoryBoardStoreOptions {
  /** Пропуск seq перед следующей записью (≥ 0); единственный источник «случайности» — передаётся симулятором. */
  readonly seqGap?: () => number;
}

// ---------------------------------------------------------------------------
// Внутреннее представление.

interface InternalRow {
  readonly seq: number;
  readonly boardId: string;
  readonly actor: string | null;
  readonly counter: number | null;
  readonly lamport: number | null;
  readonly delta: WireDelta;
}

interface MemberRecord {
  readonly role: Role;
  readonly displayName: string;
}

interface ActorClockState {
  lastCounter: number;
  lastLamport: number;
}

interface BoardEntry {
  record: {
    title: string;
    ownerId: string;
    phase: Phase;
    voteLimit: number;
    revealSeq: number | null;
  };
  readonly members: Map<string, MemberRecord>;
  /** entityId -> guestId; первый писатель побеждает (как `onConflictDoNothing` в Postgres). */
  readonly authors: Map<EntityId, string>;
  /** По возрастанию `seq` всегда — вставка через `insertSortedBySeq`, не голый `push`. */
  readonly rows: InternalRow[];
  /** `(actor,counter)` -> seq — идемпотентность V1, только для строк с dot !== null. */
  readonly opIndex: Map<string, number>;
  /** `(voteDot.actor,voteDot.counter,target)` -> seq первого вхождения — идемпотентность unvote (ADR-0008). */
  readonly unvoteIndex: Map<string, number>;
  readonly actorClocks: Map<string, ActorClockState>;
  boardMaxLamport: number;
  snapshot: SnapshotRecord | null;
  /**
   * Кэш `computeCurrentState`: свёртка `snapshot ⊔ rows[0..folded)`. Строки
   * только дописываются в хвост (seq выдаётся при коммите монотонно) и не
   * удаляются, поэтому достаточно досвернуть `rows[folded..)`; смена
   * `snapshot` кэш обнуляет. Сервер зовёт `currentState` на каждую операцию —
   * без кэша это O(n) слияний на каждую, O(n²) на прогон.
   */
  current: {
    readonly base: SnapshotRecord | null;
    state: State;
    folded: number;
    uptoSeq: number;
  } | null;
}

interface PendingFault {
  readonly afterWrites: number;
}

function opKey(actor: string, counter: number): string {
  return `${actor}:${counter}`;
}

function unvoteKey(actor: string, counter: number, target: EntityId): string {
  return `${actor}:${counter}:${target}`;
}

/** Вставляет `row` в позицию, сохраняющую сортировку `rows` по `seq` (обычно — в конец). */
function insertSortedBySeq(rows: InternalRow[], row: InternalRow): void {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // biome-ignore lint/style/noNonNullAssertion: mid < hi <= rows.length внутри цикла
    if (rows[mid]!.seq < row.seq) lo = mid + 1;
    else hi = mid;
  }
  rows.splice(lo, 0, row);
}

/** Первый индекс `i`, при котором `rows[i].seq > seq` (или `rows.length`, если такого нет). */
function firstIndexAfter(rows: InternalRow[], seq: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // biome-ignore lint/style/noNonNullAssertion: mid < hi <= rows.length внутри цикла
    if (rows[mid]!.seq <= seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function toOpRow(row: InternalRow): OpRow {
  return { seq: row.seq, delta: row.delta };
}

function nextGap(seqGap: (() => number) | undefined): number {
  if (!seqGap) return 0;
  const gap = seqGap();
  if (!Number.isInteger(gap) || gap < 0) {
    throw new Error(`MemoryBoardStore: seqGap() must return a non-negative integer, got ${gap}`);
  }
  return gap;
}

// ---------------------------------------------------------------------------

class MemoryBoardStoreImpl implements MemoryBoardStore {
  private readonly boards = new Map<string, BoardEntry>();
  private readonly seqGap: (() => number) | undefined;
  private nextSeq = 1;
  private fault: PendingFault | null = null;

  constructor(options?: MemoryBoardStoreOptions) {
    this.seqGap = options?.seqGap;
  }

  private getEntry(boardId: string): BoardEntry | undefined {
    return this.boards.get(boardId);
  }

  /** Как внешний ключ в Postgres: запись в несуществующую доску — исключение, не молчаливый no-op. */
  private requireEntry(boardId: string): BoardEntry {
    const entry = this.boards.get(boardId);
    if (!entry) throw new Error(`MemoryBoardStore: unknown board ${boardId}`);
    return entry;
  }

  // --- Настройка мира -------------------------------------------------

  createBoard(input: {
    readonly id: string;
    readonly title: string;
    readonly ownerId: string;
    readonly ownerName: string;
    readonly voteLimit: number;
  }): void {
    const entry: BoardEntry = {
      record: {
        title: input.title,
        ownerId: input.ownerId,
        phase: "collect",
        voteLimit: input.voteLimit,
        revealSeq: null,
      },
      members: new Map(),
      authors: new Map(),
      rows: [],
      opIndex: new Map(),
      unvoteIndex: new Map(),
      actorClocks: new Map(),
      boardMaxLamport: 0,
      snapshot: null,
      current: null,
    };
    entry.members.set(input.ownerId, { role: "owner", displayName: input.ownerName });
    this.boards.set(input.id, entry);
  }

  addMember(boardId: string, guestId: string, role: Role, displayName: string): void {
    this.requireEntry(boardId).members.set(guestId, { role, displayName });
  }

  saveSnapshot(boardId: string): void {
    const entry = this.requireEntry(boardId);
    const { state, uptoSeq } = this.computeCurrentState(entry);
    entry.snapshot = { uptoSeq, state: compact(state) };
  }

  failNextTransaction(afterWrites: number): void {
    this.fault = { afterWrites };
  }

  log(boardId: string): readonly OpRow[] {
    const entry = this.getEntry(boardId);
    return entry ? entry.rows.map(toOpRow) : [];
  }

  logSize(boardId: string): number {
    return this.getEntry(boardId)?.rows.length ?? 0;
  }

  logFrom(boardId: string, index: number): readonly OpRow[] {
    const entry = this.getEntry(boardId);
    return entry ? entry.rows.slice(index).map(toOpRow) : [];
  }

  opRowSync(boardId: string, seq: number): OpRow | null {
    const rows = this.getEntry(boardId)?.rows;
    if (!rows) return null;
    const index = firstIndexAfter(rows, seq - 1);
    const row = rows[index];
    return row && row.seq === seq ? toOpRow(row) : null;
  }

  // --- Порт BoardStore: чтение -----------------------------------------

  async board(boardId: string): Promise<BoardRecord | null> {
    return this.boardSync(boardId);
  }

  boardSync(boardId: string): BoardRecord | null {
    const entry = this.getEntry(boardId);
    if (!entry) return null;
    return { id: boardId, ...entry.record };
  }

  async memberRole(boardId: string, guestId: string): Promise<Role | null> {
    return this.getEntry(boardId)?.members.get(guestId)?.role ?? null;
  }

  async findOpSeq(boardId: string, dot: Dot): Promise<number | null> {
    const entry = this.getEntry(boardId);
    return entry?.opIndex.get(opKey(dot.actor, dot.counter)) ?? null;
  }

  async findUnvoteSeq(boardId: string, voteDot: Dot, target: EntityId): Promise<number | null> {
    const entry = this.getEntry(boardId);
    return entry?.unvoteIndex.get(unvoteKey(voteDot.actor, voteDot.counter, target)) ?? null;
  }

  async actorClock(boardId: string, actor: string): Promise<ActorClock> {
    const entry = this.getEntry(boardId);
    const clock = entry?.actorClocks.get(actor);
    return {
      lastCounter: clock?.lastCounter ?? 0,
      lastLamport: clock?.lastLamport ?? 0,
      boardMaxLamport: entry?.boardMaxLamport ?? 0,
    };
  }

  async opsSince(boardId: string, sinceSeq: number): Promise<OpRow[]> {
    const entry = this.getEntry(boardId);
    if (!entry) return [];
    return entry.rows.slice(firstIndexAfter(entry.rows, sinceSeq)).map(toOpRow);
  }

  async opsUpTo(boardId: string, uptoSeq: number): Promise<OpRow[]> {
    const entry = this.getEntry(boardId);
    if (!entry) return [];
    return entry.rows.slice(0, firstIndexAfter(entry.rows, uptoSeq)).map(toOpRow);
  }

  async lastSeq(boardId: string): Promise<number> {
    const entry = this.getEntry(boardId);
    if (!entry || entry.rows.length === 0) return 0;
    // biome-ignore lint/style/noNonNullAssertion: length > 0 только что проверена
    return entry.rows[entry.rows.length - 1]!.seq;
  }

  async latestSnapshot(boardId: string): Promise<SnapshotRecord | null> {
    return this.latestSnapshotSync(boardId);
  }

  /** Синхронный аналог `latestSnapshot()` — см. `boardSync`, тот же повод (S8, `packages/sim`). */
  latestSnapshotSync(boardId: string): SnapshotRecord | null {
    return this.getEntry(boardId)?.snapshot ?? null;
  }

  /**
   * T-025 design § 3.4 уточнение 1: `compact(снапшот) ⊔ хвост`, как
   * `PgBoardStore.currentState` (`replayFromSnapshot`) — не инкрементальный
   * `merge` с начала журнала. После `saveSnapshot`/E8 поведение приёма
   * операций в памяти и на Postgres должно совпадать именно в этой точке.
   */
  async currentState(boardId: string): Promise<ReplayResult> {
    return this.currentStateSync(boardId);
  }

  /** Синхронный аналог `currentState()` — см. `boardSync`, тот же повод (S8, `packages/sim`). */
  currentStateSync(boardId: string): ReplayResult {
    const entry = this.requireEntry(boardId);
    return this.computeCurrentState(entry);
  }

  private computeCurrentState(entry: BoardEntry): ReplayResult {
    let cache = entry.current;
    if (cache === null || cache.base !== entry.snapshot) {
      const baseline = entry.snapshot?.uptoSeq ?? 0;
      cache = {
        base: entry.snapshot,
        state: entry.snapshot?.state ?? empty(),
        folded: firstIndexAfter(entry.rows, baseline),
        uptoSeq: baseline,
      };
      entry.current = cache;
    }
    for (; cache.folded < entry.rows.length; cache.folded++) {
      // biome-ignore lint/style/noNonNullAssertion: folded < rows.length
      const row = entry.rows[cache.folded]!;
      cache.state = merge(cache.state, fromWire(row.delta));
      cache.uptoSeq = row.seq;
    }
    return { state: cache.state, uptoSeq: cache.uptoSeq };
  }

  async authors(boardId: string): Promise<ReadonlyMap<EntityId, string>> {
    return new Map(this.getEntry(boardId)?.authors ?? []);
  }

  async authorDisplayNames(boardId: string): Promise<Record<EntityId, string>> {
    const entry = this.getEntry(boardId);
    const result: Record<EntityId, string> = {};
    if (!entry) return result;
    for (const [entityId, guestId] of entry.authors) {
      const displayName = entry.members.get(guestId)?.displayName;
      if (displayName !== undefined) result[entityId] = displayName;
    }
    return result;
  }

  // --- Порт BoardStore: запись ------------------------------------------

  async updatePhase(boardId: string, phase: Phase, revealSeq: number | null): Promise<void> {
    const entry = this.requireEntry(boardId);
    entry.record = { ...entry.record, phase, revealSeq };
  }

  async transaction<T>(fn: (tx: BoardStoreTx) => Promise<T>): Promise<T> {
    // Одноразовая неисправность (E9): consумируется этой попыткой целиком,
    // независимо от исхода — следующий вызов transaction() её уже не застаёт.
    const currentFault = this.fault;
    this.fault = null;
    let faultTriggered = false;
    let writesSoFar = 0;

    const pendingRows: InternalRow[] = [];
    const pendingAuthors: { boardId: string; entityId: EntityId; guestId: string }[] = [];

    const checkFault = (): void => {
      writesSoFar += 1;
      if (currentFault && !faultTriggered && writesSoFar === currentFault.afterWrites + 1) {
        faultTriggered = true;
        throw new Error(
          `MemoryBoardStore: injected transaction failure after ${currentFault.afterWrites} writes (E9)`,
        );
      }
    };

    const tx: BoardStoreTx = {
      appendOp: async (params: AppendOpParams): Promise<AppendOpResult> => {
        const entry = this.requireEntry(params.boardId);
        // V1 (REQ-023 кр.3): идемпотентность по (actor, counter) — только
        // для dot !== null; unvote (dot === null) не дедуплицируется вовсе.
        if (params.dot !== null) {
          const key = opKey(params.dot.actor, params.dot.counter);
          const committedSeq = entry.opIndex.get(key);
          if (committedSeq !== undefined) return { seq: committedSeq };
          const pendingHit = pendingRows.find(
            (row) => row.actor === params.dot?.actor && row.counter === params.dot?.counter,
          );
          if (pendingHit) return { seq: pendingHit.seq };
        }

        // seq выделяется здесь, а не при фиксации — как nextval у bigserial
        // в Postgres: даже если эта транзакция упадёт (в т.ч. из-за этой же
        // записи, checkFault ниже), номер не возвращается в оборот.
        const seq = this.nextSeq;
        this.nextSeq = seq + 1 + nextGap(this.seqGap);
        const row: InternalRow = {
          seq,
          boardId: params.boardId,
          actor: params.dot?.actor ?? null,
          counter: params.dot?.counter ?? null,
          lamport: params.lamport,
          delta: params.delta,
        };
        pendingRows.push(row);
        checkFault();
        return { seq };
      },
      recordAuthor: async (boardId: string, entityId: EntityId, guestId: string): Promise<void> => {
        this.requireEntry(boardId);
        pendingAuthors.push({ boardId, entityId, guestId });
        checkFault();
      },
    };

    const result = await fn(tx);

    // Неисправность была взведена, но ни одна запись до её порога не
    // дотянула (буфер короче afterWrites+1, T-025 design § 3.4 уточнение 2)
    // — транзакция всё равно падает при попытке зафиксироваться, не применив
    // ничего из буфера.
    if (currentFault && !faultTriggered) {
      throw new Error(
        `MemoryBoardStore: injected transaction failure after ${currentFault.afterWrites} writes ` +
          "(fewer writes than required — failing at commit, E9)",
      );
    }

    for (const row of pendingRows) {
      const entry = this.requireEntry(row.boardId);
      insertSortedBySeq(entry.rows, row);
      if (row.actor !== null && row.counter !== null) {
        entry.opIndex.set(opKey(row.actor, row.counter), row.seq);
      }
      for (const unvote of row.delta.unvotes) {
        const key = unvoteKey(unvote.dot.actor, unvote.dot.counter, unvote.target);
        if (!entry.unvoteIndex.has(key)) entry.unvoteIndex.set(key, row.seq);
      }
      if (row.actor !== null) {
        const clock = entry.actorClocks.get(row.actor) ?? { lastCounter: 0, lastLamport: 0 };
        if (row.counter !== null && row.counter > clock.lastCounter)
          clock.lastCounter = row.counter;
        if (row.lamport !== null && row.lamport > clock.lastLamport)
          clock.lastLamport = row.lamport;
        entry.actorClocks.set(row.actor, clock);
      }
      if (row.lamport !== null && row.lamport > entry.boardMaxLamport) {
        entry.boardMaxLamport = row.lamport;
      }
    }
    for (const { boardId, entityId, guestId } of pendingAuthors) {
      const entry = this.requireEntry(boardId);
      // First-writer-wins (SIM-03: `onConflictDoNothing` в Postgres).
      if (!entry.authors.has(entityId)) entry.authors.set(entityId, guestId);
    }

    return result;
  }
}

export function createMemoryBoardStore(options?: MemoryBoardStoreOptions): MemoryBoardStore {
  return new MemoryBoardStoreImpl(options);
}
