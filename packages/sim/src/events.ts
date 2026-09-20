// События мира — docs/spec/simulator.md § 4.2 (E1–E9), docs/design/
// T-005-simulator.md § 5.1/§ 6. Событие — сериализуемое решение
// планировщика, ровно то, что записывается в трассу (trace.ts).
//
// Индексы (`client`/`connection`) — позиции в `World.clients`/
// `World.connections`, стабильные в пределах одного прогона (§ 6 проекта).

import type { Intent } from "@retro/client-core";
import type { Command } from "@retro/protocol";
import { generateCommand, generateIntent } from "./intents.js";
import type { Connection } from "./network.js";
import type { Streams } from "./prng.js";
import type { World } from "./world.js";

export type Direction = "toServer" | "toClient";

export type Event =
  | { readonly kind: "act"; readonly client: number; readonly intent: Intent }
  | { readonly kind: "deliver"; readonly connection: number; readonly direction: Direction }
  | { readonly kind: "cut"; readonly connection: number }
  | { readonly kind: "serverNotice"; readonly connection: number }
  | { readonly kind: "connect"; readonly client: number }
  | { readonly kind: "reload"; readonly client: number; readonly actorId: string }
  | {
      readonly kind: "command";
      readonly client: number;
      readonly command: Command;
      readonly commandId: string;
    }
  | { readonly kind: "snapshot" }
  | { readonly kind: "storeFault"; readonly afterWrites: number };

export type EventMode = "run" | "drain";

/**
 * Событие-кандидат — как `Event`, но для `act`/`command` без сгенерированной
 * полезной нагрузки: чтобы её построить (`generateIntent`/`generateCommand`),
 * нужен `Prng`, а `enabledEvents` сама его не получает — иначе пришлось бы
 * генерировать намерение для КАЖДОГО подходящего клиента на каждом шаге
 * только ради проверки «а есть ли у него вообще намерение», а выбирается
 * потом только один. `resolveCandidate` вызывается один раз — для уже
 * выбранного взвешенным выбором кандидата (run.ts).
 */
export type Candidate =
  | { readonly kind: "act"; readonly client: number }
  | { readonly kind: "command"; readonly client: number }
  | { readonly kind: "reload"; readonly client: number }
  | Exclude<Event, { readonly kind: "act" | "command" | "reload" }>;

/**
 * Все события, разрешённые сейчас, в фиксированном порядке (§ 6 проекта: по
 * индексу клиента, затем по номеру соединения, затем по направлению).
 * `mode: "drain"` возвращает только `deliver` — шаги 2–3 процедуры досылки
 * (§ 7 спецификации: подключить всех, снять отложенные E4) выполняются
 * `drain.ts` напрямую, детерминированно, не через взвешенный выбор; E8
 * (snapshot) в процедуре досылки не участвует вовсе — она не входит в
 * перечисленные там 4 шага.
 */
/**
 * Соединения, с которыми что-то ещё может произойти: живые, с непустым каналом или
 * с не снятым E4. Остальные (порвались, дочитаны, сервер узнал) уже не вернутся;
 * обходить их на каждом шаге — O(число соединений за прогон) на шаг.
 */
const openConnections = new WeakMap<World, { seen: number; indexes: number[] }>();

function isFinished(connection: Connection): boolean {
  return (
    !connection.alive &&
    !connection.noticePending &&
    connection.toClient.length === 0 &&
    connection.toServer.length === 0
  );
}

function openConnectionIndexes(world: World): readonly number[] {
  let entry = openConnections.get(world);
  if (!entry) {
    entry = { seen: 0, indexes: [] };
    openConnections.set(world, entry);
  }
  for (; entry.seen < world.connections.length; entry.seen++) entry.indexes.push(entry.seen);
  entry.indexes = entry.indexes.filter((index) => {
    const connection = world.connections[index];
    return connection !== undefined && !isFinished(connection);
  });
  return entry.indexes;
}

export function enabledEvents(world: World, mode: EventMode): readonly Candidate[] {
  const events: Candidate[] = [];
  const open = openConnectionIndexes(world);

  for (const connectionIndex of open) {
    const connection = world.connections[connectionIndex];
    if (!connection) continue;
    if (!connection.alive) {
      // закрытое сервером соединение: клиент ещё дочитывает уже поставленное
      if (connection.serverClosed && connection.toClient.length > 0) {
        events.push({ kind: "deliver", connection: connectionIndex, direction: "toClient" });
      }
      continue;
    }
    if (connection.toServer.length > 0) {
      events.push({ kind: "deliver", connection: connectionIndex, direction: "toServer" });
    }
    if (connection.toClient.length > 0) {
      events.push({ kind: "deliver", connection: connectionIndex, direction: "toClient" });
    }
  }

  if (mode === "drain") return events;

  if (world.acts < world.config.ops) {
    world.clients.forEach((client, clientIndex) => {
      const guest = world.guests[client.guestIndex];
      if (guest && guest.role !== "viewer") events.push({ kind: "act", client: clientIndex });
    });
  }

  for (const connectionIndex of open) {
    if (world.connections[connectionIndex]?.alive) {
      events.push({ kind: "cut", connection: connectionIndex });
    }
  }

  for (const connectionIndex of open) {
    const connection = world.connections[connectionIndex];
    if (connection && !connection.alive && connection.noticePending) {
      events.push({ kind: "serverNotice", connection: connectionIndex });
    }
  }

  world.clients.forEach((client, clientIndex) => {
    if (client.connection === null) events.push({ kind: "connect", client: clientIndex });
  });

  world.clients.forEach((_client, clientIndex) => {
    events.push({ kind: "reload", client: clientIndex });
  });

  world.clients.forEach((client, clientIndex) => {
    const guest = world.guests[client.guestIndex];
    if (!guest) return;
    if ((guest.role === "owner" || guest.role === "facilitator") && client.connection !== null) {
      events.push({ kind: "command", client: clientIndex });
    }
  });

  events.push({ kind: "snapshot" });
  events.push({ kind: "storeFault", afterWrites: 0 });

  return events;
}

/**
 * Достраивает выбранного кандидата до полноценного `Event` (генерирует
 * намерение/команду/afterWrites, если нужно). `null` — кандидат оказался
 * неприменим при ближайшем рассмотрении (например, у клиента не нашлось ни
 * одного разрешённого намерения — сама возможность это выяснить требует
 * `generateIntent`, а не только структурной проверки роли) — вызывающий
 * (run.ts) должен выбрать другого кандидата.
 */
export function resolveCandidate(
  world: World,
  candidate: Candidate,
  streams: Streams,
): Event | null {
  const { selection, ids } = streams;
  if (candidate.kind === "act") {
    const intent = generateIntent(world, candidate.client, selection);
    return intent ? { kind: "act", client: candidate.client, intent } : null;
  }
  if (candidate.kind === "command") {
    const command = generateCommand(world, candidate.client, selection);
    return command
      ? { kind: "command", client: candidate.client, command, commandId: ids.uuid() }
      : null;
  }
  if (candidate.kind === "reload") {
    // Идентификатор нового экземпляра клиента — в решении: иначе replay выдал бы другой
    // `actorId`, а конфликты решаются по его строке (compareStamps).
    return { kind: "reload", client: candidate.client, actorId: ids.uuid() };
  }
  if (candidate.kind === "storeFault") {
    return { kind: "storeFault", afterWrites: selection.int(0, 1) };
  }
  return candidate;
}
