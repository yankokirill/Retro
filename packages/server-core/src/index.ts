// T-024 (docs/design/T-005-simulator.md § 3.1) — публичный API @retro/server-core.
// Собирается по шагам: сначала чистые правила и порт хранения (этот коммит),
// затем `createBoardServer`/`handlers/*` (см. docs/tasks.md T-024).

export type {
  BoardServer,
  ConnectionId,
  Outgoing,
  ReceiveResult,
  ServerCorePorts,
} from "./board-server.js";
export { createBoardServer } from "./board-server.js";
export { type BoardQueue, createBoardQueue } from "./queue.js";
export type { ResetVotesCheckResult, SetPhaseCheckResult } from "./rules/board.js";
export { checkResetVotes, checkSetPhase, resolveRole } from "./rules/board.js";
export type {
  CheckPermissionParams,
  CheckPermissionResult,
  StickerAction,
} from "./rules/permissions.js";
export { checkPermission, classifyAction } from "./rules/permissions.js";
export type { ValidateOpParams, ValidateOpResult } from "./rules/validate.js";
export { MAX_LAMPORT_AHEAD, validateOp } from "./rules/validate.js";
export type { AuthorOf } from "./rules/visibility.js";
export { isEmptyDelta, projectHidden, projectVisible } from "./rules/visibility.js";
export type { CheckVotePermissionParams, CheckVoteResult, VoteAction } from "./rules/votes.js";
export { checkVoteLimit, checkVoteOwnership, checkVotePermission } from "./rules/votes.js";

export type * from "./store.js";
