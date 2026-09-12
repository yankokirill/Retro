import Fastify, { type FastifyInstance } from "fastify";

/**
 * Собирает Fastify-приложение без запуска слушателя порта — так его можно
 * протестировать через `app.inject()` без реальной сети (см. src/app.test.ts)
 * и переиспользовать в src/server.ts для боевого запуска.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}
