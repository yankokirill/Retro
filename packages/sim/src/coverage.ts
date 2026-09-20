// Учёт покрытия трудных ситуаций — SIM-11 (§ 10.1) и SIM-04 (§ 4.3) спецификации.
// Только записывает факты в `world.stats` по наблюдениям apply.ts/run.ts;
// ничего не проверяет и мир не меняет (кроме самой статистики).

import { materialize } from "@retro/crdt";
import type { Phase } from "@retro/protocol";
import type { Direction } from "./network.js";
import type { World } from "./world.js";

/** Разобранное сообщение «клиент → сервер» — только поля, нужные учёту. */
export interface IncomingFacts {
  readonly type?: string;
  readonly delta?: { readonly unvotes?: readonly unknown[]; readonly votes?: readonly unknown[] };
  readonly command?: { readonly type?: string };
}

/** Разобранное сообщение «сервер → клиент» — только поля, нужные учёту. */
export interface SentFacts {
  readonly type?: string;
  readonly reason?: string;
  readonly ok?: boolean;
  readonly snapshot?: unknown;
}

export interface ServerStepFacts {
  readonly connectionIndex: number;
  readonly incoming: IncomingFacts;
  readonly sent: readonly SentFacts[];
  readonly newLogRows: number;
  readonly phaseBefore: Phase;
  readonly phaseAfter: Phase;
}

/** Верхняя граница UTF-8 длины — 3 байта на единицу UTF-16; точный счёт только когда рекорд возможен. */
export function noteMessageBytes(world: World, direction: Direction, raw: string): void {
  const current = world.stats.maxMessageBytes[direction];
  if (raw.length * 3 <= current) return;
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > current) world.stats.maxMessageBytes[direction] = bytes;
}

function hasVoteReset(incoming: IncomingFacts): boolean {
  return incoming.type === "command" && incoming.command?.type === "resetVotes";
}

/** Факты одного шага `deliver toServer`. */
export function recordServerStep(world: World, facts: ServerStepFacts): void {
  const { stats } = world;
  const { coverage } = stats;
  const { incoming } = facts;

  for (const message of facts.sent) {
    if (message.type === "welcome") {
      if (message.snapshot) coverage.welcomeWithSnapshot = true;
      else coverage.welcomeTailOnly = true;
    } else if (message.type === "ack") {
      if (facts.newLogRows > 0) {
        stats.accepted += 1;
      } else {
        // ack без новой строки журнала — идемпотентный повтор уже записанной операции
        stats.duplicateAcks += 1;
        if (incoming.delta?.unvotes && incoming.delta.unvotes.length > 0) {
          coverage.duplicateAckUnvote = true;
        } else {
          coverage.duplicateAckWrite = true;
        }
      }
    } else if (
      (message.type === "reject" || (message.type === "commandResult" && message.ok === false)) &&
      message.reason
    ) {
      coverage.rejectReasonsSeen.add(message.reason);
      stats.rejectedByReason[message.reason] = (stats.rejectedByReason[message.reason] ?? 0) + 1;
      if (message.reason === "vote_limit" && voteLimitFromOwnTabs(world, facts.connectionIndex)) {
        coverage.voteLimitFromOwnTabs = true;
      }
    }
  }

  if (
    incoming.type === "command" &&
    incoming.command?.type === "setPhase" &&
    facts.phaseBefore === "collect" &&
    facts.phaseAfter !== "collect" &&
    revealWithDisconnectedMissingStickers(world)
  ) {
    coverage.revealWithDisconnectedMissingStickers = true;
  }

  if (hasVoteReset(incoming) && resetVotesRacesUnvote(world)) {
    coverage.resetVotesConcurrentWithUnvote = true;
  }
}

/** Клиент без соединения, у которого в `X_c` нет хотя бы одного стикера другого гостя. */
function revealWithDisconnectedMissingStickers(world: World): boolean {
  for (const client of world.clients) {
    if (client.connection !== null) continue;
    const guest = world.guests[client.guestIndex];
    if (!guest) continue;
    const known = new Set<string>();
    for (const created of client.core.inspect().confirmed.created.values()) known.add(created.id);
    for (const [id, author] of world.oracle.stickerAuthor) {
      if (author !== guest.id && !known.has(id)) return true;
    }
  }
  return false;
}

/** vote_limit гостю, у которого несколько вкладок, а голоса подавались минимум из двух из них. */
function voteLimitFromOwnTabs(world: World, connectionIndex: number): boolean {
  const connection = world.connections[connectionIndex];
  const owner = connection ? world.clients[connection.clientIndex] : undefined;
  if (!owner) return false;
  const tabs = world.clients.filter((c) => c.guestIndex === owner.guestIndex);
  if (tabs.length < 2) return false;
  for (const other of tabs) {
    if (other === owner) continue;
    const snapshot = other.core.inspect();
    if (snapshot.pending.some((entry) => entry.delta.votes.length > 0)) return true;
    for (const vote of world.oracle.x.votes.values()) {
      if (vote.dot.actor === snapshot.actorId) return true;
    }
  }
  return false;
}

/** В момент `resetVotes` у кого-то в очереди `unvote` голоса, который ещё не отозван в журнале. */
function resetVotesRacesUnvote(world: World): boolean {
  for (const client of world.clients) {
    for (const entry of client.core.inspect().pending) {
      if (entry.kind !== "unvote") continue;
      const revoked = entry.delta.unvotes[0];
      if (!revoked) continue;
      const active = [...world.oracle.x.votes.values()].some(
        (vote) => vote.dot.actor === revoked.dot.actor && vote.dot.counter === revoked.dot.counter,
      );
      const alreadyRevoked = [...world.oracle.x.unvotes.values()].some(
        (unvote) =>
          unvote.dot.actor === revoked.dot.actor && unvote.dot.counter === revoked.dot.counter,
      );
      if (active && !alreadyRevoked) return true;
    }
  }
  return false;
}

/** На контрольной точке: `conflict = true` у текста стикера и у названия группы одновременно. */
export function recordConflictAtCheckpoint(world: World): void {
  if (world.stats.coverage.conflictAtCheckpoint) return;
  const view = materialize(world.oracle.x);
  let card = false;
  let group = false;
  for (const items of view.columns.values()) {
    for (const item of items) {
      if ("cards" in item) {
        if (item.conflict) group = true;
        for (const inner of item.cards) if (inner.conflict) card = true;
      } else if (item.conflict) {
        card = true;
      }
    }
  }
  if (card && group) world.stats.coverage.conflictAtCheckpoint = true;
}
