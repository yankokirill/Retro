import Fastify, { type FastifyInstance } from "fastify";

/**
 * Собирает Fastify-приложение без запуска слушателя порта — так его можно
 * протестировать через `app.inject()` без реальной сети (см. src/app.test.ts)
 * и переиспользовать в src/server.ts для боевого запуска.
 */
export function buildApp(): FastifyInstance {
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

  return app;
}
