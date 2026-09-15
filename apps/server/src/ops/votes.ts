// T-024: тело переехало в packages/server-core/src/rules/votes.ts —
// правило чистое (без I/O), не зависит от apps/server. Реэкспорт сохраняет
// путь импорта для существующих тестов/кода этого пакета.

export type { CheckVotePermissionParams, CheckVoteResult, VoteAction } from "@retro/server-core";
export { checkVoteLimit, checkVoteOwnership, checkVotePermission } from "@retro/server-core";
