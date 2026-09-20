// Мутанты M1–M7 — docs/spec/simulator.md § 10.2. Каждый подменяет поведение ТОЛЬКО на границе
// ядра (порт хранилища, сеть, обёртка над ядром сервера) через `WorldHooks`; в продуктовом коде
// и в мире симулятора нет флагов «сломать себя». Не экспортируется из index.ts — только тестам.

import type { BoardServer, MemoryBoardStore, Outgoing, ReceiveResult } from "@retro/server-core";
import type { WorldHooks } from "./hooks.js";

export type MutantId = "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7";

export const MUTANT_IDS: readonly MutantId[] = ["M1", "M2", "M3", "M4", "M5", "M6", "M7"];

/** Что мутант ломает — для сообщений «мутант Mk выжил». */
export const MUTANT_DESCRIPTIONS: Readonly<Record<MutantId, string>> = {
  M1: "сеть выбрасывает op, отправленные повторно после welcome (клиент «не пересылает очередь»)",
  M2: "сеть превращает reject в ack с выдуманным seq (клиент «оставляет отклонённую дельту»)",
  M3: "обёртка над ядром сервера заменяет рассылаемый op полной дельтой из журнала (нет проекции)",
  M4: "хранилище: findOpSeq всегда null (нет идемпотентности повтора)",
  M5: "хранилище без транзакции: appendOp фиксируется до падения recordAuthor при E9",
  M6: "ядро сервера не досылает скрытое после reveal подключённым",
  M7: "хранилище: opsSince возвращает пустой хвост",
};

const isWelcome = (raw: string): boolean => raw.startsWith('{"type":"welcome"');

/** Обёртка над хранилищем: методы из `overrides` подменены, остальные — настоящие. */
function overrideStore(
  store: MemoryBoardStore,
  overrides: Partial<Record<keyof MemoryBoardStore, unknown>>,
): MemoryBoardStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property in overrides) return overrides[property as keyof MemoryBoardStore];
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function overrideServer(
  server: BoardServer,
  receive: (connection: string, raw: string) => Promise<ReceiveResult>,
): BoardServer {
  return {
    open: (connection, boardId) => server.open(connection, boardId),
    receive,
    close: (connection) => server.close(connection),
  };
}

/** M5: транзакция без атомарности — каждая запись фиксируется сразу, сбой E9 бросается по счёту записей. */
function nonAtomicStore(store: MemoryBoardStore): MemoryBoardStore {
  let armed: { afterWrites: number } | null = null;
  return overrideStore(store, {
    failNextTransaction: (afterWrites: number) => {
      armed = { afterWrites };
    },
    transaction: async <T>(
      fn: (tx: Parameters<Parameters<MemoryBoardStore["transaction"]>[0]>[0]) => Promise<T>,
    ): Promise<T> => {
      const fault = armed;
      armed = null;
      let writes = 0;
      const beforeWrite = (): void => {
        writes += 1;
        if (fault && writes === fault.afterWrites + 1) {
          throw new Error("mutant M5: transaction failed after partial commit");
        }
      };
      return fn({
        appendOp: async (params) => {
          const result = await store.transaction((tx) => tx.appendOp(params));
          beforeWrite();
          return result;
        },
        recordAuthor: async (boardId, entityId, guestId) => {
          beforeWrite();
          await store.transaction((tx) => tx.recordAuthor(boardId, entityId, guestId));
        },
      });
    },
  });
}

export function mutantHooks(id: MutantId): WorldHooks {
  switch (id) {
    case "M1":
      return {
        clientReplies: (received, replies) => (isWelcome(received) ? [] : replies),
      };
    case "M2":
      return {
        toClient: (raw) => {
          if (!raw.startsWith('{"type":"reject"')) return raw;
          const { dot } = JSON.parse(raw) as { dot: unknown };
          return JSON.stringify({ type: "ack", dot, seq: 1_000_000 });
        },
      };
    case "M3":
      return {
        wrapServer: (server, { store, boardId }) => {
          // Подписанные соединения: получили welcome и ещё не закрыты.
          const subscribed = new Set<string>();
          const wrapped = overrideServer(server, async (connection, raw) => {
            const result = await server.receive(connection, raw);
            const outgoing: Outgoing[] = [];
            for (const out of result.outgoing) {
              outgoing.push(out);
              if (out.raw.startsWith('{"type":"welcome"')) subscribed.add(out.to);
            }
            // Нет проекции: каждая принятая операция уходит ВСЕМ подписанным полной дельтой из
            // журнала, даже когда настоящее ядро скрывает чужой стикер (пустая проекция → ничего
            // не отправляет вовсе, поэтому подменять уже рассылаемое сообщение бессмысленно).
            for (const out of result.outgoing) {
              if (!out.raw.startsWith('{"type":"ack"')) continue;
              const { seq } = JSON.parse(out.raw) as { seq: number };
              const row = store.opRowSync(boardId, seq);
              if (!row) continue;
              for (const target of subscribed) {
                if (target === connection) continue;
                outgoing.push({
                  to: target,
                  raw: JSON.stringify({ type: "op", seq, delta: row.delta }),
                });
              }
            }
            return { outgoing, close: result.close };
          });
          return {
            ...wrapped,
            close: async (connection) => {
              subscribed.delete(connection);
              await server.close(connection);
            },
          };
        },
      };
    case "M4":
      return { wrapStore: (store) => overrideStore(store, { findOpSeq: async () => null }) };
    case "M5":
      return { wrapStore: nonAtomicStore };
    case "M6":
      return {
        wrapServer: (server) =>
          overrideServer(server, async (connection, raw) => {
            const result = await server.receive(connection, raw);
            if (!raw.includes('"setPhase"')) return result;
            return {
              outgoing: result.outgoing.filter((out) => !out.raw.startsWith('{"type":"op"')),
              close: result.close,
            };
          }),
      };
    case "M7":
      return { wrapStore: (store) => overrideStore(store, { opsSince: async () => [] }) };
  }
}
