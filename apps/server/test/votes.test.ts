// T-012 — «Голоса: лимит и сброс (V7)»: приёмочные тесты для контракта
// `apps/server/src/ops/votes.ts` (`checkVotePermission`, `checkVoteLimit`,
// `checkVoteOwnership`), написанные ДО реализации и не глядя в неё
// (docs/spec/requirements.md REQ-014, REQ-015 (кр. 2, 3, 4, 6), REQ-016;
// docs/spec/consistency-model.md § 7 правило V7, § 8 инвариант I6;
// docs/security/permissions.md § «Голоса (T-012, V7)» — источник истины для
// контракта трёх функций, использован вместо чтения `votes.ts`: этому
// агенту чтение `apps/*/src/**` запрещено хуком guard-paths, поэтому файл
// контракта не открывался, только его описание в задаче и в permissions.md).
//
// Все три функции — заглушки (`throw new Error(...)`, см. задачу T-012):
// каждый сценарий ниже должен падать именно из-за этого, а не из-за ошибки
// в самом тесте.
//
// Голоса собираются ТОЛЬКО через публичный API `@retro/crdt` (`empty`,
// `newClock`, `merge`, `vote`, `unvote`, `activeVotes`) — по образцу
// `packages/crdt/test/votes.test.ts` (там же обоснование: `unvote` не несёт
// `clock`/`Stamp`, `vote` — обычная операция с `dot`). Unit-тест, без
// Testcontainers — все три функции контракта чистые (без I/O), как
// `checkPermission`/`classifyAction` в `permissions.test.ts` и `validateOp`
// в `validate.test.ts`, на которые этот файл ориентируется по стилю.
//
// Область: только V7 в его серверной части — проверка лимита/владения.
// Сам массовый `resetVotes` (REQ-016) и настоящая конкурентность двух вкладок
// по WS — интеграционные тесты (`ws.int.test.ts`), не здесь: эти три функции
// чистые и ничего не знают про WS-соединения.

import type { EntityId, State } from "@retro/crdt";
import { activeVotes, empty, merge, newClock, unvote, vote } from "@retro/crdt";
import type { Phase, Role } from "@retro/protocol";
import { describe, expect, it } from "vitest";
import { checkVoteLimit, checkVoteOwnership, checkVotePermission } from "../src/ops/votes.js";

const newActor = () => crypto.randomUUID();
const newToken = () => `voter-${crypto.randomUUID()}`;

const ALL_PHASES: readonly Phase[] = ["collect", "group", "vote", "discuss", "actions"];
type VoteAction = "vote" | "unvote";
const VOTE_ACTIONS: readonly VoteAction[] = ["vote", "unvote"];

function expectAllowed(result: { ok: boolean }) {
  expect(result.ok).toBe(true);
}

function expectDenied(result: { ok: boolean; reason?: string; message?: string }, reason: string) {
  expect(result.ok).toBe(false);
  expect(result.reason).toBe(reason);
  expect(result.message?.length ?? 0).toBeGreaterThan(0);
}

/** Кладёт `count` голосов одного `user` в состояние — на один и тот же `target`, если он один. */
function castVotes(state: State, actor: string, user: string, targets: readonly EntityId[]): State {
  let clock = newClock(actor);
  let next = state;
  for (const target of targets) {
    const result = vote(next, clock, target, user);
    clock = result.clock;
    next = merge(next, result.delta);
  }
  return next;
}

// ---------------------------------------------------------------------------
// checkVotePermission — роль × фаза × action (vote | unvote)
// (docs/security/permissions.md § «Голоса»: owner/facilitator всегда;
// participant только в фазе `vote`; viewer никогда)
// ---------------------------------------------------------------------------

describe("REQ-015 (кр. 2): checkVotePermission — owner/facilitator разрешено всегда", () => {
  it.each<Role>(["owner", "facilitator"])("%s: ok:true для vote и unvote в любой фазе", (role) => {
    for (const phase of ALL_PHASES) {
      for (const action of VOTE_ACTIONS) {
        expectAllowed(checkVotePermission({ role, phase, action }));
      }
    }
  });
});

describe("REQ-015 (кр. 2): checkVotePermission — viewer запрещено всегда", () => {
  it("viewer: forbidden для vote и unvote в любой фазе", () => {
    for (const phase of ALL_PHASES) {
      for (const action of VOTE_ACTIONS) {
        expectDenied(checkVotePermission({ role: "viewer", phase, action }), "forbidden");
      }
    }
  });
});

