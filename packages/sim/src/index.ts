// Публичный API @retro/sim — для программного запуска (например, будущего
// tools/retro-mcp: simulate(clients, ops, seed), CLAUDE.md § 7). CLI
// (src/cli.ts) сам этим входом не пользуется — у него свой процесс запуска.

export type { ConfigInput, ConfigResult, Profile, ProfileConfig, SimConfig } from "./config.js";
export { buildConfig, PROFILES, profileConfig } from "./config.js";
export type { Event } from "./events.js";
export type { RunResult } from "./run.js";
export { runSimulation } from "./run.js";
export type { Stats } from "./stats.js";
export type { PropertyId, Violation } from "./violation.js";
