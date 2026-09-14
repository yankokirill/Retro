import websocketPlugin from "@fastify/websocket";
import {
  boardIdSchema,
  createBoardRequestSchema,
  displayNameSchema,
  type ErrorResponse,
  GUEST_ID_HEADER,
  guestIdSchema,
  LIMITS,
  linkTokenSchema,
} from "@retro/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "./boards/service.js";
import * as boardsService from "./boards/service.js";
import { BoardHub } from "./ws/board-hub.js";
import { registerBoardWebSocket } from "./ws/gateway.js";

export interface AppDeps {
  readonly db?: Db;
  /** `VOTER_TOKEN_SECRET` — обязателен вместе с `db`, чтобы поднять WS-маршрут (T-009). */
  readonly voterTokenSecret?: string;
}

function requireDb(db: Db | undefined): Db {
  if (!db) throw new Error("buildApp: db dependency required for this route");
  return db;
}

const INVALID_SHAPE = (message: string): ErrorResponse => ({ error: "invalid_shape", message });

/** `undefined` — заголовок отсутствует или не UUID (docs/spec/protocol.md § 2). */
function requireGuestId(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const value = headers[GUEST_ID_HEADER];
  if (typeof value !== "string") return undefined;
  const parsed = guestIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Собирает Fastify-приложение без запуска слушателя порта — так его можно
 * протестировать через `app.inject()` без реальной сети (см. src/app.test.ts)
 * и переиспользовать в src/server.ts для боевого запуска. `deps.db`
 * опционален, чтобы тесты `/healthz` и `/`, которым БД не нужна, не требовали
 * `DATABASE_URL` — маршруты доски требуют его реально (`requireDb`).
 */
export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(websocketPlugin);

  app.get("/healthz", async () => ({ status: "ok" }));

  // Продукта (доски, стикеры) на вехе В1 ещё нет — реализуется по спецификации
  // на В2+ (docs/spec/). Корень отвечает статусом сервиса вместо 404, чтобы
  // «сервис поднялся» было видно сразу, а не только по /healthz.
  app.get("/", async () => ({
    service: "retro-server",
    status: "ok",
    healthz: "/healthz",
  }));

  // REQ-001, REQ-002, ADR-0007 — docs/spec/protocol.md § 7.
  app.post("/api/boards", async (request, reply) => {
    const guestId = requireGuestId(request.headers);
    if (!guestId) {
      const body: ErrorResponse = { error: "missing_guest_id", message: "X-Guest-Id required" };
      return reply.code(400).send(body);
    }
    const parsed = createBoardRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      const body: ErrorResponse = { error: "invalid_shape", message: parsed.error.message };
      return reply.code(400).send(body);
    }
    const result = await boardsService.createBoard(requireDb(deps.db), {
      title: parsed.data.title,
      displayName: parsed.data.displayName,
      voteLimit: parsed.data.voteLimit ?? LIMITS.voteLimit.default,
      ownerId: guestId,
    });
    return reply.code(201).send(result);
  });

  app.get<{ Params: { linkToken: string }; Querystring: { displayName?: string } }>(
    "/api/boards/join/:linkToken",
    async (request, reply) => {
      const guestId = requireGuestId(request.headers);
      if (!guestId) {
        const body: ErrorResponse = { error: "missing_guest_id", message: "X-Guest-Id required" };
        return reply.code(400).send(body);
      }
      const linkToken = linkTokenSchema.safeParse(request.params.linkToken);
      if (!linkToken.success) {
        return reply.code(400).send(INVALID_SHAPE("linkToken must be a UUID"));
      }
      // Обязательный query-параметр (у GET нет тела); используется только при
      // первом заходе, на повторном — функционально игнорируется (protocol.md § 7).
      const displayName = displayNameSchema.safeParse(request.query.displayName);
      if (!displayName.success) {
        return reply
          .code(400)
          .send(INVALID_SHAPE("displayName query param required and must be 1-50 chars"));
      }
      const result = await boardsService.joinByLink(requireDb(deps.db), {
        linkToken: linkToken.data,
        guestId,
        displayName: displayName.data,
      });
      if (!result) {
        const body: ErrorResponse = { error: "not_found", message: "invalid invite link" };
        return reply.code(404).send(body);
      }
      return reply.code(200).send(result);
    },
  );

  app.get<{ Params: { boardId: string } }>("/api/boards/:boardId", async (request, reply) => {
    const guestId = requireGuestId(request.headers);
    if (!guestId) {
      const body: ErrorResponse = { error: "missing_guest_id", message: "X-Guest-Id required" };
      return reply.code(400).send(body);
    }
    const boardId = boardIdSchema.safeParse(request.params.boardId);
    if (!boardId.success) {
      return reply.code(400).send(INVALID_SHAPE("boardId must be a UUID"));
    }
    const result = await boardsService.getBoardForGuest(requireDb(deps.db), {
      boardId: boardId.data,
      guestId,
    });
    if (!result) {
      const body: ErrorResponse = { error: "not_found", message: "board not found" };
      return reply.code(404).send(body);
    }
    return reply.code(200).send(result);
  });

  // T-009. Отдельный `if`, не `requireDb` — WS-маршрут не нужен тестам
  // /healthz и /, которым БД не нужна вовсе (в отличие от REST-маршрутов
  // досок, которые требуют БД безусловно).
  if (deps.db && deps.voterTokenSecret) {
    registerBoardWebSocket(app, {
      db: deps.db,
      hub: new BoardHub(),
      voterTokenSecret: deps.voterTokenSecret,
    });
  }

  return app;
}
