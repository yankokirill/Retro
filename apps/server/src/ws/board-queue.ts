// T-024: тело переехало в packages/server-core/src/queue.ts — реестр очередей
// не зависит от WS/Fastify как такового, только от порядка вызовов, поэтому
// уехало целиком в чистое ядро. Реэкспорт сохраняет путь импорта для
// существующих тестов/кода этого пакета.
export { type BoardQueue, createBoardQueue } from "@retro/server-core";
