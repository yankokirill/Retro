// T-009 — WS-синхронизация: hello/welcome/op/ack/broadcast (protocol.md § 4–6,
// REQ-022, REQ-023 кр. 3). T-010 добавил проверку V1/V3/V4/V5
// (ops/validate.js). T-011 добавил V6 (права/фазы, ops/permissions.js) для
// операций над стикерами/action item и команду `setPhase`. T-012 добавил V7
// (голоса, ops/votes.js), команду `resetVotes` и очередь операций одной
// доски (ws/board-queue.js — пока сквозная, см. её шапку). T-013 добавил
// проекцию видимости `proj_u` (welcome/op, пока `collect`) и досылку
// скрытого после `reveal` (ops/visibility.js).
//
// Остальные команды (grantFacilitator/timer) — по-прежнему не здесь.

import type { WireDelta } from "@retro/crdt";
import { activeVotes, toWire, unvote } from "@retro/crdt";
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
import { authorOf, authorsForBoard, recordAuthor } from "../ops/authors.js";
import {
  actorClock,
  appendOp,
  type Db,
  findOp,
  findUnvoteSeq,
  opsSince,
  opsUpTo,
  replayFromSnapshot,
  welcomeData,
} from "../ops/log.js";
import { checkPermission, classifyAction } from "../ops/permissions.js";
import { validateOp } from "../ops/validate.js";
import { isEmptyDelta, projectHidden, projectVisible } from "../ops/visibility.js";
import { checkVoteLimit, checkVoteOwnership, checkVotePermission } from "../ops/votes.js";
import { BoardHub, type Subscriber } from "./board-hub.js";
import { createBoardQueue } from "./board-queue.js";
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

/**
 * T-013 (protocol.md § 6 «Reveal», REQ-004 кр.1, REQ-006): «сервер
 * рассылает всем... `op` с сущностями, которые получатель раньше не видел».
 * Раньше не видел ровно то, что `projectVisible` отфильтровала бы для него,
 * пока доска была в collect, — т.е. `projectHidden` по всему журналу доски
 * с начала (снапшоты не роняют строки `ops`, только кэшируют replay, § 6
 * `consistency-model.md`). Каждая строка журнала шлётся под своим НАСТОЯЩИМ
 * `seq` (а не синтетическим) — это тот же `op`, который получатель пропустил
 * бы живьём, если бы уже был на доске; merge на клиенте идемпотентен и не
 * зависит от порядка (I1), так что более ранний `seq`, чем уже виденный
 * получателем, безопасен.
 */
