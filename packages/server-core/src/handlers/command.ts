// T-024 — перенос ветки `command` (setPhase/resetVotes) из apps/server/src/
// ws/gateway.ts (T-012, T-013) на порт `BoardStore`. `boardsService.setPhase`/
// `resetVotes` (apps/server/src/boards/service.ts) заменены здесь той же
// логикой поверх `store.board`/`store.memberRole`/`rules/board.ts` — прямых
// SQL-запросов больше нет, только методы порта.

import type { WireDelta } from "@retro/crdt";
import { activeVotes, toWire, unvote } from "@retro/crdt";
import type { ClientMessage, Phase } from "@retro/protocol";
import type { ConnectionId } from "../board-server.js";
import { checkResetVotes, checkSetPhase, resolveRole } from "../rules/board.js";
import { isEmptyDelta, projectHidden } from "../rules/visibility.js";
import type { BoardStore } from "../store.js";
import type { Subscriber } from "../subscribers.js";
import { buildMeta, getBoardForGuest } from "./board-info.js";
import type { HandlerContext } from "./context.js";

type CommandMessage = Extract<ClientMessage, { type: "command" }>;

type SetPhaseResult = "ok" | "forbidden" | "irreversible_phase" | "not_found";

/**
 * REQ-004 (кр. 2, 4). `not_found` — доска не существует, ИЛИ `guestId` не
 * `owner` и не встречается в участниках (`resolveRole` возвращает `null`
 * ровно в этом случае — см. JSDoc `resolveRole`, rules/board.ts); только
 * настоящий участник с недостаточной ролью получает `forbidden`.
 */
async function setPhase(
  store: BoardStore,
  params: { boardId: string; guestId: string; phase: Phase },
): Promise<SetPhaseResult> {
  const board = await store.board(params.boardId);
  if (!board) return "not_found";

  const memberRole = await store.memberRole(params.boardId, params.guestId);
  const role = resolveRole({ ownerId: board.ownerId, guestId: params.guestId, memberRole });
  if (!role) return "not_found";

  const check = checkSetPhase(role, board.phase, params.phase);
  if (check !== "ok") return check;

  // T-026, ВС-2(б) (H1): запоминаем seq доски на момент первого ухода из
  // collect — welcome (handlers/hello.ts) досылает по нему переподключившемуся
  // гостю то, что было скрыто во время collect. Гонки со store.lastSeq нет:
  // весь этот handler выполняется внутри очереди доски (board-server.ts).
  const isReveal = board.phase === "collect" && params.phase !== "collect";
  const revealSeq = isReveal ? await store.lastSeq(params.boardId) : board.revealSeq;
  await store.updatePhase(params.boardId, params.phase, revealSeq);
  return "ok";
}

type ResetVotesResult = "ok" | "forbidden" | "not_found";

/** REQ-016. Та же логика not_found/forbidden, что и `setPhase` выше. */
async function resetVotes(
  store: BoardStore,
  params: { boardId: string; guestId: string },
): Promise<ResetVotesResult> {
  const board = await store.board(params.boardId);
  if (!board) return "not_found";

  const memberRole = await store.memberRole(params.boardId, params.guestId);
  const role = resolveRole({ ownerId: board.ownerId, guestId: params.guestId, memberRole });
  if (!role) return "not_found";

  return checkResetVotes(role);
}

/**
 * T-013 (protocol.md § 6 «Reveal», REQ-004 кр.1, REQ-006): «сервер рассылает
 * всем... `op` с сущностями, которые получатель раньше не видел» — по всему
 * журналу доски с начала, отфильтрованному `projectHidden` под каждого
 * получателя. Перенос `sendRevealCatchup` (ws/gateway.ts) на порт `BoardStore`.
 */
async function sendRevealCatchup(ctx: HandlerContext, boardId: string): Promise<void> {
  const [rows, authorsMap] = await Promise.all([
    ctx.store.opsSince(boardId, 0),
    ctx.store.authors(boardId),
  ]);
  for (const subscriber of ctx.registry.subscribersOf(boardId)) {
    for (const row of rows) {
      const hidden = projectHidden(row.delta, (id) => authorsMap.get(id), subscriber.guestId);
      if (!isEmptyDelta(hidden)) {
        ctx.sink.send(subscriber.connection, { type: "op", seq: row.seq, delta: hidden });
      }
    }
  }
}

export async function handleCommand(
  ctx: HandlerContext,
  connection: ConnectionId,
  boardId: string,
  sub: Subscriber,
  message: CommandMessage,
): Promise<void> {
  if (message.command.type === "setPhase") {
    // T-013, REQ-004 кр.1/REQ-006: reveal — это именно ПЕРВЫЙ уход из
    // collect, нужна фаза ДО перехода.
    const phaseBefore = (await ctx.store.board(boardId))?.phase;
    const result = await setPhase(ctx.store, {
      boardId,
      guestId: sub.guestId,
      phase: message.command.phase,
    });
    if (result === "ok") {
      ctx.sink.send(connection, { type: "commandResult", id: message.id, ok: true });
      const guest = await getBoardForGuest(ctx.store, boardId, sub.guestId);
      if (guest) {
        const meta = buildMeta(boardId, guest);
        for (const subscriber of ctx.registry.subscribersOf(boardId)) {
          ctx.sink.send(subscriber.connection, { type: "meta", meta });
        }
      }

      const isReveal = phaseBefore === "collect" && message.command.phase !== "collect";
      if (isReveal) await sendRevealCatchup(ctx, boardId);
      return;
    }
    if (result === "not_found") {
      // Гость уже прошёл проверку членства в hello — недостижимо в норме.
      throw new Error(`setPhase: board unexpectedly not found (boardId=${boardId})`);
    }
    ctx.sink.send(connection, {
      type: "commandResult",
      id: message.id,
      ok: false,
      reason: result,
      message: `setPhase: ${result}`,
    });
    return;
  }

  if (message.command.type === "resetVotes") {
    const result = await resetVotes(ctx.store, { boardId, guestId: sub.guestId });
    if (result === "not_found") {
      throw new Error(`resetVotes: board unexpectedly not found (boardId=${boardId})`);
    }
    if (result !== "ok") {
      ctx.sink.send(connection, {
        type: "commandResult",
        id: message.id,
        ok: false,
        reason: result,
        message: `resetVotes: ${result}`,
      });
      return;
    }

    // REQ-016: массовый отзыв — по одному unvote на активный голос,
    // рассылается всем подписчикам как обычный `op` (никто из них этот
    // отзыв ещё не применял локально). Все вставки — в одной транзакции.
    const { state } = await ctx.store.currentState(boardId);
    const toBroadcast: { seq: number; delta: WireDelta }[] = [];
    await ctx.store.transaction(async (tx) => {
      for (const v of activeVotes(state)) {
        const delta = toWire(unvote(state, v.dot, v.target));
        const { seq } = await tx.appendOp({ boardId, dot: null, lamport: null, delta });
        toBroadcast.push({ seq, delta });
      }
    });
    for (const { seq, delta } of toBroadcast) {
      for (const subscriber of ctx.registry.subscribersOf(boardId)) {
        ctx.sink.send(subscriber.connection, { type: "op", seq, delta });
      }
    }

    ctx.sink.send(connection, { type: "commandResult", id: message.id, ok: true });
    return;
  }

  // Остальные команды (grantFacilitator/timer) — вне T-012, здесь не реализованы.
}
