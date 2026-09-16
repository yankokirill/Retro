// SIM-03 (docs/spec/simulator.md § 2): «Модель хранилища эквивалентна
// Postgres» — один и тот же контрактный набор проверяет `PgBoardStore`
// (test:int, Testcontainers) и `MemoryBoardStore` (test:unit, T-025); адаптер
// передаётся параметром (`makeStore`). Написано ДО обоих адаптеров — этот
// файл проверяет себя прямо сейчас на `ReferenceBoardStore`
// (`store-contract.smoke.test.ts`), эталонной in-memory реализации только
// для самопроверки контракта, не претендующей на роль T-025.
//
// Дельты строятся ТОЛЬКО через публичный API `@retro/crdt`
// (createSticker/editText/vote/unvote/toWire/merge/materialize/equals) —
// как в apps/server/test/validate.test.ts / votes.test.ts (тот же стиль,
// эти файлы не читались, только их упоминание в задаче). Используются
// ТОЛЬКО методы `BoardStore`/`BoardStoreTx` — контракт не знает, Postgres
// это или память.

import type { Clock, Dot, EntityId, OpResult, State } from "@retro/crdt";
import {
  createSticker,
  dotKey,
  editText,
  empty,
  equals,
  fromWire,
  materialize,
  merge,
  newClock,
  toWire,
  unvote as unvoteDelta,
  vote,
} from "@retro/crdt";
import type { Phase, Role } from "@retro/protocol";
import { operationDot, operationLamport } from "@retro/protocol";
import { describe, expect, it } from "vitest";
import type { AppendOpParams, AppendOpResult, BoardStore, OpRow } from "../src/store.js";

/**
 * Форма подготовки хранилища ДО проверки — вне интерфейса `BoardStore`:
 * порт не содержит методов «создать доску» / «добавить участника» (они
 * заводятся вне протокола WS, CLAUDE.md § 3, REST `/api/boards`), но
 * контракту нужен способ завести доску/участника до вызова `board()` /
 * `memberRole()`. `displayName` — не в подсказанной сигнатуре задачи, но
 * без него нельзя честно проверить `authorDisplayNames` (store.ts):
 * необязательный параметр, реализация вправе его игнорировать.
 * `saveSnapshot` — необязателен: адаптер, умеющий сохранять снапшоты
 * (E8, `docs/spec/simulator.md` § 4.2), должен его передать, чтобы
 * «снапшот и хвост» проверялись не только «снапшотов не было». Сигнатура
 * `(store, boardId) => Promise<void>` (без `SnapshotRecord`-аргумента,
 * T-025 design § 3.4 уточнение 3): «снапшот текущего состояния доски на
 * её текущем `seq`» — это то, что реально делает E8
 * (`docs/spec/simulator.md` § 4.2: «хранилище сохраняет `compact(X_S)` на
 * текущем `seq`»), а не «сохрани вот этот произвольный `SnapshotRecord`».
 */
export interface BoardStoreContractSetup {
  createBoard(
    store: BoardStore,
    board: { id: string; title: string; ownerId: string; phase: Phase; voteLimit: number },
  ): Promise<void>;
  addMember(
    store: BoardStore,
    boardId: string,
    guestId: string,
    role: Role,
    displayName?: string,
  ): Promise<void>;
  saveSnapshot?(store: BoardStore, boardId: string): Promise<void>;
}

/** `appendOp`/`recordAuthor` — только через `BoardStoreTx` (`transaction`). */
async function appendOp(store: BoardStore, params: AppendOpParams): Promise<AppendOpResult> {
  return store.transaction((tx) => tx.appendOp(params));
}

async function recordAuthor(
  store: BoardStore,
  boardId: string,
  entityId: EntityId,
  guestId: string,
): Promise<void> {
  await store.transaction((tx) => tx.recordAuthor(boardId, entityId, guestId));
}

