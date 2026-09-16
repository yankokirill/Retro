// T-025 (docs/design/T-005-simulator.md § 3.4, docs/spec/simulator.md SIM-03):
// приёмочные тесты для `createMemoryBoardStore`, написанные ДО реализации
// (сейчас — заглушка, синхронно бросает `Error("createMemoryBoardStore: not
// implemented")`) и не глядя в неё. Часть 1 — общий контракт `BoardStore`
// (`describeBoardStoreContract`, тот же набор, что и на `PgBoardStore`,
// `apps/server/test/pg-store.int.test.ts`, не запускается отсюда). Часть 2 —
// свойства именно этого адаптера (не часть порта `BoardStore`): `failNextTransaction`
// (E9), `seqGap`, компактизация снапшота, `log()`, владелец в участниках сразу
// после `createBoard`.
//
// Ожидаемый результат ПРЯМО СЕЙЧАС: каждый `it` падает РОВНО на вызове
// `createMemoryBoardStore()` с сообщением "createMemoryBoardStore: not
// implemented" — не из-за ошибки в построении сценария.

import type { Clock, Dot, EntityId, OpResult, State } from "@retro/crdt";
import {
  compact,
  createSticker,
  dotKey,
  editText,
  empty,
  equals,
  materialize,
  merge,
  newClock,
  toWire,
} from "@retro/crdt";
import { operationDot, operationLamport } from "@retro/protocol";
import type { AppendOpParams } from "@retro/server-core";
import { createMemoryBoardStore, type MemoryBoardStore } from "@retro/server-core";
import { describe, expect, it } from "vitest";
import { type BoardStoreContractSetup, describeBoardStoreContract } from "./store-contract.js";

// ---------------------------------------------------------------------------
// Мини-версия `World`/`paramsFor` из store-contract.ts (не импортируется —
// не экспортирован оттуда; задача разрешает повторить маленький кусочек
// здесь вместо копирования всего файла).

function paramsFor(boardId: string, result: OpResult): AppendOpParams {
  const wire = toWire(result.delta);
  return { boardId, dot: operationDot(wire), lamport: operationLamport(wire), delta: wire };
}

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
}

async function appendSticker(
  store: MemoryBoardStore,
  boardId: string,
  world: World,
  actor: string,
  text?: string,
): Promise<{ seq: number; dot: Dot }> {
  const op = world.createSticker(actor, text);
  const result = await store.transaction((tx) => tx.appendOp(paramsFor(boardId, op)));
  return { seq: result.seq, dot: op.dot };
}

const BOARD_ID = "00000000-0000-4000-8000-0000000000a1";
const OWNER_ID = "00000000-0000-4000-8000-0000000000a2";
const GUEST_1 = "00000000-0000-4000-8000-0000000000a3";

function freshBoard(store: MemoryBoardStore, id = BOARD_ID): void {
  store.createBoard({
    id,
    title: "Retro",
    ownerId: OWNER_ID,
    ownerName: "Owner",
    voteLimit: 3,
  });
}

// ---------------------------------------------------------------------------
// Часть 1: общий контракт `BoardStore` (SIM-03), тот же набор, что на Postgres.

const setup: BoardStoreContractSetup = {
  async createBoard(store, board) {
    (store as MemoryBoardStore).createBoard({
      id: board.id,
      title: board.title,
      ownerId: board.ownerId,
      ownerName: "Owner",
      voteLimit: board.voteLimit,
    });
  },
  async addMember(store, boardId, guestId, role, displayName) {
    (store as MemoryBoardStore).addMember(boardId, guestId, role, displayName ?? "Guest");
  },
  async saveSnapshot(store, boardId) {
    (store as MemoryBoardStore).saveSnapshot(boardId);
  },
};

describeBoardStoreContract("memory", () => createMemoryBoardStore(), setup);

// ---------------------------------------------------------------------------
// Часть 2: свойства именно `MemoryBoardStore` (T-025), не части порта.

