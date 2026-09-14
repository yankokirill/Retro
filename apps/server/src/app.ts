import {
  createBoardRequestSchema,
  displayNameSchema,
  type ErrorResponse,
  GUEST_ID_HEADER,
  LIMITS,
} from "@retro/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "./boards/service.js";
import * as boardsService from "./boards/service.js";

export interface AppDeps {
  readonly db?: Db;
}

function requireDb(db: Db | undefined): Db {
  if (!db) throw new Error("buildApp: db dependency required for this route");
  return db;
}

function requireGuestId(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const value = headers[GUEST_ID_HEADER];
  return typeof value === "string" ? value : undefined;
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
      // Обязательный query-параметр (у GET нет тела); используется только при
      // первом заходе, на повторном — функционально игнорируется (protocol.md § 7).
      const displayName = displayNameSchema.safeParse(request.query.displayName);
      if (!displayName.success) {
        const body: ErrorResponse = {
          error: "invalid_shape",
          message: "displayName query param required and must be 1-50 chars",
        };
        return reply.code(400).send(body);
      }
      const result = await boardsService.joinByLink(requireDb(deps.db), {
        linkToken: request.params.linkToken,
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
    const result = await boardsService.getBoardForGuest(requireDb(deps.db), {
      boardId: request.params.boardId,
      guestId,
    });
    if (!result) {
      const body: ErrorResponse = { error: "not_found", message: "board not found" };
      return reply.code(404).send(body);
    }
    return reply.code(200).send(result);
  });

  return app;
}