/** Проводная дельта + (dot, lamport) идемпотентности — из честного `OpResult` (§ 3 crdt). */
function paramsFor(boardId: string, result: OpResult): AppendOpParams {
  const wire = toWire(result.delta);
  return { boardId, dot: operationDot(wire), lamport: operationLamport(wire), delta: wire };
}

/** unvote не тикает часы (T-002): `dot: null` — у него нет своей пары (actor, counter). */
function unvoteParams(boardId: string, delta: State): AppendOpParams {
  return { boardId, dot: null, lamport: null, delta: toWire(delta) };
}

/**
 * Локальная «честная» реплика: то, что реально накопилось бы у клиента,
 * построившего эти операции по порядку. Используется, чтобы дельты в
 * appendOp были настоящими CRDT-дельтами (§ 3 consistency-model.md), а не
 * произвольным JSON, и чтобы можно было сравнить `currentState()` с тем,
 * что «должно быть» — без обращения к внутренностям хранилища.
 */
class World {
  private worldState: State = empty();
  private readonly clocks = new Map<string, Clock>();

  get state(): State {
    return this.worldState;
  }

  private clockFor(actor: string): Clock {
    return this.clocks.get(actor) ?? newClock(actor);
  }

  private commit(actor: string, result: OpResult): OpResult {
    this.worldState = merge(this.worldState, result.delta);
    this.clocks.set(actor, result.clock);
    return result;
  }

  createSticker(actor: string, text = "hello"): OpResult {
    return this.commit(
      actor,
      createSticker(this.worldState, this.clockFor(actor), {
        column: "start",
        frac: "m",
        text,
        color: "yellow",
      }),
    );
  }

  editText(actor: string, id: EntityId, text: string): OpResult {
    return this.commit(actor, editText(this.worldState, this.clockFor(actor), id, text));
  }

  vote(actor: string, target: EntityId, user: string): OpResult {
    return this.commit(actor, vote(this.worldState, this.clockFor(actor), target, user));
  }

  /** unvote не тикает часы — только обновляет локальное состояние мира. */
  unvote(voteDot: Dot, target: EntityId): State {
    const delta = unvoteDelta(this.worldState, voteDot, target);
    this.worldState = merge(this.worldState, delta);
    return delta;
  }
}

// boardId/ownerId/guestId — здесь именно валидные UUID-строки, в отличие от
// `actor` (`ops.actor` — `text`, намеренно непрозрачный формат, CLAUDE.md
// правило 7, db/schema.ts JSDoc `ops`). `PgBoardStore` хранит их в колонках
// `uuid` (`boards.id`/`owner_id`, `members.user_id`, `authors.guest_id`) —
// нечитаемый Postgres формат-каст `board.id: "board-1"` уронил бы адаптер
// ошибкой типа данных, а не вернул бы `null`/пустой результат, как ожидает
// контракт ниже.
const BOARD = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Retro",
  ownerId: "00000000-0000-4000-8000-0000000000f0",
  phase: "collect" as Phase,
  voteLimit: 3,
};

const UNKNOWN_BOARD_ID = "00000000-0000-4000-8000-0000000000ff";
const UNKNOWN_GUEST_ID = "00000000-0000-4000-8000-0000000000fe";
const GUEST_1 = "00000000-0000-4000-8000-000000000011";
const GUEST_2 = "00000000-0000-4000-8000-000000000012";