describe("T-025: MemoryBoardStore — свойства адаптера", () => {
  describe("E9 failNextTransaction — точная семантика", () => {
    it("T-025 E9: failNextTransaction(0) — первая запись транзакции бросает сразу, ничего не применяется", async () => {
      const store = createMemoryBoardStore();
      freshBoard(store);
      const world = new World();
      const sticker = world.createSticker("actor-a");

      store.failNextTransaction(0);

      let firstWriteRejected = false;
      await expect(
        store.transaction(async (tx) => {
          try {
            await tx.appendOp(paramsFor(BOARD_ID, sticker));
          } catch (error) {
            firstWriteRejected = true;
            throw error;
          }
        }),
      ).rejects.toThrow();

      expect(firstWriteRejected).toBe(true);
      expect(await store.opsSince(BOARD_ID, 0)).toHaveLength(0);
      expect(store.log(BOARD_ID)).toHaveLength(0);
    });

    it("T-025 E9: failNextTransaction(1) с двумя записями — первая проходит, вторая бросает, обе откатываются", async () => {
      const store = createMemoryBoardStore();
      freshBoard(store);
      store.addMember(BOARD_ID, GUEST_1, "participant", "Alice");
      const world = new World();
      const sticker = world.createSticker("actor-a");
      const entityId = dotKey(sticker.dot);

      store.failNextTransaction(1);

      let firstWriteSucceeded = false;
      let secondWriteRejected = false;
      await expect(
        store.transaction(async (tx) => {
          await tx.appendOp(paramsFor(BOARD_ID, sticker));
          firstWriteSucceeded = true;
          try {
            await tx.recordAuthor(BOARD_ID, entityId, GUEST_1);
          } catch (error) {
            secondWriteRejected = true;
            throw error;
          }
        }),
      ).rejects.toThrow();

      expect(firstWriteSucceeded).toBe(true);
      expect(secondWriteRejected).toBe(true);
      expect(await store.opsSince(BOARD_ID, 0)).toHaveLength(0);
      expect((await store.authors(BOARD_ID)).has(entityId)).toBe(false);
    });

    it("T-025 E9: failNextTransaction(5) с транзакцией из одной записи — бросает при фиксации, не применив её", async () => {
      const store = createMemoryBoardStore();
      freshBoard(store);
      const world = new World();
      const sticker = world.createSticker("actor-a");

      store.failNextTransaction(5);

      let writeCallReturned = false;
      await expect(
        store.transaction(async (tx) => {
          await tx.appendOp(paramsFor(BOARD_ID, sticker));
          writeCallReturned = true;
        }),
      ).rejects.toThrow();

      // Одной записи недостаточно, чтобы достичь afterWrites=5 — сама
      // запись в буфер не бросает; транзакция падает при попытке
      // зафиксироваться, уже после того как fn успешно вернулся.
      expect(writeCallReturned).toBe(true);
      expect(await store.opsSince(BOARD_ID, 0)).toHaveLength(0);
    });

    it("T-025 E9: неисправность одноразовая — следующая транзакция после сбоя проходит нормально", async () => {
      const store = createMemoryBoardStore();
      freshBoard(store);
      const world = new World();

      store.failNextTransaction(0);
      await expect(
        store.transaction((tx) => tx.appendOp(paramsFor(BOARD_ID, world.createSticker("actor-a")))),
      ).rejects.toThrow();

      const result = await store.transaction((tx) =>
        tx.appendOp(paramsFor(BOARD_ID, world.createSticker("actor-b"))),
      );
      expect(result.seq).toBeGreaterThan(0);
      expect(await store.opsSince(BOARD_ID, 0)).toHaveLength(1);
    });

    it("T-025 E9: seq не переиспользуются вокруг сбойной транзакции", async () => {
      const store = createMemoryBoardStore();
      freshBoard(store);
      const world = new World();

      const first = await store.transaction((tx) =>
        tx.appendOp(paramsFor(BOARD_ID, world.createSticker("actor-a"))),
      );

      store.failNextTransaction(0);
      await expect(
        store.transaction((tx) => tx.appendOp(paramsFor(BOARD_ID, world.createSticker("actor-b")))),
      ).rejects.toThrow();

      const afterFailure = await store.transaction((tx) =>
        tx.appendOp(paramsFor(BOARD_ID, world.createSticker("actor-a"))),
      );

      // Строго больше first.seq + 1: seq, "потраченный" сбойной
      // транзакцией на её единственную (не применённую) запись, не
      // переиспользуется следующей успешной операцией.
      expect(afterFailure.seq).toBeGreaterThan(first.seq + 1);
    });
  });

  it("T-025: seqGap резервирует дополнительные seq между операциями", async () => {
    const store = createMemoryBoardStore({ seqGap: () => 3 });
    freshBoard(store);
    const world = new World();

    const first = await store.transaction((tx) =>
      tx.appendOp(paramsFor(BOARD_ID, world.createSticker("actor-a"))),
    );
    const second = await store.transaction((tx) =>
      tx.appendOp(paramsFor(BOARD_ID, world.createSticker("actor-a"))),
    );

    expect(second.seq).toBeGreaterThan(first.seq + 1);

    const rows = await store.opsSince(BOARD_ID, 0);
    expect(rows.map((row) => row.seq)).toEqual([first.seq, second.seq]);
    expect(await store.lastSeq(BOARD_ID)).toBe(second.seq);
  });

  it("T-025: saveSnapshot сохраняет compact(currentState) — сжат, materialize совпадает с полным состоянием", async () => {
    const store = createMemoryBoardStore();
    freshBoard(store);
    const world = new World();

    const created = await appendSticker(store, BOARD_ID, world, "actor-a", "first");
    const entityId = dotKey(created.dot);
    // Две последовательные правки одного и того же мира: вторая застаёт
    // первую видимой и перекрывает её — после compact() перекрытая запись
    // должна исчезнуть из entries снапшота.
    await store.transaction((tx) =>
      tx.appendOp(paramsFor(BOARD_ID, world.editText("actor-a", entityId, "second"))),
    );
    await store.transaction((tx) =>
      tx.appendOp(paramsFor(BOARD_ID, world.editText("actor-b", entityId, "third"))),
    );

    const { state: full } = await store.currentState(BOARD_ID);
    store.saveSnapshot(BOARD_ID);
    const snapshot = await store.latestSnapshot(BOARD_ID);
    if (snapshot === null) throw new Error("expected a snapshot to be present");

    expect(materialize(snapshot.state)).toEqual(materialize(full));
    expect(equals(snapshot.state, compact(full))).toBe(true);
    expect(snapshot.state.entries.size).toBeLessThan(full.entries.size);
  });

  it("T-025: log(boardId) — те же строки и порядок, что opsSince(boardId, 0); пусто на неизвестной доске", async () => {
    const store = createMemoryBoardStore();
    freshBoard(store);
    const world = new World();

    const seqs: number[] = [];
    for (const actor of ["actor-a", "actor-b", "actor-a"]) {
      const { seq } = await appendSticker(store, BOARD_ID, world, actor);
      seqs.push(seq);
    }

    const log = store.log(BOARD_ID);
    const since = await store.opsSince(BOARD_ID, 0);
    expect(log.map((row) => row.seq)).toEqual(seqs);
    expect(log).toEqual(since);

    expect(store.log("00000000-0000-4000-8000-0000000000ff")).toEqual([]);
  });

  it("T-025: владелец сразу в участниках после createBoard, без отдельного addMember", async () => {
    const store = createMemoryBoardStore();
    freshBoard(store);

    expect(await store.memberRole(BOARD_ID, OWNER_ID)).toBe("owner");
  });
});
