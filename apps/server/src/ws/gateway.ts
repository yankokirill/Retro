// T-009 — WS-синхронизация: hello/welcome/op/ack/broadcast (protocol.md § 4–6,
// REQ-022, REQ-023 кр. 3). T-010 добавил проверку V1/V3/V4/V5
// (ops/validate.js). T-011 добавил V6 (права/фазы, ops/permissions.js) для
// операций над стикерами/action item и команду `setPhase`.
//
// Лимит голосов (V7) — T-012, не здесь: vote/unvote проходят без проверки
// прав (`classifyAction` возвращает `null` для них, см. ops/permissions.js).
// Остальные команды (grantFacilitator/resetVotes/timer) — тоже не здесь.
import {
  type BoardMeta,
  clientMessageSchema,
  operationDot,
  operationLamport,
  phaseSchema,
  type RejectReason,
  type ServerMessage,
} from "@retro/protocol";
import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import * as boardsService from "../boards/service.js";
import { authorOf, recordAuthor } from "../ops/authors.js";
import {
  actorClock,
  appendOp,
  type Db,
  findOp,
  replayFromSnapshot,
  welcomeData,
} from "../ops/log.js";
import { checkPermission, classifyAction } from "../ops/permissions.js";
import { validateOp } from "../ops/validate.js";
import { BoardHub, type Subscriber } from "./board-hub.js";
import { computeVoterToken } from "./voter-token.js";

/** `guest` — то, что возвращает `boardsService.getBoardForGuest`/аналоги (без поля `role`). */
function buildMeta(guest: {
  boardId: string;
  title: string;
  phase: string;
  revealed: boolean;
  voteLimit: number;
  timer: null;
  authors: Record<string, string>;
}): BoardMeta {
  return {
    boardId: guest.boardId,
    title: guest.title,
    phase: phaseSchema.parse(guest.phase),
    revealed: guest.revealed,
    voteLimit: guest.voteLimit,
    timer: guest.timer,
    authors: guest.authors,
  };
}

export interface WsGatewayDeps {
  readonly db: Db;
  readonly hub: BoardHub;
  readonly voterTokenSecret: string;
}

