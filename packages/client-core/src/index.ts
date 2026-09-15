// Публичный API @retro/client-core — docs/design/T-005-simulator.md § 4.

export { createSyncClient } from "./client.js";
export type { OutboxStore, PendingEntry } from "./outbox.js";
export { createMemoryOutboxStore } from "./outbox.js";
export type * from "./types.js";