export function describeBoardStoreContract(
  name: string,
  makeStore: () => BoardStore | Promise<BoardStore>,
  setup: BoardStoreContractSetup,
): void {
  const freshStore = async (): Promise<BoardStore> => makeStore();

  describe(name, () => {
    it("SIM-03: board() — null для неизвестной доски, иначе запись с текущими полями", async () => {
      const store = await freshStore();
      expect(await store.board(UNKNOWN_BOARD_ID)).toBeNull();

      await setup.createBoard(store, BOARD);
      const record = await store.board(BOARD.id);
      expect(record).toMatchObject({
        id: BOARD.id,
        title: BOARD.title,
        ownerId: BOARD.ownerId,
        phase: BOARD.phase,
        voteLimit: BOARD.voteLimit,
        revealSeq: null,
      });
    });

    it("SIM-03: updatePhase меняет фазу и revealSeq доски — видно через board()", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);

      await store.updatePhase(BOARD.id, "group", 7);
      const record = await store.board(BOARD.id);
      expect(record?.phase).toBe("group");
      expect(record?.revealSeq).toBe(7);
    });

    it("SIM-03: memberRole — null для неизвестного участника, иначе его роль", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);
      expect(await store.memberRole(BOARD.id, UNKNOWN_GUEST_ID)).toBeNull();

      await setup.addMember(store, BOARD.id, GUEST_1, "facilitator");
      expect(await store.memberRole(BOARD.id, GUEST_1)).toBe("facilitator");
    });

    it("SIM-03: appendOp идемпотентен по (board, actor, counter) — повтор той же операции не создаёт вторую строку журнала", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);
      const world = new World();
      const params = paramsFor(BOARD.id, world.createSticker("actor-a"));

      const first = await appendOp(store, params);
      const second = await appendOp(store, params);

      expect(second.seq).toBe(first.seq);
      const rows = await store.opsSince(BOARD.id, 0);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.seq).toBe(first.seq);
    });

    it("SIM-03: findOpSeq находит seq по dot после appendOp, иначе null", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);
      const world = new World();
      const op = world.createSticker("actor-a");

      expect(await store.findOpSeq(BOARD.id, op.dot)).toBeNull();
      const result = await appendOp(store, paramsFor(BOARD.id, op));
      expect(await store.findOpSeq(BOARD.id, op.dot)).toBe(result.seq);
      expect(await store.findOpSeq(BOARD.id, { actor: "actor-a", counter: 999 })).toBeNull();
    });

    it("SIM-03: appendOp не дедуплицирует dot = null (unvote) — повтор той же дельты создаёт вторую строку журнала", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);
      const world = new World();
      const sticker = world.createSticker("actor-a");
      const target = dotKey(sticker.dot);
      await appendOp(store, paramsFor(BOARD.id, sticker));
      const voteOp = world.vote("actor-b", target, "voter-token-1");
      await appendOp(store, paramsFor(BOARD.id, voteOp));

      const unvote = world.unvote(voteOp.dot, target);
      const params = unvoteParams(BOARD.id, unvote);

      const first = await appendOp(store, params);
      const second = await appendOp(store, params);

      expect(second.seq).not.toBe(first.seq);
      const rows = (await store.opsSince(BOARD.id, 0)).filter(
        (row) => row.delta.unvotes.length > 0,
      );
      expect(rows).toHaveLength(2);
    });

    it("SIM-03: findUnvoteSeq находит seq unvote по (voteDot, target), иначе null", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);
      const world = new World();
      const sticker = world.createSticker("actor-a");
      const target = dotKey(sticker.dot);
      await appendOp(store, paramsFor(BOARD.id, sticker));
      const voteOp = world.vote("actor-b", target, "voter-1");
      await appendOp(store, paramsFor(BOARD.id, voteOp));

      expect(await store.findUnvoteSeq(BOARD.id, voteOp.dot, target)).toBeNull();

      const unvote = world.unvote(voteOp.dot, target);
      const result = await appendOp(store, unvoteParams(BOARD.id, unvote));

      expect(await store.findUnvoteSeq(BOARD.id, voteOp.dot, target)).toBe(result.seq);
      expect(await store.findUnvoteSeq(BOARD.id, voteOp.dot, "some-other-entity")).toBeNull();
    });

    it("SIM-03: actorClock возвращает три числа — lastCounter/lastLamport актора и boardMaxLamport доски", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);
      const world = new World();

      expect(await store.actorClock(BOARD.id, "actor-a")).toEqual({
        lastCounter: 0,
        lastLamport: 0,
        boardMaxLamport: 0,
      });

      const sticker = world.createSticker("actor-a");
      await appendOp(store, paramsFor(BOARD.id, sticker));
      const afterA = await store.actorClock(BOARD.id, "actor-a");
      expect(afterA).toEqual({
        lastCounter: sticker.clock.counter,
        lastLamport: sticker.clock.lamport,
        boardMaxLamport: sticker.clock.lamport,
      });

      const editByB = world.editText("actor-b", dotKey(sticker.dot), "edited");
      await appendOp(store, paramsFor(BOARD.id, editByB));

      const afterB = await store.actorClock(BOARD.id, "actor-b");
      expect(afterB).toEqual({
        lastCounter: editByB.clock.counter,
        lastLamport: editByB.clock.lamport,
        boardMaxLamport: editByB.clock.lamport,
      });

      // Актор A ничего не делал со своего последнего появления — его личные
      // числа не изменились, но boardMaxLamport — свойство доски, а не актора.
      const afterA2 = await store.actorClock(BOARD.id, "actor-a");
      expect(afterA2.lastCounter).toBe(sticker.clock.counter);
      expect(afterA2.lastLamport).toBe(sticker.clock.lamport);
      expect(afterA2.boardMaxLamport).toBe(editByB.clock.lamport);
    });

    it("SIM-03: opsSince/opsUpTo — по возрастанию seq, отфильтрованные по границе", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);
      const world = new World();

      const seqs: number[] = [];
      for (const actor of ["actor-a", "actor-b", "actor-a"]) {
        const result = await appendOp(store, paramsFor(BOARD.id, world.createSticker(actor)));
        seqs.push(result.seq);
      }

      const since0 = await store.opsSince(BOARD.id, 0);
      expect(since0.map((row) => row.seq)).toEqual(seqs);

      const [firstSeq] = seqs;
      if (firstSeq === undefined) throw new Error("seqs must not be empty");
      const sinceFirst = await store.opsSince(BOARD.id, firstSeq);
      expect(sinceFirst.map((row) => row.seq)).toEqual(seqs.slice(1));

      const upToFirst = await store.opsUpTo(BOARD.id, firstSeq);
      expect(upToFirst.map((row) => row.seq)).toEqual([firstSeq]);
    });

    it("SIM-03: lastSeq — 0 для пустого журнала, иначе последний присвоенный seq", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);
      expect(await store.lastSeq(BOARD.id)).toBe(0);

      const world = new World();
      const first = await appendOp(store, paramsFor(BOARD.id, world.createSticker("actor-a")));
      expect(await store.lastSeq(BOARD.id)).toBe(first.seq);

      const second = await appendOp(store, paramsFor(BOARD.id, world.createSticker("actor-a")));
      expect(await store.lastSeq(BOARD.id)).toBe(second.seq);
    });

    it("SIM-03: seq монотонно возрастает при последовательных appendOp (пропуски допустимы, но не убывание/повтор)", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);
      const world = new World();

      let previous = 0;
      for (let i = 0; i < 5; i += 1) {
        const actor = i % 2 === 0 ? "actor-a" : "actor-b";
        const result = await appendOp(store, paramsFor(BOARD.id, world.createSticker(actor)));
        expect(result.seq).toBeGreaterThan(previous);
        previous = result.seq;
      }
    });

    it("SIM-03: latestSnapshot — null, если снапшотов не было", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);
      expect(await store.latestSnapshot(BOARD.id)).toBeNull();
    });

    const itWithSnapshot = setup.saveSnapshot ? it : it.skip;
    itWithSnapshot(
      "SIM-03: снапшот + хвост после uptoSeq эквивалентен полному состоянию (materialize)",
      async () => {
        const store = await freshStore();
        await setup.createBoard(store, BOARD);
        const world = new World();

        // «Снапшот текущего состояния доски на её текущем seq» (E8): сначала
        // доводим состояние до нужной точки через appendOp, ЗАТЕМ снимаем
        // снапшот — setup.saveSnapshot больше не принимает готовый
        // SnapshotRecord, он снимает его с того, что уже в хранилище.
        const sticker = world.createSticker("actor-a", "first");
        await appendOp(store, paramsFor(BOARD.id, sticker));

        await setup.saveSnapshot?.(store, BOARD.id);
        const uptoSeqAtSnapshot = await store.lastSeq(BOARD.id);

        const edit = world.editText("actor-b", dotKey(sticker.dot), "second");
        await appendOp(store, paramsFor(BOARD.id, edit));

        const snapshot = await store.latestSnapshot(BOARD.id);
        if (snapshot === null) throw new Error("expected a snapshot to be present");
        expect(snapshot.uptoSeq).toBe(uptoSeqAtSnapshot);

        const tail = await store.opsSince(BOARD.id, snapshot.uptoSeq);
        let merged = snapshot.state;
        for (const row of tail) merged = merge(merged, fromWire(row.delta));

        const replay = await store.currentState(BOARD.id);
        expect(materialize(merged)).toEqual(materialize(replay.state));
        expect(materialize(merged)).toEqual(materialize(world.state));
      },
    );

    it("SIM-03: currentState эквивалентен replay журнала (равенство после materialize)", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);
      const world = new World();

      const sticker = world.createSticker("actor-a", "first text");
      await appendOp(store, paramsFor(BOARD.id, sticker));
      const edit = world.editText("actor-b", dotKey(sticker.dot), "second text");
      await appendOp(store, paramsFor(BOARD.id, edit));
      const voteOp = world.vote("actor-a", dotKey(sticker.dot), "voter-1");
      await appendOp(store, paramsFor(BOARD.id, voteOp));

      const replay = await store.currentState(BOARD.id);
      expect(equals(replay.state, world.state)).toBe(true);
      expect(materialize(replay.state)).toEqual(materialize(world.state));
      expect(replay.uptoSeq).toBe(await store.lastSeq(BOARD.id));
    });

    it("SIM-03: transaction атомарна — сбой внутри не оставляет ни строки журнала, ни автора", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);
      await setup.addMember(store, BOARD.id, GUEST_1, "participant", "Alice");
      const world = new World();
      const sticker = world.createSticker("actor-a");
      const entityId = dotKey(sticker.dot);
      const params = paramsFor(BOARD.id, sticker);

      await expect(
        store.transaction(async (tx) => {
          await tx.appendOp(params);
          await tx.recordAuthor(BOARD.id, entityId, GUEST_1);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(await store.opsSince(BOARD.id, 0)).toHaveLength(0);
      expect(await store.lastSeq(BOARD.id)).toBe(0);
      const authors = await store.authors(BOARD.id);
      expect(authors.has(entityId)).toBe(false);
      const names = await store.authorDisplayNames(BOARD.id);
      expect(names[entityId]).toBeUndefined();
    });

    it("SIM-03: успешная transaction фиксирует все свои appendOp и recordAuthor целиком", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);
      await setup.addMember(store, BOARD.id, GUEST_1, "participant", "Alice");
      const world = new World();
      const sticker = world.createSticker("actor-a");
      const entityId = dotKey(sticker.dot);
      const edit = world.editText("actor-a", entityId, "again");

      const result = await store.transaction(async (tx) => {
        const appended = await tx.appendOp(paramsFor(BOARD.id, sticker));
        await tx.recordAuthor(BOARD.id, entityId, GUEST_1);
        await tx.appendOp(paramsFor(BOARD.id, edit));
        return appended;
      });

      expect(result.seq).toBeGreaterThan(0);
      expect(await store.opsSince(BOARD.id, 0)).toHaveLength(2);
      const authors = await store.authors(BOARD.id);
      expect(authors.get(entityId)).toBe(GUEST_1);
      const names = await store.authorDisplayNames(BOARD.id);
      expect(names[entityId]).toBe("Alice");
    });

    // Отдельная проверка того, что recordAuthor напрямую (не через сбойную
    // transaction) тоже наблюдаем через authors()/authorDisplayNames() —
    // независимо от теста атомарности выше.
    it("SIM-03: recordAuthor виден через authors()/authorDisplayNames() после фиксации", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);
      await setup.addMember(store, BOARD.id, GUEST_2, "owner", "Bob");
      const world = new World();
      const sticker = world.createSticker("actor-a");
      const entityId = dotKey(sticker.dot);

      await appendOp(store, paramsFor(BOARD.id, sticker));
      await recordAuthor(store, BOARD.id, entityId, GUEST_2);

      const authors = await store.authors(BOARD.id);
      expect(authors.get(entityId)).toBe(GUEST_2);
      const names = await store.authorDisplayNames(BOARD.id);
      expect(names[entityId]).toBe("Bob");
    });

    // T-025 design § 3.4 уточнение 3: "authorOf/recordAuthor — первый
    // писатель побеждает (onConflictDoNothing в Postgres)" — расхождение с
    // Postgres, которое обязано быть в общем контракте, не только в
    // memory-store.test.ts.
    it("SIM-03: recordAuthor — первый писатель побеждает, повтор другим guestId автора не меняет", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);
      await setup.addMember(store, BOARD.id, GUEST_1, "participant", "Alice");
      await setup.addMember(store, BOARD.id, GUEST_2, "participant", "Bob");
      const world = new World();
      const sticker = world.createSticker("actor-a");
      const entityId = dotKey(sticker.dot);
      await appendOp(store, paramsFor(BOARD.id, sticker));

      await recordAuthor(store, BOARD.id, entityId, GUEST_1);
      await recordAuthor(store, BOARD.id, entityId, GUEST_2);

      const authors = await store.authors(BOARD.id);
      expect(authors.get(entityId)).toBe(GUEST_1);
      const names = await store.authorDisplayNames(BOARD.id);
      expect(names[entityId]).toBe("Alice");
    });

    // T-025 design § 3.4 уточнение 3: "authorDisplayNames не включает
    // авторов без записи в участниках (inner join)" — расхождение с
    // Postgres в общем контракте.
    it("SIM-03: authorDisplayNames не включает сущность, автор которой не добавлен в участники", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);
      // Намеренно НЕ вызываем setup.addMember для UNKNOWN_GUEST_ID.
      const world = new World();
      const sticker = world.createSticker("actor-a");
      const entityId = dotKey(sticker.dot);
      await appendOp(store, paramsFor(BOARD.id, sticker));
      await recordAuthor(store, BOARD.id, entityId, UNKNOWN_GUEST_ID);

      const authors = await store.authors(BOARD.id);
      expect(authors.get(entityId)).toBe(UNKNOWN_GUEST_ID);

      const names = await store.authorDisplayNames(BOARD.id);
      expect(names[entityId]).toBeUndefined();
    });

    // T-025 design § 3.4 уточнение 3: неизменяемость хранилища при
    // мутации возвращённых выборок — вызывающая сторона получает
    // независимую копию, а не ссылку на внутреннее состояние адаптера.
    it("SIM-03: мутация выборок, возвращённых opsSince()/authors(), не меняет хранилище", async () => {
      const store = await freshStore();
      await setup.createBoard(store, BOARD);
      await setup.addMember(store, BOARD.id, GUEST_1, "participant", "Alice");
      const world = new World();
      const sticker = world.createSticker("actor-a");
      const entityId = dotKey(sticker.dot);
      await appendOp(store, paramsFor(BOARD.id, sticker));
      await recordAuthor(store, BOARD.id, entityId, GUEST_1);

      const rows = await store.opsSince(BOARD.id, 0);
      expect(rows).toHaveLength(1);
      (rows as OpRow[]).push({ seq: 999_999, delta: paramsFor(BOARD.id, sticker).delta });

      const rowsAgain = await store.opsSince(BOARD.id, 0);
      expect(rowsAgain).toHaveLength(1);

      const authors = await store.authors(BOARD.id);
      expect(authors.size).toBe(1);
      (authors as Map<EntityId, string>).set("intruder:1", GUEST_1);

      const authorsAgain = await store.authors(BOARD.id);
      expect(authorsAgain.size).toBe(1);
      expect(authorsAgain.has("intruder:1")).toBe(false);
    });
  });
}