async function sendRevealCatchup(deps: WsGatewayDeps, boardId: string): Promise<void> {
  const [rows, authorsMap] = await Promise.all([
    opsSince(deps.db, boardId, 0),
    authorsForBoard(deps.db, boardId),
  ]);
  for (const subscriber of deps.hub.subscribers(boardId)) {
    for (const row of rows) {
      const hidden = projectHidden(row.delta, (id) => authorsMap.get(id), subscriber.guestId);
      if (!isEmptyDelta(hidden)) {
        deps.hub.send(subscriber, { type: "op", seq: row.seq, delta: hidden });
      }
    }
  }
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
  // Один экземпляр на весь роут (не на сокет) — очередь общая для всех
  // подключений одной доски, как и требует допущение модели (board-queue.js).
  const queue = createBoardQueue();

  app.get<{ Params: { boardId: string } }>(
    "/api/boards/:boardId/ws",
    { websocket: true },
    (socket, request) => {
      const boardId = request.params.boardId;
      let subscriber: Subscriber | null = null;

      socket.on("close", () => {
        if (subscriber) deps.hub.unsubscribe(boardId, subscriber);
      });

      // T-026 (H2): сообщения ОДНОГО соединения обрабатываются строго в
      // порядке прихода — без этого `op`, отправленный клиентом сразу вторым
      // сообщением, без ожидания `welcome` на `hello`, мог начать
      // выполняться параллельно с ещё не завершившимся `handleMessage(hello)`
      // (тот ждёт `getBoardForGuest`) и заставал `subscriber === null`,
      // получая "first message must be hello" и разрыв соединения — хотя
      // `hello` был отправлен первым и был валиден. Маленькая цепочка
      // промисов на соединение, тот же приём, что `board-queue.ts` для
      // доски. Временная заплатка: T-024 заменит её настоящей очередью
      // (каждое сообщение и отписка — через `queue.run`, SIM-05), но
      // поведение уже корректно.
      let inbox: Promise<void> = Promise.resolve();
      socket.on("message", (raw: RawData) => {
        inbox = inbox
          .then(() => handleMessage(raw.toString()))
          .catch((error: unknown) => {
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
          // proj_u (T-013, REQ-006): пока доска в collect, welcome — тоже
          // проекция получателя (protocol.md § 5 `welcome`: «всё — уже в
          // проекции proj_u»), не только живые op/broadcast.
          const authorsMap = guest.revealed ? null : await authorsForBoard(deps.db, boardId);
          const project = (delta: WireDelta) =>
            authorsMap ? projectVisible(delta, (id) => authorsMap.get(id), message.guestId) : delta;

          // T-026 (H1, ВС-2(б) docs/spec/simulator.md § 13): хвост welcome
          // (выше) несёт только seq > lastSeq — если гость был отключён на
          // момент reveal, строки, скрытые от него во время collect с
          // seq <= его собственного lastSeq, туда не попадают и без этой
          // досылки не попали бы никогда (sendRevealCatchup их тоже не
          // застал — гостя не было среди подписчиков). Диапазоны не
          // пересекаются: upper = min(lastSeq, revealSeq) <= lastSeq, а хвост
          // либо начинается с lastSeq+1 (upper < тот случай), либо со
          // снапшота с upToSeq > lastSeq >= upper (снапшот-случай) —
          // подробный разбор обоих случаев в docs/adr (при необходимости).
          let catchupOps: { readonly seq: number; readonly delta: WireDelta }[] = [];
          if (guest.revealed && message.lastSeq !== null && guest.revealSeq !== null) {
            const upper = Math.min(message.lastSeq, guest.revealSeq);
            if (upper > 0) {
              const catchupAuthorsMap = await authorsForBoard(deps.db, boardId);
              const rows = await opsUpTo(deps.db, boardId, upper);
              catchupOps = rows
                .map((row) => ({
                  seq: row.seq,
                  delta: projectHidden(
                    row.delta,
                    (id) => catchupAuthorsMap.get(id),
                    message.guestId,
                  ),
                }))
                .filter((row) => !isEmptyDelta(row.delta));
            }
          }

          send(socket, {
            type: "welcome",
            role: guest.role,
            voterToken: computeVoterToken(deps.voterTokenSecret, boardId, message.guestId),
            meta: buildMeta(guest),
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
          return;
        }

        // Псевдоним для замыканий ниже (`queue.run`): `subscriber` — `let`,
        // TS не переносит сужение до non-null через границу вложенной
        // функции; `sub` — `const`, присвоен один раз здесь же, где
        // `subscriber` уже точно не `null` (см. выше).
        const sub = subscriber;

        if (message.type === "op") {
          await queue.run(boardId, async () => {
            const dot = operationDot(message.delta);
            const lamport = operationLamport(message.delta);
            const isUnvote = message.delta.unvotes.length > 0;
            const isVote = message.delta.votes.length > 0;

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

            // ADR-0008 (REQ-023 кр.3): для unvote идемпотентность — по
            // (dot отзываемого голоса, target) в журнале, не по (actor,
            // counter) — у unvote нет своей пары. Повтор (тем же клиентом
            // заново, или уже отозвано `resetVotes`) — ack с seq уже
            // существующей записи, без повторного применения и без V7.
            if (isUnvote) {
              const existingSeq = await findUnvoteSeq(
                deps.db,
                boardId,
                dot,
                // clientDeltaSchema гарантирует ровно один элемент в unvotes.
                message.delta.unvotes[0]?.target ?? "",
              );
              if (existingSeq !== null) {
                send(socket, { type: "ack", dot, seq: existingSeq });
                return;
              }
            }

            const { state } = await replayFromSnapshot(deps.db, boardId);
            const clock = isUnvote ? null : await actorClock(deps.db, boardId, dot.actor);
            const validation = validateOp({
              state,
              connectionActorId: sub.actorId,
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

            // Фаза нужна и V6 (если операция гейтится), и проекции видимости
            // ниже (T-013) — одним запросом на op, не по одному на каждое
            // применение.
            const phase = phaseSchema.parse(await boardsService.getBoardPhase(deps.db, boardId));

            // V6 (T-011): права/фаза для стикеров и action item. `null` от
            // classifyAction — операция вне области T-011 (группы, поля
            // action item кроме создания, vote/unvote) — пропускается.
            const action = classifyAction(state, message.delta);
            if (action) {
              const [entry] = message.delta.entries;
              const isOwn =
                (action === "editSticker" || action === "moveSticker") && entry
                  ? (await authorOf(deps.db, boardId, entry.key.entity)) === sub.guestId
                  : true;
              const permission = checkPermission({
                role: sub.role,
                phase,
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

            // V7 (T-012): права/фаза, лимит, владение для vote/unvote.
            if (isVote || isUnvote) {
              const settings = await boardsService.getBoardVoteSettings(deps.db, boardId);
              if (!settings) {
                throw new Error(`vote: board unexpectedly not found (boardId=${boardId})`);
              }
              const votePermission = checkVotePermission({
                role: sub.role,
                phase: settings.phase,
                action: isVote ? "vote" : "unvote",
              });
              if (!votePermission.ok) {
                send(socket, {
                  type: "reject",
                  dot,
                  reason: votePermission.reason,
                  message: votePermission.message,
                });
                return;
              }

              const voterToken = computeVoterToken(deps.voterTokenSecret, boardId, sub.guestId);
              const voteCheck = isVote
                ? checkVoteLimit(
                    state,
                    // clientDeltaSchema гарантирует ровно один элемент в votes.
                    message.delta.votes[0]?.user ?? "",
                    voterToken,
                    settings.voteLimit,
                  )
                : checkVoteOwnership(
                    state,
                    dot,
                    // clientDeltaSchema гарантирует ровно один элемент в unvotes.
                    message.delta.unvotes[0]?.target ?? "",
                    voterToken,
                  );
              if (!voteCheck.ok) {
                send(socket, {
                  type: "reject",
                  dot,
                  reason: voteCheck.reason,
                  message: voteCheck.message,
                });
                return;
              }
            }

            // Находка code-review (fix/T-011-op-single-entity): appendOp и
            // recordAuthor — одна транзакция. Без неё сбой recordAuthor
            // посередине оставлял операцию уже в журнале без записанного
            // автора — повторная отправка того же create находила dot по
            // findOp выше и получала ack, ни разу не дойдя до recordAuthor
            // снова: стикер навсегда оставался без автора, участник не мог
            // его редактировать/удалять как свой (REQ-007/REQ-009).
            const seq = await deps.db.transaction(async (tx) => {
              const { seq } = await appendOp(tx, {
                boardId,
                dot: isUnvote ? null : dot,
                lamport,
                delta: message.delta,
              });

              const [created] = message.delta.created;
              if (created && created.kind === "sticker") {
                await recordAuthor(tx, boardId, created.id, sub.guestId);
              }

              return seq;
            });

            send(socket, { type: "ack", dot, seq });

            // proj_u (T-013, REQ-006): пока collect, у каждого получателя —
            // своя проекция этой же дельты (обычно один и тот же стикер: либо
            // целиком виден, либо целиком скрыт, т.к. клиентская дельта — одна
            // сущность, V2). После collect фильтровать нечего — шлём как есть.
            if (phase === "collect") {
              const authorsMap = await authorsForBoard(deps.db, boardId);
              deps.hub.broadcastEach(boardId, sub, (subscriber) => {
                const projected = projectVisible(
                  message.delta,
                  (id) => authorsMap.get(id),
                  subscriber.guestId,
                );
                return isEmptyDelta(projected) ? null : { type: "op", seq, delta: projected };
              });
            } else {
              deps.hub.broadcast(boardId, { type: "op", seq, delta: message.delta }, sub);
            }
          });
          return;
        }

        if (message.type === "command") {
          await queue.run(boardId, async () => {
            if (message.command.type === "setPhase") {
              // T-013, REQ-004 кр.1/REQ-006: reveal — это именно ПЕРВЫЙ уход
              // из collect (protocol.md § 6 «Reveal»), нужна фаза ДО перехода,
              // иначе неотличимо от смены между `group`/`vote`/`discuss`/`actions`,
              // где никакой досылки уже не нужно (revealed давно true).
              const phaseBefore = await boardsService.getBoardPhase(deps.db, boardId);
              const result = await boardsService.setPhase(deps.db, {
                boardId,
                guestId: sub.guestId,
                phase: message.command.phase,
              });
              if (result === "ok") {
                send(socket, { type: "commandResult", id: message.id, ok: true });
                const guest = await boardsService.getBoardForGuest(deps.db, {
                  boardId,
                  guestId: sub.guestId,
                });
                if (guest) deps.hub.broadcast(boardId, { type: "meta", meta: buildMeta(guest) });

                const isReveal = phaseBefore === "collect" && message.command.phase !== "collect";
                if (isReveal) await sendRevealCatchup(deps, boardId);
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

            if (message.command.type === "resetVotes") {
              const result = await boardsService.resetVotes(deps.db, {
                boardId,
                guestId: sub.guestId,
              });
              if (result === "not_found") {
                // Как и в setPhase — недостижимо в норме (гость уже прошёл
                // проверку членства в hello), не пытаемся угадать reason.
                throw new Error(`resetVotes: board unexpectedly not found (boardId=${boardId})`);
              }
              if (result !== "ok") {
                send(socket, {
                  type: "commandResult",
                  id: message.id,
                  ok: false,
                  reason: result,
                  message: `resetVotes: ${result}`,
                });
                return;
              }

              // REQ-016: массовый отзыв — по одному unvote на активный голос
              // (не отдельная примитивная операция CRDT), рассылается всем
              // подписчикам как обычный `op` (никто из них этот отзыв ещё не
              // применял локально — в отличие от обычного op, здесь нет
              // клиента-автора, которому уже не нужно повторно слать своё же).
              // Все вставки — в одной транзакции: частичный сбой посередине
              // не должен оставить доску с половиной отозванных голосов
              // (найдено code-review этого PR). Рассылка — уже ПОСЛЕ коммита:
              // если сама транзакция не удалась, никто не узнает о попытке.
              const { state } = await replayFromSnapshot(deps.db, boardId);
              const toBroadcast: { seq: number; delta: WireDelta }[] = [];
              await deps.db.transaction(async (tx) => {
                for (const v of activeVotes(state)) {
                  const delta = toWire(unvote(state, v.dot, v.target));
                  const { seq } = await appendOp(tx, {
                    boardId,
                    dot: null,
                    lamport: null,
                    delta,
                  });
                  toBroadcast.push({ seq, delta });
                }
              });
              for (const { seq, delta } of toBroadcast) {
                deps.hub.broadcast(boardId, { type: "op", seq, delta });
              }

              send(socket, { type: "commandResult", id: message.id, ok: true });
              return;
            }

            // Остальные команды (grantFacilitator/timer) — вне T-012, здесь
            // не реализованы.
          });
          return;
        }
      }
    },
  );
}

export { BoardHub };
