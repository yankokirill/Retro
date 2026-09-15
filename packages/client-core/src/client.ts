// createSyncClient — реализация ядра клиента. Контракт и точное поведение
// каждого метода описаны в JSDoc `types.ts` (test-author пишет тесты по
// нему, не по этому файлу). Тело — заглушка на время написания тестов
// (implement-req, шаг 3); реализация — следующим коммитом той же ветки.

import type { ClientCorePorts, SyncClient, SyncClientConfig } from "./types.js";

export function createSyncClient(_config: SyncClientConfig, _ports: ClientCorePorts): SyncClient {
  throw new Error("createSyncClient: not implemented");
}
