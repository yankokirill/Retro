// T-024 — перенос ветки `hello` из apps/server/src/ws/gateway.ts (T-009,
// T-013, T-026 H1) на порт `BoardStore`. Вызывается уже ИЗНУТРИ очереди
// доски (`board-server.ts`'s `dispatch`, через `queue.run`) — этим
// автоматически чинится находка 1 code-review PR #19 (T-026): здесь не
// нужна отдельная обёртка `queue.run(boardId, ...)`, как в `gateway.ts` —
// атомарность каждого `receive()` гарантирует всё ядро (`createBoardServer`,
// SIM-05), а не отдельная заплатка внутри этой ветки.

import type { WireDelta } from "@retro/crdt";
import { toWire } from "@retro/crdt";
import type { ClientMessage } from "@retro/protocol";
import type { ConnectionId } from "../board-server.js";
import { isEmptyDelta, projectHidden, projectVisible } from "../rules/visibility.js";
import type { BoardStore } from "../store.js";
import type { Subscriber } from "../subscribers.js";
import { buildMeta, getBoardForGuest } from "./board-info.js";
import type { HandlerContext } from "./context.js";

type HelloMessage = Extract<ClientMessage, { type: "hello" }>;

interface WelcomeOps {
  readonly snapshot: { readonly upToSeq: number; readonly state: WireDelta } | null;
  readonly ops: readonly { readonly seq: number; readonly delta: WireDelta }[];
}

/**
 * T-009, `welcome` при подключении (protocol.md § 6 «Подключение»): если
 * `lastSeq` не задан или старше последнего снапшота — снапшот целиком плюс
 * хвост журнала после него; иначе — только операции с `seq > lastSeq`.
 * Перенесено с `ops/log.ts` `welcomeData` на порт `BoardStore`.
 */
async function welcomeData(
  store: BoardStore,
  boardId: string,
  lastSeq: number | null,
): Promise<WelcomeOps> {
  const snapshot = await store.latestSnapshot(boardId);
  const baseline = snapshot?.uptoSeq ?? 0;
  const needsSnapshot = lastSeq === null || lastSeq < baseline;
  const rows = await store.opsSince(boardId, needsSnapshot ? baseline : lastSeq);
  return {
    snapshot:
      needsSnapshot && snapshot
        ? { upToSeq: snapshot.uptoSeq, state: toWire(snapshot.state) }
        : null,
    ops: rows,
  };
}

export async function handleHello(
  ctx: HandlerContext,
  connection: ConnectionId,
  boardId: string,
  message: HelloMessage,
): Promise<void> {
  const guest = await getBoardForGuest(ctx.store, boardId, message.guestId);
  if (!guest) {
    ctx.sink.send(connection, {
      type: "error",
      reason: "forbidden",
      message: "not a board member — join via invite link first",
    });
    ctx.sink.close(connection);
    return;
  }

  const subscriber: Subscriber = {
    connection,
    actorId: message.actorId,
    guestId: message.guestId,
    role: guest.role,
  };
  ctx.registry.subscribe(boardId, subscriber);

  const welcome = await welcomeData(ctx.store, boardId, message.lastSeq);
  // proj_u (T-013, REQ-006): пока доска в collect, welcome — тоже проекция
  // получателя (protocol.md § 5 «welcome»: «всё — уже в проекции proj_u»).
  const authorsMap = guest.revealed ? null : await ctx.store.authors(boardId);
  const project = (delta: WireDelta): WireDelta =>
    authorsMap ? projectVisible(delta, (id) => authorsMap.get(id), message.guestId) : delta;

  // T-026 (H1, ВС-2(б) docs/spec/simulator.md § 13): хвост welcome (выше)
  // несёт только seq > lastSeq — если гость был отключён на момент reveal,
  // строки, скрытые от него во время collect с seq <= его собственного
  // lastSeq, туда не попадают. Диапазоны не пересекаются: upper =
  // min(lastSeq, revealSeq) <= lastSeq, а хвост либо начинается с lastSeq+1,
  // либо со снапшота с upToSeq > lastSeq >= upper.
  let catchupOps: { readonly seq: number; readonly delta: WireDelta }[] = [];
  if (guest.revealed && message.lastSeq !== null && guest.revealSeq !== null) {
    const upper = Math.min(message.lastSeq, guest.revealSeq);
    if (upper > 0) {
      const catchupAuthorsMap = await ctx.store.authors(boardId);
      const rows = await ctx.store.opsUpTo(boardId, upper);
      catchupOps = rows
        .map((row) => ({
          seq: row.seq,
          delta: projectHidden(row.delta, (id) => catchupAuthorsMap.get(id), message.guestId),
        }))
        .filter((row) => !isEmptyDelta(row.delta));
    }
  }

  ctx.sink.send(connection, {
    type: "welcome",
    role: guest.role,
    voterToken: ctx.voterToken(boardId, message.guestId),
    meta: buildMeta(boardId, guest),
    snapshot: welcome.snapshot
      ? { upToSeq: welcome.snapshot.upToSeq, state: project(welcome.snapshot.state) }
      : null,
    ops: [
      ...catchupOps,
      ...welcome.ops
        .map((row) => ({ seq: row.seq, delta: project(row.delta) }))
        .filter((row) => !isEmptyDelta(row.delta)),
    ],
  });
}
