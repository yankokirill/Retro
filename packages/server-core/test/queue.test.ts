// T-012 — очередь операций одной доски (`apps/server/src/ws/board-queue.ts`):
// приёмочные тесты для контракта `BoardQueue.run`, написанные ДО того, как
// реализация стала реальным FIFO (docs/spec/consistency-model.md § 7 —
// «сервер обрабатывает дельты одной доски последовательно», § 9 доказательство
// Т7⇒I6, docs/spec/requirements.md REQ-015 кр. 6).
//
// Контракт (дан в задаче T-012 verbatim, файл `board-queue.ts` НЕ читался
// сверх этого контракта):
//
//   interface BoardQueue {
//     run(boardId: string, fn: () => Promise<void>): Promise<void>;
//   }
//   function createBoardQueue(): BoardQueue;
//
// Требуемое поведение run():
//   1. Для одного boardId вызовы fn выполняются строго по одному — следующий
//      fn не НАЧИНАЕТ выполняться, пока предыдущий fn для этой же доски не
//      завершится (успешно или с ошибкой). Порядок — порядок вызова run().
//   2. Для разных boardId вызовы независимы.
//   3. Исключение в одном fn не блокирует очередь навсегда.
//
// История (T-012): первая версия `run()` была сквозной (вызывала fn
// немедленно, без упорядочивания) — пункты 1 и 2(ordering под 3+ вызовами)
// падали, это и было доказательством гонки I6 машиной, а не мнением.
// Реализация исправлена на реальный FIFO отдельным коммитом — все тесты
// ниже теперь зелёные.

import { describe, expect, it } from "vitest";
import { createBoardQueue } from "../src/queue.js";

/** Промис, который тест разрешает вручную — без setTimeout/гонок по времени. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Даёт микро- и макрозадачам, уже поставленным в очередь, доиграть до конца,
 * не завязываясь на реальное время (0мс таймер гарантированно выполняется
 * после всех уже запланированных microtask'ов и после текущего тика).
 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("REQ-015 (кр. 6, I6): BoardQueue.run сериализует операции одной доски", () => {
  it("REQ-015 (кр. 6, I6): второй fn для той же доски не начинает выполняться, пока не завершится первый", async () => {
    const queue = createBoardQueue();
    const boardId = "board-a";
    const log: string[] = [];
    const gate = deferred<void>();

    const firstRun = queue.run(boardId, async () => {
      log.push("first:start");
      await gate.promise;
      log.push("first:end");
    });

    const secondRun = queue.run(boardId, async () => {
      log.push("second:start");
    });

    // Первый fn ещё висит на gate — второй не должен был даже начаться.
    await flush();
    expect(log).toEqual(["first:start"]);

    gate.resolve();
    await firstRun;
    await secondRun;

    expect(log).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("REQ-015 (кр. 6, I6): 3+ вызовов run для одной доски выполняются строго по одному, в порядке вызова", async () => {
    const queue = createBoardQueue();
    const boardId = "board-b";
    const log: string[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];

    // Все три run() вызываются "почти одновременно" — как сообщения от двух
    // вкладок, отправленные без ожидания ответа друг на друга — без await
    // между вызовами.
    const runs = [0, 1, 2].map((i) =>
      queue.run(boardId, async () => {
        log.push(`start:${i}`);
        await gates[i]!.promise;
        log.push(`end:${i}`);
      }),
    );

    await flush();
    expect(log).toEqual(["start:0"]);

    gates[0]!.resolve();
    await flush();
    expect(log).toEqual(["start:0", "end:0", "start:1"]);

    gates[1]!.resolve();
    await flush();
    expect(log).toEqual(["start:0", "end:0", "start:1", "end:1", "start:2"]);

    gates[2]!.resolve();
    await Promise.all(runs);
    expect(log).toEqual(["start:0", "end:0", "start:1", "end:1", "start:2", "end:2"]);
  });

  it("REQ-015 (кр. 6, I6): run для разных boardId не ждут друг друга", async () => {
    const queue = createBoardQueue();
    const log: string[] = [];
    const gateA = deferred<void>();

    const runA = queue.run("board-A", async () => {
      log.push("A:start");
      await gateA.promise;
      log.push("A:end");
    });

    const runB = queue.run("board-B", async () => {
      log.push("B:start");
      log.push("B:end");
    });

    // Доска B не подписана на очередь доски A — должна успеть выполниться
    // полностью, пока A всё ещё висит на gateA.
    await runB;
    expect(log).toEqual(["A:start", "B:start", "B:end"]);

    gateA.resolve();
    await runA;
    expect(log).toEqual(["A:start", "B:start", "B:end", "A:end"]);
  });

  it("REQ-015 (кр. 6, I6): ошибка в fn не блокирует очередь навсегда — следующий run для той же доски всё равно выполняется", async () => {
    const queue = createBoardQueue();
    const boardId = "board-c";
    const log: string[] = [];

    const failingRun = queue.run(boardId, async () => {
      log.push("first:start");
      throw new Error("boom");
    });

    await expect(failingRun).rejects.toThrow("boom");

    const secondRun = queue.run(boardId, async () => {
      log.push("second:start");
    });
    await secondRun;

    expect(log).toEqual(["first:start", "second:start"]);
  });
});
