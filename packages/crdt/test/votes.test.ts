// REQ-015 (кр. 3–4), на уровне состояния CRDT — лимит N и его серверная
// проверка (V7) это T-012, здесь только форма state: docs/spec/consistency-model.md
// § 2 (V⁺/V⁻, active(X)), § 3.1 (vote/unvote).
//
// `vote`/`unvote`/`activeVotes` НЕ экспортированы `src/index.ts` (T-002 ещё
// не реализован) — вызовы ниже бросают `TypeError: ... is not a function`.
//
// Важно про unvote (см. PendingT2Ops в test/arbitraries.ts и docs/spec/
// consistency-model.md § 3.1): `unvote(state, voteDot, target)` НЕ принимает
// `clock` и возвращает просто `Delta`, а не `OpResult` — 2P-set идемпотентен
// по членству (vd, target) ∈ V⁻, отдельный dot самой операции unvote не
// нужен. Ни один тест ниже не изобретает для unvote тик часов.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { empty, equals, merge, newClock } from "../src/index.js";
import {
  dotPresent,
  findVoteByDot,
  foldDeltas,
  isUnvoted,
  pendingOps,
  voteScenarioArb,
} from "./arbitraries.js";

// Голоса в этом файле подаются напрямую через pendingOps (не через
// runScenario/opsArb — vote/unvote идут отдельным путём, см. arbitraries.ts),
// поэтому часы актора заводятся вручную тем же newClock, что и у остальных
// операций T-001/T-002 (§ 1.3).
function actorClock(actor: string) {
  return newClock(actor);
}

describe("REQ-015 кр.3: голос можно отдать несколько раз одной и той же сущности", () => {
  it("REQ-015 кр.3: два голоса одного участника за одну сущность — оба активны, не перекрывают друг друга", () => {
    const actor = "actor-1";
    const user = "user-1";
    const target = "sticker-1";
    let clock = actorClock(actor);
    let state = empty();

    const vote1 = pendingOps.vote(state, clock, target, user);
    clock = vote1.clock;
    state = merge(state, vote1.delta);

    const vote2 = pendingOps.vote(state, clock, target, user);
    clock = vote2.clock;
    state = merge(state, vote2.delta);

    expect(vote1.dot).not.toEqual(vote2.dot);
    const active = pendingOps.activeVotes(state, target);
    expect(active).toHaveLength(2);
    expect(findVoteByDot(state, vote1.dot)).toBeDefined();
    expect(findVoteByDot(state, vote2.dot)).toBeDefined();
  });

  it("REQ-015: property — N голосов одного участника одной сущности дают N активных голосов", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), (count) => {
        const actor = "actor-n";
        const user = "user-n";
        const target = "sticker-n";
        let clock = actorClock(actor);
        let state = empty();
        for (let i = 0; i < count; i++) {
          const result = pendingOps.vote(state, clock, target, user);
          clock = result.clock;
          state = merge(state, result.delta);
        }
        expect(pendingOps.activeVotes(state, target)).toHaveLength(count);
      }),
      { numRuns: 100 },
    );
  });
});

