// T-024 (docs/design/T-005-simulator.md § 3.2). Порт `BoardStore` — только
// хранение: чтения и запись журнала/метаданных доски, без правил приёма
// (V1–V7, права, фазы — те живут в `rules/*` и в обработчиках `handlers/*`).
// Два адаптера реализуют этот же порт: `PgBoardStore` (apps/server,
// обёртка над существующими `ops/log.ts`/`ops/authors.ts`/`boards/service.ts`
// — их тела остаются на месте, см. уточнение в docs/design/T-005-simulator.md
// § 3.2) и `MemoryBoardStore` (T-025, packages/sim). Один и тот же
// контрактный набор (`test/store-contract.ts`, SIM-03) проверяет оба.

import type { Dot, EntityId, State, WireDelta } from "@retro/crdt";
import type { Phase, Role } from "@retro/protocol";

export interface BoardRecord {
  readonly id: string;
  readonly title: string;
  readonly ownerId: string;
  readonly phase: Phase;
  readonly voteLimit: number;
  /** T-026 (ВС-2 б): seq доски в момент первого ухода из collect; null — ещё collect. */
  readonly revealSeq: number | null;
  /** T-030: конец таймера обсуждения (ISO-8601, UTC); null — таймера нет. */
  readonly timerEndsAt: string | null;
}

export interface AppendOpParams {
  readonly boardId: string;
  /**
   * `null` — только для `unvote`: `Unvote.dot` в CRDT-модели (T-002) — dot
   * **отзываемого голоса**, не свежий dot самой операции отзыва (`unvote`
   * не тикает часы), поэтому у него нет собственной пары `(actor, counter)`
   * для идемпотентности на уровне журнала. Для всех остальных операций
   * (create/write/vote) — их собственный dot.
   */
  readonly dot: Dot | null;
  /** `null` — у `vote`/`unvote` метки нет (§ 3.1, 2P-set); для остальных операций — метка её записи. */
  readonly lamport: number | null;
  /** Ровно то, что несла одна операция (§ 3 `protocol.md`) — уже в проводном формате. */
  readonly delta: WireDelta;
}

export interface AppendOpResult {
  readonly seq: number;
}

export interface OpRow {
  readonly seq: number;
  readonly delta: WireDelta;
}

export interface ActorClock {
  /** `last_n(a)` (V1): наибольший `counter`, принятый для этого актора на этой доске; 0, если ни одного. */
  readonly lastCounter: number;
  /** `last_L(a)` (V5): наибольшая метка `lamport`, принятая для этого актора; 0, если ни одной (у vote/unvote её нет). */
  readonly lastLamport: number;
  /** `L_S` (V5): наибольшая метка `lamport`, принятая на доске вообще (любым актором); 0, если ни одной. */
  readonly boardMaxLamport: number;
}

export interface ReplayResult {
  readonly state: State;
  readonly uptoSeq: number;
}

export interface SnapshotRecord {
  readonly uptoSeq: number;
  readonly state: State;
}

export interface BoardStoreTx {
  appendOp(params: AppendOpParams): Promise<AppendOpResult>;
  recordAuthor(boardId: string, entityId: EntityId, guestId: string): Promise<void>;
}

export interface BoardStore {
  /** null — нет доски или она удалена. */
  board(boardId: string): Promise<BoardRecord | null>;
  memberRole(boardId: string, guestId: string): Promise<Role | null>;
  updatePhase(boardId: string, phase: Phase, revealSeq: number | null): Promise<void>;
  /** T-030: таймер обсуждения (`null` — сбросить). */
  setTimer(boardId: string, endsAt: string | null): Promise<void>;
  /** T-030: меняет роль существующего участника; для несуществующего — без эффекта. */
  setMemberRole(boardId: string, guestId: string, role: Role): Promise<void>;

  findOpSeq(boardId: string, dot: Dot): Promise<number | null>;
  findUnvoteSeq(boardId: string, voteDot: Dot, target: EntityId): Promise<number | null>;
  actorClock(boardId: string, actor: string): Promise<ActorClock>;
  opsSince(boardId: string, sinceSeq: number): Promise<OpRow[]>;
  /** T-026 (H1): операции со seq <= uptoSeq — досылка гостю при reveal-переподключении. */
  opsUpTo(boardId: string, uptoSeq: number): Promise<OpRow[]>;
  /** Последний seq доски (0, если журнал пуст) — для revealSeq. */
  lastSeq(boardId: string): Promise<number>;
  latestSnapshot(boardId: string): Promise<SnapshotRecord | null>;
  /** ≈ replay(журнал): равенство после materialize (I5); адаптер вправе кэшировать. */
  currentState(boardId: string): Promise<ReplayResult>;

  authors(boardId: string): Promise<ReadonlyMap<EntityId, string>>;
  authorDisplayNames(boardId: string): Promise<Record<EntityId, string>>;

  /** Всё внутри fn фиксируется целиком или не фиксируется вовсе. */
  transaction<T>(fn: (tx: BoardStoreTx) => Promise<T>): Promise<T>;
}
