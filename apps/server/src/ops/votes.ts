// T-012 — голоса (V7, docs/spec/consistency-model.md § 7; REQ-014,
// REQ-015 (кр. 2, 6), REQ-016). Роль/фаза, лимит и владение — три разных
// проверки, разнесены по функциям так же, как V6 (`ops/permissions.ts`)
// разносит роль/фазу и владение сущностью; в отличие от V6 это отдельный
// модуль, не расширение `classifyAction`/`checkPermission` — те два теста
// (`apps/server/test/permissions.test.ts`, T-011) уже фиксируют, что
// `classifyAction` возвращает `null` для vote/unvote, и это остаётся верным:
// голоса не являются `StickerAction`.
//
// `resetVotes` (REQ-016) сюда не входит — это не проверка, а массовое
// действие с доступом к журналу и рассылке (`ws/gateway.ts`), роль для
// него проверяется в `boards/service.ts` `resetVotes` (мирроринг `setPhase`).

import type { Dot, EntityId, State } from "@retro/crdt";
import { activeVotes } from "@retro/crdt";
import type { Phase, RejectReason, Role } from "@retro/protocol";

export type CheckVoteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RejectReason; readonly message: string };

export type VoteAction = "vote" | "unvote";

/**
 * REQ-015, «Роли/фазы»: `owner`/`facilitator` — любая фаза; `participant` —
 * только `vote`; `viewer` — никогда. Не знает о лимите/владении — те
 * `checkVoteLimit`/`checkVoteOwnership` ниже.
 */
export function checkVotePermission(role: Role, phase: Phase, action: VoteAction): CheckVoteResult {
  throw new Error("checkVotePermission: not implemented");
}

/**
 * REQ-014, REQ-015 (кр. 2, 6), V7 (`vote`): у голосующего должно быть
 * меньше `voteLimit` активных голосов (суммарно по всем целям — REQ-015
 * кр. 3 разрешает несколько голосов одной сущности, лимит общий).
 *
 * `claimedVoterToken` — то, что клиент прислал в `WireDelta.votes[0].user`;
 * `connectionVoterToken` — то, что сервер сам посчитал для этого соединения
 * (`computeVoterToken` по `guestId` из `hello`, `ws/voter-token.ts`).
 * Несовпадение — попытка голосовать от чужого анонимного токена (обошла бы
 * собственный лимит и списала бы голос на чужой счёт, см.
 * `consistency-model.md` § 3.1: `vote(id): V⁺ = {(d, owner(a), id)}` — поле
 * голоса обязано быть `owner(a)`, не произвольным вводом клиента; это тот
 * же принцип, что V1 «owner(a) = u» для dot, только для анонимного поля
 * голоса). Тот же `RejectReason`, что и для отзыва чужого голоса
 * (`not_own_vote`) — оба случая семантически «не ваш голос».
 */
export function checkVoteLimit(
  state: State,
  claimedVoterToken: string,
  connectionVoterToken: string,
  voteLimit: number,
): CheckVoteResult {
  throw new Error("checkVoteLimit: not implemented");
}

/**
 * V7 (`unvote`): голос `voteDot` на `target` существует, ещё не отозван
 * (`activeVotes`, `packages/crdt`) и принадлежит `voterToken` этого
 * соединения. Иначе — `not_own_vote` (чужой голос либо уже отозванный).
 */
export function checkVoteOwnership(
  state: State,
  voteDot: Dot,
  target: EntityId,
  voterToken: string,
): CheckVoteResult {
  throw new Error("checkVoteOwnership: not implemented");
}
