// T-010 — «Правила приёма операции сервером V1/V3/V4/V5» (REQ-024, кр. 2):
// приёмочные тесты для контракта `apps/server/src/ops/validate.ts`,
// написанные ДО реализации и не глядя в неё
// (docs/spec/consistency-model.md § 7, docs/spec/protocol.md § 5).
//
// Ключевая функция `validateOp` сейчас — заглушка
// (`Error("validateOp: not implemented")`, см. задачу T-010): каждый
// сценарий ниже должен падать именно из-за этого, а не из-за ошибки в
// самом тесте.
//
// Все дельты и состояния собираются ТОЛЬКО через публичный API `@retro/crdt`
// (`empty`, `newClock`, `merge`, `dotKey`, `createSticker`, `setField`,
// `setColor`, `setGroup`, `vote`, `unvote`, `toWire`). Там, где нужно
// проверить реакцию на нарушение правила, честно построенная дельта
// минимально «подделывается» (меняется одно конкретное поле проводного
// формата) — так, как мог бы прислать недобросовестный клиент; сервер не
// доверяет клиенту именно поэтому (CLAUDE.md § 5, модель угроз).
//
// Область теста — только V1, V3, V4, V5 (`ValidateOpParams` не несёт роли,
// фазы или числа истраченных голосов, поэтому V2/V6/V7 — не здесь).
// `apps/*/src` (кроме контракта `validate.ts`, данного verbatim в задаче) и
// `packages/crdt/src/ops/**` не читались.

import type { Delta, Dot, EntityId, State, WireDelta } from "@retro/crdt";
import {
  createSticker,
  dotKey,
  empty,
  merge,
  newClock,
  setColor,
  setField,
  setGroup,
  toWire,
  unvote,
  vote,
} from "@retro/crdt";
import { describe, expect, it } from "vitest";
import type { ValidateOpParams } from "../src/ops/validate.js";
import { validateOp } from "../src/ops/validate.js";

// `ActorClock` не экспортируется отдельно — берём его форму структурно из
// уже экспортированного `ValidateOpParams["actorClock"]` (контракт задачи
// описывает `ActorClock` как отдельный тип, но реализация держит его
// неэкспортированным деталем; структурная типизация TS не требует имени).
type ActorClock = NonNullable<ValidateOpParams["actorClock"]>;

// ---------------------------------------------------------------------------
// Утилиты фикстур
// ---------------------------------------------------------------------------

const newActor = () => crypto.randomUUID();

/** Ещё не существующая, но синтаксически валидная сущность (§ 1.4 EntityId = Dot). */
const fakeEntityId = (): EntityId => `${crypto.randomUUID()}:1`;

function stickerFixture() {
  const actorA = newActor();
  const created = createSticker(empty(), newClock(actorA), {
    column: "start",
    frac: "m",
    text: "hello",
    color: "yellow",
  });
  return {
    actorA,
    clockA: created.clock,
    createdDot: created.dot,
    stickerId: dotKey(created.dot) as EntityId,
    state: created.delta as State,
  };
}

/** actorClock для актора, у которого на доске ещё не было принятых операций. */
function freshActorClock(boardMaxLamport = 0): ActorClock {
  return { lastCounter: 0, lastLamport: 0, boardMaxLamport };
}

function baseParams(overrides: Partial<ValidateOpParams>): ValidateOpParams {
  return {
    state: empty(),
    connectionActorId: newActor(),
    delta: toWire(empty() as Delta),
    actorClock: freshActorClock(),
    ...overrides,
  };
}

/** Патч одного поля Stamp единственной записи дельты — типы Entry/Stamp readonly, поэтому пересобираем. */
function withEntryStamp(
  delta: WireDelta,
  patch: Partial<WireDelta["entries"][number]["stamp"]>,
): WireDelta {
  const [entry, ...rest] = delta.entries;
  if (!entry) throw new Error("withEntryStamp: delta has no entries");
  return { ...delta, entries: [{ ...entry, stamp: { ...entry.stamp, ...patch } }, ...rest] };
}

