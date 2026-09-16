// T-009…T-013, T-026 — WS-синхронизация (protocol.md § 4–6). T-024: вся
// логика приёма/валидации/рассылки переехала в `@retro/server-core`
// (`createBoardServer`, docs/design/T-005-simulator.md § 3) — этот файл
// теперь только маршрутизация: настоящий сокет ↔ `BoardServer.receive`/
// `.close`. Порядок и атомарность сообщений одного соединения и одной
// доски (H2, находка 1 code-review PR #19) — теперь встроенное свойство
// `createBoardServer` (SIM-05), а не заплатки здесь.

import { randomUUID } from "node:crypto";
import type { WebSocket } from "@fastify/websocket";
import { type ConnectionId, createBoardServer } from "@retro/server-core";
import type { FastifyInstance } from "fastify";
import type { Db } from "../boards/service.js";
import { PgBoardStore } from "../store/pg-store.js";
import { computeVoterToken } from "./voter-token.js";

export interface WsGatewayDeps {
  readonly db: Db;
  readonly voterTokenSecret: string;
}

/**
 * Регистрирует `GET /api/boards/:boardId/ws`. Один сокет = один актор одной
 * доски на время соединения; идентичность приходит первым сообщением
 * (`hello`), не заголовком — у браузерного `WebSocket` нет произвольных
 * заголовков (protocol.md § 4).
 */
export function registerBoardWebSocket(app: FastifyInstance, deps: WsGatewayDeps): void {
  // Один BoardServer на весь роут (не на сокет) — очередь общая для всех
  // подключений одной доски, как и требует допущение модели (I6, § 8
  // consistency-model.md; queue.ts в @retro/server-core).
  const store = new PgBoardStore(deps.db);
  const server = createBoardServer({
    store,
    voterToken: (boardId, guestId) => computeVoterToken(deps.voterTokenSecret, boardId, guestId),
    // Тот же предохранитель, что раньше был в этом файле (T-009): «не
    // реализовано/сломано», не диагноз конкретного правила V1–V7 (те уже
    // обработаны внутри createBoardServer и сюда не долетают).
    onInternalError: (error, ctx) => {
      app.log.error(error, `ws message handling failed (board=${ctx.boardId})`);
    },
  });

  // Реальные сокеты по ConnectionId — общие для всего роута (не на доску:
  // ConnectionId уникален глобально), потому что `ReceiveResult.outgoing`
  // адресует сообщения ЛЮБОМУ соединению доски (рассылка другим
  // подписчикам), не только тому, что вызвало `receive`.
  const sockets = new Map<ConnectionId, WebSocket>();

  app.get<{ Params: { boardId: string } }>(
    "/api/boards/:boardId/ws",
    { websocket: true },
    (socket, request) => {
      const boardId = request.params.boardId;
      // ID соединения — внутренний ключ BoardServer, не часть протокола;
      // сокету не нужно (и не должно) быть в курсе своего собственного ID.
      const connection = randomUUID();
      sockets.set(connection, socket);
      server.open(connection, boardId);

      socket.on("close", () => {
        sockets.delete(connection);
        void server.close(connection);
      });

      // Синхронный вызов receive() на каждое сообщение — без обёртки-цепочки
      // промисов (та временная заплатка T-026 для H2 здесь больше не нужна):
      // порядок сообщений одного соединения гарантирует сам BoardServer
      // (receive() встаёт в очередь доски синхронно, до первого await, SIM-05
      // кр. 2). Два message-события этого сокета, пришедшие без await между
      // ними, — то же самое "H2", что теперь чинится архитектурно.
      socket.on("message", (raw) => {
        server
          .receive(connection, raw.toString())
          .then((result) => {
            // Каждое исходящее сообщение — своему адресату (`message.to`),
            // не обязательно тому же сокету, что прислал raw (broadcast).
            // Изоляция по получателю (code-review PR #20, находка 2): если
            // send одному сокету бросит (например, тот уже в состоянии
            // CLOSING), это не должно ни прервать доставку остальным, ни
            // закрыть чужой сокет-инициатор, который тут вообще ни при чём.
            for (const message of result.outgoing) {
              const target = sockets.get(message.to);
              if (!target) continue;
              try {
                target.send(message.raw);
              } catch (error) {
                app.log.error(error, `ws send failed (board=${boardId}, to=${message.to})`);
              }
            }
            for (const closingConnection of result.close) {
              const target = sockets.get(closingConnection);
              if (!target) continue;
              try {
                target.close();
              } catch (error) {
                app.log.error(error, `ws close failed (board=${boardId}, id=${closingConnection})`);
              }
            }
          })
          .catch((error: unknown) => {
            // Защита в глубину: createBoardServer сам ловит все ошибки
            // обработчиков и превращает их в error+close (см. board-server.ts) —
            // сюда долетает только то, что сломалось уже на границе адаптера
            // (например сама server.receive(), см. board-server.ts "was not
            // open()ed"). Закрываем только СВОЙ сокет — тот, что прислал raw.
            app.log.error(error, `ws adapter failed (board=${boardId})`);
            socket.close();
          });
      });
    },
  );
}
