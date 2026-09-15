// Общие помощники для приёмочных тестов T-028 (`packages/client-core`).
//
// Все сообщения сервера, которыми тесты кормят `receive()`, строятся так,
// чтобы заведомо проходить `serverMessageSchema` (`@retro/protocol`) — это
// гарантирует, что падение теста связано с отсутствием реализации
// `createSyncClient`, а не с невалидным входом. `serverMessage()` ниже
// парсит сообщение через схему перед сериализацией: если тест случайно
// соберёт что-то невалидное, он упадёt в фикстуре с понятной ошибкой Zod, а
// не молча отправит мусор в `receive()`.
//
// Дельты внутри `welcome.snapshot`/`op` строятся через настоящие
// конструкторы `@retro/crdt` (`createSticker`, `vote`, …) и `toWire` —
// реалистичные достижимые состояния, а не собранные вручную объекты.

import { randomUUID } from "node:crypto";
import type { Column, EntityId, State, View, WireDelta } from "@retro/crdt";
import { toWire } from "@retro/crdt";
import type { BoardMeta, ClientMessage, RejectReason, Role, ServerMessage } from "@retro/protocol";
import { clientMessageSchema, PROTOCOL_VERSION, serverMessageSchema } from "@retro/protocol";
import { createMemoryOutboxStore } from "../src/outbox.js";
import type { ClientCorePorts, SyncClientConfig } from "../src/types.js";

/** actorId другого участника/сервера — валидный UUID (entityIdSchema требует его формат). */
export function otherActorId(): string {
  return randomUUID();
}

export function makeMeta(overrides: Partial<BoardMeta> = {}): BoardMeta {
  return {
    boardId: randomUUID(),
    title: "Спринт 42 — ретро",
    phase: "collect",
    revealed: false,
    voteLimit: 3,
    timer: null,
    authors: {},
    ...overrides,
  };
}

export interface TestPorts extends ClientCorePorts {
  readonly actorId: string;
  readonly outboxStore: ReturnType<typeof createMemoryOutboxStore>;
  readonly commandIds: () => readonly string[];
}

/** Порты с детерминированным actorId/commandId и `createMemoryOutboxStore()` как хранилищем P. */
export function makePorts(): TestPorts {
  const actorId = randomUUID();
  let commandCounter = 0;
  const issuedCommandIds: string[] = [];
  const outboxStore = createMemoryOutboxStore();
  return {
    newActorId: () => actorId,
    newCommandId: () => {
      const id = `cmd-${++commandCounter}`;
      issuedCommandIds.push(id);
      return id;
    },
    outbox: outboxStore,
    actorId,
    outboxStore,
    commandIds: () => issuedCommandIds,
  };
}

export function makeConfig(overrides: Partial<SyncClientConfig> = {}): SyncClientConfig {
  return {
    boardId: randomUUID(),
    guestId: randomUUID(),
    displayName: "Тестовый участник",
    ...overrides,
  };
}

/** Валидирует по `serverMessageSchema` и сериализует — вход `receive()`. */
export function serverMessage(message: ServerMessage): string {
  return JSON.stringify(serverMessageSchema.parse(message));
}

export function welcomeMessage(params: {
  role?: Role;
  voterToken?: string;
  meta?: BoardMeta;
  snapshot?: { upToSeq: number; state: WireDelta } | null;
  ops?: readonly { seq: number; delta: WireDelta }[];
}): string {
  return serverMessage({
    type: "welcome",
    role: params.role ?? "participant",
    voterToken: params.voterToken ?? `voter-${randomUUID()}`,
    meta: params.meta ?? makeMeta(),
    snapshot: params.snapshot ?? null,
    ops: params.ops ? [...params.ops] : [],
  });
}

export function ackMessage(dot: { actor: string; counter: number }, seq: number): string {
  return serverMessage({ type: "ack", dot, seq });
}

export function rejectMessage(
  dot: { actor: string; counter: number },
  reason: RejectReason,
  message = "отклонено сервером",
): string {
  return serverMessage({ type: "reject", dot, reason, message });
}

export function opMessage(seq: number, delta: WireDelta): string {
  return serverMessage({ type: "op", seq, delta });
}

export function metaMessage(meta: BoardMeta): string {
  return serverMessage({ type: "meta", meta });
}

export function commandResultMessage(
  id: string,
  ok: boolean,
  extra: { reason?: RejectReason; message?: string } = {},
): string {
  return serverMessage({ type: "commandResult", id, ok, ...extra });
}

export function errorMessage(reason: RejectReason, message = "фатальная ошибка"): string {
  return serverMessage({ type: "error", reason, message });
}

/** Проекция `State` на провод, как в `welcome.snapshot.state`/`op.delta`. */
export function wireOf(state: State): WireDelta {
  return toWire(state);
}

/** Разбирает и валидирует строку, отправленную клиентом, как `ClientMessage`. */
export function parseSent(raw: string): ClientMessage {
  return clientMessageSchema.parse(JSON.parse(raw));
}

export function parseHello(raw: string) {
  const message = parseSent(raw);
  if (message.type !== "hello") throw new Error(`ожидали hello, получили ${message.type}`);
  return message;
}

export function parseOp(raw: string) {
  const message = parseSent(raw);
  if (message.type !== "op") throw new Error(`ожидали op, получили ${message.type}`);
  return message;
}

export const PROTOCOL = PROTOCOL_VERSION;

/**
 * id первого элемента (стикера/группы) в колонке — без небезопасного
 * optional chaining на `.id` (`noUnsafeOptionalChaining`). Бросает понятную
 * ошибку, если колонка пуста, вместо `TypeError: Cannot read ... of undefined`.
 */
export function firstItemId(view: View, column: Column): EntityId {
  const items = view.columns.get(column);
  const first = items?.[0];
  if (!first) throw new Error(`ожидали хотя бы один элемент в колонке "${column}"`);
  return first.id;
}
