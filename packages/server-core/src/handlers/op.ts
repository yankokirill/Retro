// T-024 — перенос ветки `op` из apps/server/src/ws/gateway.ts (T-009…T-013)
// на порт `BoardStore`. Порядок проверок (идемпотентность V1 → validateOp
// V1/V3/V4/V5 → V6 → V7 → запись → ack → рассылка) и тексты `reason` не
// меняются — почти построчный перенос.

import type { ClientMessage } from "@retro/protocol";
import { operationDot, operationLamport, phaseSchema } from "@retro/protocol";
import type { ConnectionId } from "../board-server.js";
import { checkPermission, classifyAction } from "../rules/permissions.js";
import { validateOp } from "../rules/validate.js";
import { isEmptyDelta, projectVisible } from "../rules/visibility.js";
import { checkVoteLimit, checkVoteOwnership, checkVotePermission } from "../rules/votes.js";
import type { Subscriber } from "../subscribers.js";
import type { HandlerContext } from "./context.js";

type OpMessage = Extract<ClientMessage, { type: "op" }>;

export async function handleOp(
  ctx: HandlerContext,
  connection: ConnectionId,
  boardId: string,
  sub: Subscriber,
  message: OpMessage,
): Promise<void> {
  const dot = operationDot(message.delta);
  const lamport = operationLamport(message.delta);
  const isUnvote = message.delta.unvotes.length > 0;
  const isVote = message.delta.votes.length > 0;

  // V1: точное совпадение (actor, counter) в журнале — повтор
  // (переподключение, дубль доставки), не новая операция: ack без повторной
  // валидации. Не применяется к unvote — у него нет собственной пары
  // (actor, counter).
  if (!isUnvote) {
    const existingSeq = await ctx.store.findOpSeq(boardId, dot);
    if (existingSeq !== null) {
      ctx.sink.send(connection, { type: "ack", dot, seq: existingSeq });
      return;
    }
  }

  // ADR-0008 (REQ-023 кр.3): для unvote идемпотентность — по (dot
  // отзываемого голоса, target) в журнале, не по (actor, counter).
  if (isUnvote) {
    const existingSeq = await ctx.store.findUnvoteSeq(
      boardId,
      dot,
      message.delta.unvotes[0]?.target ?? "",
    );
    if (existingSeq !== null) {
      ctx.sink.send(connection, { type: "ack", dot, seq: existingSeq });
      return;
    }
  }

  const { state } = await ctx.store.currentState(boardId);
  const clock = isUnvote ? null : await ctx.store.actorClock(boardId, dot.actor);
  const validation = validateOp({
    state,
    connectionActorId: sub.actorId,
    delta: message.delta,
    actorClock: clock,
  });
  if (!validation.ok) {
    ctx.sink.send(connection, {
      type: "reject",
      dot,
      reason: validation.reason,
      message: validation.message,
    });
    return;
  }

  // T-024: один store.board() вместо двух отдельных запросов, которые
  // apps/server делал (getBoardPhase для V6, getBoardVoteSettings — фаза +
  // voteLimit — для V7): порт возвращает оба сразу. Поведение не меняется —
  // внутри очереди доски (SIM-05) фаза не может смениться между "чтением
  // для V6" и "чтением для V7", так что это не гонка, а просто одно
  // обращение к хранилищу вместо двух.
  const board = await ctx.store.board(boardId);
  if (!board) throw new Error(`op: board unexpectedly not found (boardId=${boardId})`);
  const phase = phaseSchema.parse(board.phase);

  // V6 (T-011): права/фаза для стикеров и action item. `null` от
  // classifyAction — операция вне области T-011, пропускается.
  const action = classifyAction(state, message.delta);
  if (action) {
    const [entry] = message.delta.entries;
    // Порт BoardStore не даёт lookup автора одной сущности (только всех
    // сразу, store.authors) — apps/server использовал более узкий
    // authorOf(db, boardId, entityId). Тот же результат, один лишний
    // проход по (небольшой, REQ-023: сотни операций) таблице авторов
    // доски вместо точечного запроса — не влияет на корректность.
    const isOwn =
      (action === "editSticker" || action === "moveSticker") && entry
        ? (await ctx.store.authors(boardId)).get(entry.key.entity) === sub.guestId
        : true;
    const permission = checkPermission({ role: sub.role, phase, action, isOwn });
    if (!permission.ok) {
      ctx.sink.send(connection, {
        type: "reject",
        dot,
        reason: permission.reason,
        message: permission.message,
      });
      return;
    }
  }

  // V7 (T-012): права/фаза, лимит, владение для vote/unvote.
  if (isVote || isUnvote) {
    const votePermission = checkVotePermission({
      role: sub.role,
      phase,
      action: isVote ? "vote" : "unvote",
    });
    if (!votePermission.ok) {
      ctx.sink.send(connection, {
        type: "reject",
        dot,
        reason: votePermission.reason,
        message: votePermission.message,
      });
      return;
    }

    const voterToken = ctx.voterToken(boardId, sub.guestId);
    const voteCheck = isVote
      ? checkVoteLimit(state, message.delta.votes[0]?.user ?? "", voterToken, board.voteLimit)
      : checkVoteOwnership(state, dot, message.delta.unvotes[0]?.target ?? "", voterToken);
    if (!voteCheck.ok) {
      ctx.sink.send(connection, {
        type: "reject",
        dot,
        reason: voteCheck.reason,
        message: voteCheck.message,
      });
      return;
    }
  }

  const seq = await ctx.store.transaction(async (tx) => {
    const { seq } = await tx.appendOp({
      boardId,
      dot: isUnvote ? null : dot,
      lamport,
      delta: message.delta,
    });
    const [created] = message.delta.created;
    if (created && created.kind === "sticker") {
      await tx.recordAuthor(boardId, created.id, sub.guestId);
    }
    return seq;
  });

  ctx.sink.send(connection, { type: "ack", dot, seq });

  // proj_u (T-013, REQ-006): пока collect, у каждого получателя — своя
  // проекция этой же дельты. После collect фильтровать нечего — шлём как есть.
  if (phase === "collect") {
    const authorsMap = await ctx.store.authors(boardId);
    for (const subscriber of ctx.registry.subscribersOf(boardId)) {
      if (subscriber.connection === connection) continue;
      const projected = projectVisible(
        message.delta,
        (id) => authorsMap.get(id),
        subscriber.guestId,
      );
      if (!isEmptyDelta(projected)) {
        ctx.sink.send(subscriber.connection, { type: "op", seq, delta: projected });
      }
    }
  } else {
    for (const subscriber of ctx.registry.subscribersOf(boardId)) {
      if (subscriber.connection === connection) continue;
      ctx.sink.send(subscriber.connection, { type: "op", seq, delta: message.delta });
    }
  }
}