/** Патч dot единственного перекрытия — для имитации подделанного `supersedes`. */
function withSupersedeDot(delta: WireDelta, patch: Partial<Dot>): WireDelta {
  const [supersede, ...rest] = delta.supersedes;
  if (!supersede) throw new Error("withSupersedeDot: delta has no supersedes");
  return { ...delta, supersedes: [{ ...supersede, dot: { ...supersede.dot, ...patch } }, ...rest] };
}

function expectRejected(result: ReturnType<typeof validateOp>, reason: string) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe(reason);
  expect(result.message.length).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// V1 — свежий dot: owner(a) = u и n > last_n(a)
// ---------------------------------------------------------------------------

describe("REQ-024: V1 — свежий dot", () => {
  it("REQ-024: V1 — dot.counter не больше last_n(a) отклоняется как stale_dot", () => {
    const { actorA, state, createdDot } = stickerFixture();
    // createdDot.counter === 1; актор уже "принят" с counter 1 раньше.
    const result = validateOp(
      baseParams({
        state,
        connectionActorId: actorA,
        delta: toWire(state as Delta),
        actorClock: { lastCounter: createdDot.counter, lastLamport: 1, boardMaxLamport: 1 },
      }),
    );
    expectRejected(result, "stale_dot");
  });

  it("REQ-024: V1 — dot.actor операции не совпадает с actorId соединения (owner(a) ≠ u) отклоняется как stale_dot", () => {
    const { state } = stickerFixture();
    const impostor = newActor(); // не тот, кто прислал createSticker
    const result = validateOp(
      baseParams({
        state,
        connectionActorId: impostor,
        delta: toWire(state as Delta),
        actorClock: freshActorClock(),
      }),
    );
    expectRejected(result, "stale_dot");
  });

  it("REQ-024: V1 — owner(a) ≠ u применяется и к unvote (dot отзываемого голоса не принадлежит соединению)", () => {
    const { clockA, stickerId, state } = stickerFixture();
    const voted = vote(state, clockA, stickerId, "voter-token-a");
    const stateWithVote = merge(state, voted.delta);
    const impostor = newActor();

    const result = validateOp({
      state: stateWithVote,
      connectionActorId: impostor, // не actorA — владелец отзываемого голоса
      delta: toWire(unvote(stateWithVote, voted.dot, stickerId)),
      actorClock: null,
    });
    expectRejected(result, "stale_dot");
  });

  it("REQ-024: V1 — unvote с actorClock=null НЕ отклоняется по свежести счётчика (own vote)", () => {
    const { actorA, clockA, stickerId, state } = stickerFixture();
    const voted = vote(state, clockA, stickerId, "voter-token-a");
    const stateWithVote = merge(state, voted.delta);

    const result = validateOp({
      state: stateWithVote,
      connectionActorId: actorA,
      delta: toWire(unvote(stateWithVote, voted.dot, stickerId)),
      actorClock: null,
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// V3 — цель существует
// ---------------------------------------------------------------------------

describe("REQ-024: V3 — цель существует", () => {
  it("REQ-024: V3 — write в несуществующую сущность отклоняется как unknown_target", () => {
    const { actorA, clockA, state } = stickerFixture();
    const missing = fakeEntityId();
    const edit = setColor(state, clockA, missing, "green");

    const result = validateOp(
      baseParams({
        state,
        connectionActorId: actorA,
        delta: toWire(edit.delta),
        actorClock: { lastCounter: 1, lastLamport: 1, boardMaxLamport: 1 },
      }),
    );
    expectRejected(result, "unknown_target");
  });

  it("REQ-024: V3 — поле, не принадлежащее виду сущности (title на стикере), отклоняется как unknown_target", () => {
    const { actorA, clockA, stickerId, state } = stickerFixture();
    // sticker не поддерживает `title` — это поле только у group (§ 1.4).
    const edit = setField(state, clockA, { entity: stickerId, field: "title" }, "not a group");

    const result = validateOp(
      baseParams({
        state,
        connectionActorId: actorA,
        delta: toWire(edit.delta),
        actorClock: { lastCounter: 1, lastLamport: 1, boardMaxLamport: 1 },
      }),
    );
    expectRejected(result, "unknown_target");
  });

  it("REQ-024: V3 — setGroup на несуществующую группу отклоняется как unknown_target", () => {
    const { actorA, clockA, stickerId, state } = stickerFixture();
    const missingGroup = fakeEntityId();
    const edit = setGroup(state, clockA, stickerId, missingGroup);

    const result = validateOp(
      baseParams({
        state,
        connectionActorId: actorA,
        delta: toWire(edit.delta),
        actorClock: { lastCounter: 1, lastLamport: 1, boardMaxLamport: 1 },
      }),
    );
    expectRejected(result, "unknown_target");
  });

  it("REQ-024: V3 — vote за несуществующую сущность отклоняется как unknown_target", () => {
    const actorB = newActor();
    const missing = fakeEntityId();
    const voted = vote(empty(), newClock(actorB), missing, "voter-token-b");

    const result = validateOp(
      baseParams({
        state: empty(),
        connectionActorId: actorB,
        delta: toWire(voted.delta),
        actorClock: freshActorClock(),
      }),
    );
    expectRejected(result, "unknown_target");
  });

  it("REQ-024: V3 — unvote за несуществующую сущность отклоняется как unknown_target", () => {
    const { actorA, state } = stickerFixture();
    const missing = fakeEntityId();
    const fakeVoteDot: Dot = { actor: actorA, counter: 99 };

    const result = validateOp({
      state,
      connectionActorId: actorA,
      delta: toWire(unvote(state, fakeVoteDot, missing)),
      actorClock: null,
    });
    expectRejected(result, "unknown_target");
  });
});

// ---------------------------------------------------------------------------
// V4 — перекрытие обосновано
// ---------------------------------------------------------------------------

describe("REQ-024: V4 — перекрытие обосновано", () => {
  it("REQ-024: V4 — supersede, ссылающийся на несуществующий в состоянии dot, отклоняется как unjustified_supersede", () => {
    const { stickerId, state } = stickerFixture();
    const actorB = newActor();
    // B видит state (запись A) и честно строит supersedes — затем мы подделываем dot перекрытия.
    const edit = setColor(state, newClock(actorB), stickerId, "blue");
    const tampered = withSupersedeDot(toWire(edit.delta), { counter: 999 });

    const result = validateOp(
      baseParams({
        state,
        connectionActorId: actorB,
        delta: tampered,
        actorClock: { lastCounter: 0, lastLamport: 0, boardMaxLamport: 1 },
      }),
    );
    expectRejected(result, "unjustified_supersede");
  });

  it("REQ-024: V4 — supersede на запись, метка которой не меньше собственной, отклоняется как unjustified_supersede", () => {
    const { clockA, stickerId, state } = stickerFixture();
    // Второй ход actorA — растит max lamport видимого состояния до 2, supersedes = запись из фикстуры (lamport 1).
    const edit1 = setColor(state, clockA, stickerId, "green");
    const state2 = merge(state, edit1.delta);
    // edit1: lamport = max(0, maxLamport(state)=1) + 1 = 2; supersedes -> запись создания (lamport 1).
    const actorB = newActor();
    const edit2 = setColor(state2, newClock(actorB), stickerId, "blue");
    // edit2: lamport = max(0, maxLamport(state2)=2) + 1 = 3; supersedes -> edit1 (lamport 2).
    // Подделываем: понижаем lamport собственной записи ниже той, что перекрываем (2 < 2 не строго меньше).
    const tampered = withEntryStamp(toWire(edit2.delta), { lamport: 2 });

    const result = validateOp(
      baseParams({
        state: state2,
        connectionActorId: actorB,
        delta: tampered,
        actorClock: { lastCounter: 0, lastLamport: 0, boardMaxLamport: 2 },
      }),
    );
    expectRejected(result, "unjustified_supersede");
  });
});

// ---------------------------------------------------------------------------
// V5 — метка
// ---------------------------------------------------------------------------

describe("REQ-024: V5 — метка", () => {
  it("REQ-024: V5 — entry.stamp.actor не совпадает с dot.actor отклоняется как invalid_stamp", () => {
    const { actorA, clockA, stickerId, state } = stickerFixture();
    const edit = setColor(state, clockA, stickerId, "green");
    const impostor = newActor();
    const tampered = withEntryStamp(toWire(edit.delta), { actor: impostor });

    const result = validateOp(
      baseParams({
        state,
        connectionActorId: actorA,
        delta: tampered,
        actorClock: { lastCounter: 1, lastLamport: 1, boardMaxLamport: 1 },
      }),
    );
    expectRejected(result, "invalid_stamp");
  });

  it("REQ-024: V5 — entry.stamp.lamport не строго больше last_L(a) отклоняется как invalid_stamp", () => {
    const { actorA, clockA, stickerId, state } = stickerFixture();
    const edit = setColor(state, clockA, stickerId, "green"); // stamp.lamport = 2

    const result = validateOp(
      baseParams({
        state,
        connectionActorId: actorA,
        delta: toWire(edit.delta),
        // актор якобы уже был на lamport 5 — 2 не больше 5.
        actorClock: { lastCounter: 1, lastLamport: 5, boardMaxLamport: 5 },
      }),
    );
    expectRejected(result, "invalid_stamp");
  });

  it("REQ-024: V5 — entry.stamp.lamport, раздутый далеко за L_S + K, отклоняется как invalid_stamp", () => {
    const { actorA, clockA, stickerId, state } = stickerFixture();
    const edit = setColor(state, clockA, stickerId, "green");
    const tampered = withEntryStamp(toWire(edit.delta), { lamport: 10_000_000 });

    const result = validateOp(
      baseParams({
        state,
        connectionActorId: actorA,
        delta: tampered,
        actorClock: { lastCounter: 1, lastLamport: 1, boardMaxLamport: 1 },
      }),
    );
    expectRejected(result, "invalid_stamp");
  });
});

// ---------------------------------------------------------------------------
// Позитивные случаи — по одному на тип операции
// ---------------------------------------------------------------------------

describe("REQ-024: валидная дельта принимается для каждого типа операции", () => {
  it("REQ-024: create — новый стикер с нуля принимается", () => {
    const actorA = newActor();
    const created = createSticker(empty(), newClock(actorA), {
      column: "start",
      frac: "m",
      text: "hello",
      color: "yellow",
    });

    const result = validateOp(
      baseParams({
        state: empty(),
        connectionActorId: actorA,
        delta: toWire(created.delta),
        actorClock: freshActorClock(),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("REQ-024: write — правка существующей сущности с обоснованным supersede принимается", () => {
    const { stickerId, state } = stickerFixture();
    const actorB = newActor();
    const edit = setColor(state, newClock(actorB), stickerId, "blue");

    const result = validateOp(
      baseParams({
        state,
        connectionActorId: actorB,
        delta: toWire(edit.delta),
        actorClock: freshActorClock(1),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("REQ-024: vote — голос за существующую сущность принимается", () => {
    const { stickerId, state } = stickerFixture();
    const actorB = newActor();
    const voted = vote(state, newClock(actorB), stickerId, "voter-token-b");

    const result = validateOp(
      baseParams({
        state,
        connectionActorId: actorB,
        delta: toWire(voted.delta),
        actorClock: freshActorClock(1),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("REQ-024: unvote — отзыв собственного действующего голоса принимается", () => {
    const { actorA, clockA, stickerId, state } = stickerFixture();
    const voted = vote(state, clockA, stickerId, "voter-token-a");
    const stateWithVote = merge(state, voted.delta);

    const result = validateOp({
      state: stateWithVote,
      connectionActorId: actorA,
      delta: toWire(unvote(stateWithVote, voted.dot, stickerId)),
      actorClock: null,
    });
    expect(result.ok).toBe(true);
  });
});