function send(socket: Subscriber["socket"], message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

function sendError(socket: Subscriber["socket"], reason: RejectReason, message: string): void {
  send(socket, { type: "error", reason, message });
}

/**
 * Регистрирует `GET /api/boards/:boardId/ws`. Один сокет = один актор одной
 * доски на время соединения; идентичность приходит первым сообщением
 * (`hello`), не заголовком — у браузерного `WebSocket` нет произвольных
 * заголовков (protocol.md § 4). Любая необработанная ошибка в обработчике —
 * сигнал «не реализовано/сломано»: ловится один раз на весь обработчик,
 * клиенту уходит `error`, соединение закрывается (не роняет процесс).
 */
export function registerBoardWebSocket(app: FastifyInstance, deps: WsGatewayDeps): void {
  app.get<{ Params: { boardId: string } }>(
    "/api/boards/:boardId/ws",
    { websocket: true },
    (socket, request) => {
      const boardId = request.params.boardId;
      let subscriber: Subscriber | null = null;

      socket.on("close", () => {
        if (subscriber) deps.hub.unsubscribe(boardId, subscriber);
      });

      socket.on("message", (raw: RawData) => {
        void handleMessage(raw.toString()).catch((error: unknown) => {
          request.log.error(error, "ws message handling failed");
          // Ни одна причина из RejectReason не описывает «не реализовано/
          // внутренняя ошибка» — это осознанно: точные причины отказа по
          // V1–V7 появятся в T-010/T-011/T-012. `forbidden` здесь — общий
          // предохранитель, не диагноз конкретного правила.
          sendError(socket, "forbidden", error instanceof Error ? error.message : String(error));
          socket.close();
        });
      });

      async function handleMessage(raw: string): Promise<void> {
        const parsed = clientMessageSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) {
          sendError(socket, "invalid_shape", parsed.error.message);
          socket.close();
          return;
        }
        const message = parsed.data;

        if (!subscriber) {
          if (message.type !== "hello") {
            sendError(socket, "invalid_shape", "first message must be hello");
            socket.close();
            return;
          }
          const guest = await boardsService.getBoardForGuest(deps.db, {
            boardId,
            guestId: message.guestId,
          });
          if (!guest) {
            sendError(socket, "forbidden", "not a board member — join via invite link first");
            socket.close();
            return;
          }

          subscriber = {
            socket,
            actorId: message.actorId,
            guestId: message.guestId,
            role: guest.role,
          };
          deps.hub.subscribe(boardId, subscriber);

          const welcome = await welcomeData(deps.db, boardId, message.lastSeq);
          send(socket, {
            type: "welcome",
            role: guest.role,
            voterToken: computeVoterToken(deps.voterTokenSecret, boardId, message.guestId),
            meta: buildMeta(guest),
            snapshot: welcome.snapshot,
            ops: welcome.ops,
          });
          return;
        }

        if (message.type === "op") {
          const dot = operationDot(message.delta);
          const lamport = operationLamport(message.delta);
          const isUnvote = message.delta.unvotes.length > 0;

          // V1: точное совпадение (actor, counter) в журнале — повтор
          // (переподключение, дубль доставки), не новая операция: ack без
          // повторной валидации. Не применяется к unvote — у него нет
          // собственной пары (actor, counter), см. JSDoc AppendOpParams.dot.
          if (!isUnvote) {
            const existing = await findOp(deps.db, boardId, dot.actor, dot.counter);
            if (existing) {
              send(socket, { type: "ack", dot, seq: existing.seq });
              return;
            }
          }

          const { state } = await replayFromSnapshot(deps.db, boardId);
          const clock = isUnvote ? null : await actorClock(deps.db, boardId, dot.actor);
          const validation = validateOp({
            state,
            connectionActorId: subscriber.actorId,
            delta: message.delta,
            actorClock: clock,
          });
          if (!validation.ok) {
            send(socket, {
              type: "reject",
              dot,
              reason: validation.reason,
              message: validation.message,
            });
            return;
          }

          // V6 (T-011): права/фаза для стикеров и action item. `null` от
          // classifyAction — операция вне области T-011 (группы, поля
          // action item кроме создания, vote/unvote) — пропускается.
          const action = classifyAction(state, message.delta);
          if (action) {
            const phaseRaw = await boardsService.getBoardPhase(deps.db, boardId);
            const [entry] = message.delta.entries;
            const isOwn =
              action === "editSticker" && entry
                ? (await authorOf(deps.db, boardId, entry.key.entity)) === subscriber.guestId
                : true;
            const permission = checkPermission({
              role: subscriber.role,
              phase: phaseSchema.parse(phaseRaw),
              action,
              isOwn,
            });
            if (!permission.ok) {
              send(socket, {
                type: "reject",
                dot,
                reason: permission.reason,
                message: permission.message,
              });
              return;
            }
          }

          const { seq } = await appendOp(deps.db, {
            boardId,
            dot: isUnvote ? null : dot,
            lamport,
            delta: message.delta,
          });

          const [created] = message.delta.created;
          if (created && created.kind === "sticker") {
            await recordAuthor(deps.db, boardId, created.id, subscriber.guestId);
          }

          send(socket, { type: "ack", dot, seq });
          deps.hub.broadcast(boardId, { type: "op", seq, delta: message.delta }, subscriber);
          return;
        }

        if (message.type === "command") {
          if (message.command.type === "setPhase") {
            const result = await boardsService.setPhase(deps.db, {
              boardId,
              guestId: subscriber.guestId,
              phase: message.command.phase,
            });
            if (result === "ok") {
              send(socket, { type: "commandResult", id: message.id, ok: true });
              const guest = await boardsService.getBoardForGuest(deps.db, {
                boardId,
                guestId: subscriber.guestId,
              });
              if (guest) deps.hub.broadcast(boardId, { type: "meta", meta: buildMeta(guest) });
              return;
            }
            if (result === "not_found") {
              // Гость уже прошёл проверку членства в hello — это состояние
              // недостижимо в норме (доска не могла исчезнуть посреди
              // сессии); не пытаемся угадать reason, ловится общим catch.
              throw new Error(`setPhase: board unexpectedly not found (boardId=${boardId})`);
            }
            send(socket, {
              type: "commandResult",
              id: message.id,
              ok: false,
              reason: result,
              message: `setPhase: ${result}`,
            });
            return;
          }

          // Остальные команды (grantFacilitator/resetVotes/timer) — вне
          // T-011, здесь не реализованы.
          return;
        }
      }
    },
  );
}

export { BoardHub };