describe("REQ-015 (кр. 2): checkVotePermission — participant ограничен фазой vote", () => {
  it("participant: ok:true для vote и unvote в фазе vote", () => {
    for (const action of VOTE_ACTIONS) {
      expectAllowed(checkVotePermission({ role: "participant", phase: "vote", action }));
    }
  });

  it("participant: wrong_phase для vote и unvote вне фазы vote", () => {
    for (const phase of ALL_PHASES.filter((p) => p !== "vote")) {
      for (const action of VOTE_ACTIONS) {
        expectDenied(checkVotePermission({ role: "participant", phase, action }), "wrong_phase");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// checkVoteLimit — REQ-014 (лимит N), REQ-015 кр. 1-3 (расход, несколько
// голосов одной цели), § 8 I6 (сумма голосов пользователя ≤ N)
// ---------------------------------------------------------------------------

describe("REQ-014: checkVoteLimit — участник с голосами < N может голосовать", () => {
  it("REQ-014/REQ-015 кр.1: 0 активных голосов из N=3 — ok:true", () => {
    const token = newToken();
    const result = checkVoteLimit(empty(), token, token, 3);
    expectAllowed(result);
  });

  it("REQ-015 кр.1: N-1 активных голосов из N — ok:true (последний доступный голос)", () => {
    const token = newToken();
    const state = castVotes(empty(), newActor(), token, ["sticker-a", "sticker-b"]);
    expectAllowed(checkVoteLimit(state, token, token, 3));
  });
});

describe("REQ-015 (кр. 2, I6): checkVoteLimit — участник с N активными голосами отклонён", () => {
  it("ровно N=3 активных голоса на РАЗНЫЕ цели — vote_limit", () => {
    const token = newToken();
    const state = castVotes(empty(), newActor(), token, ["sticker-a", "sticker-b", "sticker-c"]);
    expectDenied(checkVoteLimit(state, token, token, 3), "vote_limit");
  });

  it("REQ-015 кр.3: ровно N=3 активных голоса на ОДНУ И ТУ ЖЕ цель — тоже vote_limit (сумма, не по целям)", () => {
    const token = newToken();
    const state = castVotes(empty(), newActor(), token, ["sticker-a", "sticker-a", "sticker-a"]);
    expect(activeVotes(state, "sticker-a")).toHaveLength(3);
    expectDenied(checkVoteLimit(state, token, token, 3), "vote_limit");
  });

  it("REQ-015 кр.3: N-1=2 голоса на одну и ту же цель ещё разрешают третий голос той же цели", () => {
    const token = newToken();
    const state = castVotes(empty(), newActor(), token, ["sticker-a", "sticker-a"]);
    expectAllowed(checkVoteLimit(state, token, token, 3));
  });
});

describe("REQ-015 (кр. 4, I2.5): checkVoteLimit — отозванные голоса не считаются в лимит", () => {
  it("N=3, 3 голоса отданы, 1 отозван — доступен новый голос (ok:true)", () => {
    const token = newToken();
    const actor = newActor();
    let state = castVotes(empty(), actor, token, ["sticker-a", "sticker-b", "sticker-c"]);
    const [toRevoke] = activeVotes(state, "sticker-a");
    if (!toRevoke) throw new Error("unreachable: vote must exist");
    state = merge(state, unvote(state, toRevoke.dot, "sticker-a"));

    expect(activeVotes(state).length).toBe(2);
    expectAllowed(checkVoteLimit(state, token, token, 3));
  });
});

describe("REQ-014: checkVoteLimit — подмена claimedVoterToken защищает чужой лимит", () => {
  // Контракт (docs/security/permissions.md § «Голоса»): checkVoteLimit
  // проверяет не только счётчик, но и что `WireDelta.votes[0].user`
  // (claimedVoterToken) совпадает с voterToken этого соединения
  // (connectionVoterToken) — иначе участник мог бы голосовать «от имени»
  // чужого анонимного токена, обходя собственный (уже исчерпанный) лимит.
  // Это не буквально REQ-015 кр.4 (отзыв чужого голоса — checkVoteOwnership,
  // ниже), а защита самого лимита (REQ-014) от подмены личности при `vote`.
  it("claimedVoterToken отличается от connectionVoterToken — reject not_own_vote, даже при свободном лимите", () => {
    const claimed = newToken();
    const connection = newToken();
    expect(claimed).not.toBe(connection);
    const result = checkVoteLimit(empty(), claimed, connection, 3);
    expectDenied(result, "not_own_vote");
  });

  it("подмена токена отклоняется независимо от того, сколько голосов уже у claimed-пользователя", () => {
    const claimed = newToken();
    const connection = newToken();
    const state = castVotes(empty(), newActor(), claimed, ["sticker-a"]);
    const result = checkVoteLimit(state, claimed, connection, 3);
    expectDenied(result, "not_own_vote");
  });
});

// ---------------------------------------------------------------------------
// checkVoteOwnership — REQ-015 кр.4 (отзыв собственного голоса), protocol.md
// § 5 reason `not_own_vote` («отзыв чужого или уже отозванного голоса»)
// ---------------------------------------------------------------------------

describe("REQ-015 (кр. 4): checkVoteOwnership — отзыв собственного активного голоса разрешён", () => {
  it("голос существует, активен, принадлежит voterToken — ok:true", () => {
    const token = newToken();
    const target = "sticker-a" as EntityId;
    const cast = vote(empty(), newClock(newActor()), target, token);
    const state = merge(empty(), cast.delta);

    expectAllowed(checkVoteOwnership(state, cast.dot, target, token));
  });
});

describe("REQ-015 (кр. 4): checkVoteOwnership — отклоняет несуществующий/чужой/уже отозванный голос", () => {
  it("not_own_vote: голос с таким dot никогда не подавался", () => {
    const token = newToken();
    const target = "sticker-a" as EntityId;
    const state = empty();
    const neverCast = { actor: newActor(), counter: 1 };

    expectDenied(checkVoteOwnership(state, neverCast, target, token), "not_own_vote");
  });

  it("not_own_vote: голос уже отозван ранее", () => {
    const token = newToken();
    const target = "sticker-a" as EntityId;
    const cast = vote(empty(), newClock(newActor()), target, token);
    let state = merge(empty(), cast.delta);
    state = merge(state, unvote(state, cast.dot, target));
    expect(activeVotes(state, target)).toHaveLength(0);

    expectDenied(checkVoteOwnership(state, cast.dot, target, token), "not_own_vote");
  });

  it("not_own_vote: голос существует и активен, но принадлежит другому voterToken", () => {
    const owner = newToken();
    const impostor = newToken();
    const target = "sticker-a" as EntityId;
    const cast = vote(empty(), newClock(newActor()), target, owner);
    const state = merge(empty(), cast.delta);

    expectDenied(checkVoteOwnership(state, cast.dot, target, impostor), "not_own_vote");
  });
});