describe("REQ-015 кр.4: unvote уменьшает число активных голосов", () => {
  it("REQ-015 кр.4: отзыв одного из двух голосов оставляет один активный, отозванный остаётся в votes (I2.5)", () => {
    const actor = "actor-1";
    const user = "user-1";
    const target = "sticker-1";
    let clock = actorClock(actor);
    let state = empty();

    const vote1 = pendingOps.vote(state, clock, target, user);
    clock = vote1.clock;
    state = merge(state, vote1.delta);

    const vote2 = pendingOps.vote(state, clock, target, user);
    clock = vote2.clock;
    state = merge(state, vote2.delta);

    const unvoteDelta = pendingOps.unvote(state, vote1.dot, target);
    state = merge(state, unvoteDelta);

    const active = pendingOps.activeVotes(state, target);
    expect(active).toHaveLength(1);
    expect(active[0]?.dot).toEqual(vote2.dot);

    // Отозванный голос остаётся физически в votes — не удаляется (I2.5/REQ-025).
    expect(findVoteByDot(state, vote1.dot)).toBeDefined();
    expect(dotPresent(state, vote1.dot)).toBe(true);
    expect(isUnvoted(state, vote1.dot, target)).toBe(true);
  });

  it("REQ-015 кр.4: отзыв единственного голоса обнуляет активные голоса по этой сущности", () => {
    const actor = "actor-1";
    const user = "user-1";
    const target = "sticker-1";
    const clock = actorClock(actor);
    let state = empty();

    const vote1 = pendingOps.vote(state, clock, target, user);
    state = merge(state, vote1.delta);

    const unvoteDelta = pendingOps.unvote(state, vote1.dot, target);
    state = merge(state, unvoteDelta);

    expect(pendingOps.activeVotes(state, target)).toHaveLength(0);
  });

  it("REQ-015: property — отзыв k из n голосов одного участника оставляет ровно n−k активных", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 8 })
          .chain((n) => fc.tuple(fc.constant(n), fc.integer({ min: 0, max: n }))),
        ([n, k]) => {
          const actor = "actor-nk";
          const user = "user-nk";
          const target = "sticker-nk";
          let clock = actorClock(actor);
          let state = empty();
          const dots: { actor: string; counter: number }[] = [];
          for (let i = 0; i < n; i++) {
            const result = pendingOps.vote(state, clock, target, user);
            clock = result.clock;
            state = merge(state, result.delta);
            dots.push(result.dot);
          }
          for (let i = 0; i < k; i++) {
            const dot = dots[i];
            if (!dot) throw new Error("unreachable");
            const delta = pendingOps.unvote(state, dot, target);
            state = merge(state, delta);
          }
          expect(pendingOps.activeVotes(state, target)).toHaveLength(n - k);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("REQ-015: unvote идемпотентен — повторный отзыв того же голоса не меняет число активных", () => {
    const actor = "actor-1";
    const user = "user-1";
    const target = "sticker-1";
    const clock = actorClock(actor);
    let state = empty();

    const vote1 = pendingOps.vote(state, clock, target, user);
    state = merge(state, vote1.delta);

    const unvoteOnce = merge(state, pendingOps.unvote(state, vote1.dot, target));
    const unvoteTwice = merge(unvoteOnce, pendingOps.unvote(unvoteOnce, vote1.dot, target));

    expect(pendingOps.activeVotes(unvoteOnce, target)).toHaveLength(0);
    expect(equals(unvoteOnce, unvoteTwice)).toBe(true);
  });
});

describe("REQ-015: голоса разных участников не мешают друг другу", () => {
  it("голос и отзыв одного участника не влияют на активные голоса другого", () => {
    const target = "sticker-shared";
    let stateU1 = empty();
    let clockU1 = actorClock("actor-u1");
    const voteU1 = pendingOps.vote(stateU1, clockU1, target, "user-1");
    clockU1 = voteU1.clock;
    stateU1 = merge(stateU1, voteU1.delta);

    let state = stateU1;
    let clockU2 = actorClock("actor-u2");
    const voteU2 = pendingOps.vote(state, clockU2, target, "user-2");
    clockU2 = voteU2.clock;
    state = merge(state, voteU2.delta);

    expect(pendingOps.activeVotes(state, target)).toHaveLength(2);

    // user-2 отзывает свой голос — голос user-1 остаётся активным.
    const unvoteU2 = pendingOps.unvote(state, voteU2.dot, target);
    state = merge(state, unvoteU2);

    const active = pendingOps.activeVotes(state, target);
    expect(active).toHaveLength(1);
    expect(active[0]?.dot).toEqual(voteU1.dot);
    expect(active[0]?.user).toBe("user-1");
  });
});

describe("REQ-022 (T1/I1.1/I2): свойства merge для vote/unvote", () => {
  it("REQ-022: T1 — merge коммутативен и идемпотентен на сценариях с vote/unvote", () => {
    fc.assert(
      fc.property(voteScenarioArb("votes-comm-a"), voteScenarioArb("votes-comm-b"), (a, b) => {
        expect(equals(merge(a.merged, b.merged), merge(b.merged, a.merged))).toBe(true);
        expect(equals(merge(a.merged, a.merged), a.merged)).toBe(true);
        expect(equals(merge(a.merged, empty()), a.merged)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("REQ-022: I1.1 — сценарий с vote/unvote сходится независимо от порядка и повторов слияния его дельт", () => {
    fc.assert(
      fc.property(
        voteScenarioArb("votes-conv", { minOps: 1, maxOps: 12 }).chain((scenario) =>
          fc.tuple(
            fc.constant(scenario),
            fc.shuffledSubarray([...scenario.deltas], {
              minLength: scenario.deltas.length,
              maxLength: scenario.deltas.length,
            }),
          ),
        ),
        ([scenario, shuffled]) => {
          const reordered = foldDeltas(shuffled);
          const doubled = foldDeltas([...scenario.deltas, ...scenario.deltas]);
          expect(equals(reordered, scenario.merged)).toBe(true);
          expect(equals(doubled, scenario.merged)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("REQ-022: I2 — dot каждого поданного голоса остаётся физически в состоянии (unvote его не убирает)", () => {
    fc.assert(
      fc.property(voteScenarioArb("votes-noloss", { minOps: 1, maxOps: 12 }), (scenario) => {
        for (const dot of scenario.voteDots) {
          expect(dotPresent(scenario.merged, dot)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});
