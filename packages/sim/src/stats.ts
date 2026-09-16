// Счётчики сводки (§ 11.1 спецификации — «Сводка при успехе») и покрытия
// трудных сценариев SIM-04/SIM-11 (§ 4.3, § 10.1). Чистые данные — сам
// объект мутируется в apply.ts/run.ts по ходу прогона, здесь только форма и
// начальное состояние.

import type { IntentKind } from "./config.js";

export interface MessageSizeStats {
  toServer: number;
  toClient: number;
}

/** Покрытие трудных ситуаций — SIM-11, docs/spec/simulator.md § 10.1. Каждое поле — тот же пункт списка. */
export interface CoverageStats {
  /** ≥ 1 reveal, когда у клиента без соединения нет в X_c чужих стикеров. */
  revealWithDisconnectedMissingStickers: boolean;
  /** ≥ 1 контрольная точка с conflict=true у текста стикера и у названия группы одновременно. */
  conflictAtCheckpoint: boolean;
  /** ≥ 1 повторный ack на уже записанную create/write/vote операцию. */
  duplicateAckWrite: boolean;
  /** ≥ 1 повторный ack на уже записанный unvote. */
  duplicateAckUnvote: boolean;
  /** Причины S7, которые уже встретились хотя бы раз. */
  rejectReasonsSeen: Set<string>;
  /** ≥ 1 vote_limit при конкурентном vote из двух вкладок одного гостя. */
  voteLimitFromOwnTabs: boolean;
  /** ≥ 1 welcome со снапшотом. */
  welcomeWithSnapshot: boolean;
  /** ≥ 1 welcome только с хвостом (без снапшота). */
  welcomeTailOnly: boolean;
  /** ≥ 1 E6 при непустой P. */
  reloadWithNonEmptyPending: boolean;
  /** ≥ 1 resetVotes, конкурентный с unvote того же голоса. */
  resetVotesConcurrentWithUnvote: boolean;
  /** ≥ 1 операция поверх неподтверждённой своей же операции, которая затем была отклонена. */
  opBuiltOnRejectedUnconfirmed: boolean;
}

/** SIM-04 — все виды сетевых неисправностей, каждый хотя бы раз. */
export interface FaultCoverageStats {
  cutWithNonEmptyPending: boolean;
  cutWithNonEmptyToClient: boolean;
  noticeAfterAddressedMessage: boolean;
  reloadWithNonEmptyPending: boolean;
  connectWithNullLastSeq: boolean;
  connectWithKnownLastSeq: boolean;
}

export interface Stats {
  steps: number;
  actsByIntent: Partial<Record<IntentKind, number>>;
  accepted: number;
  rejectedByReason: Partial<Record<string, number>>;
  cuts: number;
  reloads: number;
  duplicateAcks: number;
  checkpoints: number;
  maxPending: number;
  maxMessageBytes: MessageSizeStats;
  lostAfterCut: number;
  readonly coverage: CoverageStats;
  readonly faultCoverage: FaultCoverageStats;
}

// Время прогона (§ 11.1 «Сводка при успехе») намеренно не поле Stats: его
// меряет только cli.ts (Date.now() запрещён везде, кроме src/cli.ts, правило
// 7 CLAUDE.md / SIM-02 кр. 2) — cli.ts оборачивает вызов runSimulation
// снаружи и печатает разницу, не передавая время внутрь чистого мира.

export function createStats(): Stats {
  return {
    steps: 0,
    actsByIntent: {},
    accepted: 0,
    rejectedByReason: {},
    cuts: 0,
    reloads: 0,
    duplicateAcks: 0,
    checkpoints: 0,
    maxPending: 0,
    maxMessageBytes: { toServer: 0, toClient: 0 },
    lostAfterCut: 0,
    coverage: {
      revealWithDisconnectedMissingStickers: false,
      conflictAtCheckpoint: false,
      duplicateAckWrite: false,
      duplicateAckUnvote: false,
      rejectReasonsSeen: new Set(),
      voteLimitFromOwnTabs: false,
      welcomeWithSnapshot: false,
      welcomeTailOnly: false,
      reloadWithNonEmptyPending: false,
      resetVotesConcurrentWithUnvote: false,
      opBuiltOnRejectedUnconfirmed: false,
    },
    faultCoverage: {
      cutWithNonEmptyPending: false,
      cutWithNonEmptyToClient: false,
      noticeAfterAddressedMessage: false,
      reloadWithNonEmptyPending: false,
      connectWithNullLastSeq: false,
      connectWithKnownLastSeq: false,
    },
  };
}
