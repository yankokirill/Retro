// SIM-08 / S1 — docs/spec/simulator.md § 8 (строка S1), § 5.5 проекта.
//
// W1: одна пара (ячейка, dot) не встречается в журнале с разными значениями.
// W2: разные операции имеют разные метки (lamport, actor).
// W3: каждое перекрытие (k, s) пришло в дельте с записью в k, у которой
//     lamport строго больше, чем у перекрытой записи s.
// W4: для каждой (id, kind) ∈ C в журнале есть записи с dot = id во ВСЕХ
//     полях этого вида (docs/spec/consistency-model.md § 1.4).
//
// Строки журнала собраны настоящим API `@retro/crdt` (createSticker/editText/
// toWire), затем часть строк испорчена вручную вставкой заведомо неверного
// поля — ровно так, как просит T-005: форма настоящая, нарушение — намеренное.
//
// Ожидаемый результат ПРЯМО СЕЙЧАС: `createWellFormedState`/`addRow`/
// `checkFull` (packages/sim/src/well-formed.ts) и
// `checkWellFormedIncremental`/`checkWellFormedFull` (packages/sim/src/checks.ts)
// — заглушки, бросающие `Error("...: not implemented")`. Каждый `it` ниже
// падает именно на этом вызове, а не из-за ошибки в построении строк.

import type { State } from "@retro/crdt";
import { createSticker, editText, empty, merge, newClock, toWire } from "@retro/crdt";
import type { OpRow } from "@retro/server-core";
import { describe, expect, it } from "vitest";
import { checkWellFormedFull, checkWellFormedIncremental } from "../src/checks.js";
import { addRow, checkFull, createWellFormedState } from "../src/well-formed.js";

const ACTOR_A = "actor-a";
const ACTOR_B = "actor-b";
const ACTOR_C = "actor-c";

/** Два валидных подряд идущих действия: createSticker, затем editText — W1–W4 держатся. */
function buildValidRows(): { readonly rows: readonly OpRow[]; readonly id: string } {
  let state: State = empty();
  const created = createSticker(state, newClock(ACTOR_A), {
    column: "start",
    frac: "m",
    text: "hello",
    color: "yellow",
  });
  state = merge(state, created.delta);
  const [createdEntity] = [...created.delta.created.values()];
  if (!createdEntity) throw new Error("buildValidRows: createSticker did not create an entity");
  const id = createdEntity.id;
  const row1: OpRow = { seq: 1, delta: toWire(created.delta) };

  const edited = editText(state, created.clock, id, "world");
  state = merge(state, edited.delta);
  const row2: OpRow = { seq: 2, delta: toWire(edited.delta) };

  return { rows: [row1, row2], id };
}

function textEntry(row: OpRow) {
  const entry = row.delta.entries.find((e) => e.key.field === "text");
  if (!entry) throw new Error("textEntry: no text entry in row");
  return entry;
}

describe("SIM-08 / S1 (W1–W4): well-formed.ts — инкрементально", () => {
  it("SIM-08 / S1: валидная последовательность createSticker+editText не нарушает ни один шаг", () => {
    const { rows } = buildValidRows();
    const state = createWellFormedState();
    for (const row of rows) {
      expect(addRow(state, row)).toBeNull();
    }
  });

  it("SIM-08 / S1 (W1): та же пара (ячейка, dot), другое значение — нарушение на строке, где это обнаружено", () => {
    const { rows } = buildValidRows();
    const state = createWellFormedState();
    for (const row of rows) {
      expect(addRow(state, row)).toBeNull();
    }

    const entry = textEntry(rows[0] as OpRow);
    const corrupted: OpRow = {
      seq: 3,
      delta: {
        created: [],
        entries: [{ ...entry, value: "HACKED" }],
        supersedes: [],
        votes: [],
        unvotes: [],
      },
    };

    const violation = addRow(state, corrupted);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S1");
  });

  it("SIM-08 / S1 (W2): две разные операции с одной меткой (lamport, actor) — нарушение", () => {
    const { rows, id } = buildValidRows();
    const state = createWellFormedState();
    for (const row of rows) {
      expect(addRow(state, row)).toBeNull();
    }

    const reusedStamp = textEntry(rows[0] as OpRow).stamp;
    const forged: OpRow = {
      seq: 3,
      delta: {
        created: [],
        entries: [
          {
            key: { entity: id, field: "color" },
            dot: { actor: ACTOR_A, counter: 99 }, // другой dot, чем у row1
            stamp: reusedStamp, // но та же метка — нарушает W2
            value: "green",
          },
        ],
        supersedes: [],
        votes: [],
        unvotes: [],
      },
    };

    const violation = addRow(state, forged);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S1");
  });

  it("SIM-08 / S1 (W3): перекрытие с lamport, не большим, чем у перекрытой записи — нарушение", () => {
    const { rows, id } = buildValidRows();
    const state = createWellFormedState();
    for (const row of rows) {
      expect(addRow(state, row)).toBeNull();
    }

    // row2 (editText) уже перекрыл текст row1 с lamport=2 > 1. Форджим третью
    // запись, которая якобы перекрывает row2 (lamport=2), но сама несёт
    // lamport=1 — по W3 это невозможно у честной реплики (V4).
    const row2Text = textEntry(rows[1] as OpRow);
    const forged: OpRow = {
      seq: 3,
      delta: {
        created: [],
        entries: [
          {
            key: { entity: id, field: "text" },
            dot: { actor: ACTOR_B, counter: 1 },
            stamp: { lamport: 1, actor: ACTOR_B }, // не больше lamport row2Text (2)
            value: "forged",
          },
        ],
        supersedes: [{ key: { entity: id, field: "text" }, dot: row2Text.dot }],
        votes: [],
        unvotes: [],
      },
    };

    const violation = addRow(state, forged);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S1");
  });

  it("SIM-08 / S1 (W4): created без записи во всех обязательных полях вида — нарушение", () => {
    const state = createWellFormedState();
    const brokenId = `${ACTOR_C}:1`;
    const broken: OpRow = {
      seq: 1,
      delta: {
        created: [{ id: brokenId, kind: "sticker" }],
        // sticker требует text, color, place, group, deleted (§ 1.4) — здесь только text.
        entries: [
          {
            key: { entity: brokenId, field: "text" },
            dot: { actor: ACTOR_C, counter: 1 },
            stamp: { lamport: 1, actor: ACTOR_C },
            value: "hi",
          },
        ],
        supersedes: [],
        votes: [],
        unvotes: [],
      },
    };

    const violation = addRow(state, broken);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S1");
  });
});

describe("SIM-08 / S1 (W1–W4): well-formed.ts — checkFull (проход с нуля)", () => {
  it("SIM-08 / S1: checkFull на валидном журнале — null", () => {
    const { rows } = buildValidRows();
    expect(checkFull(rows)).toBeNull();
  });

  it("SIM-08 / S1 (W1): checkFull ловит испорченный журнал (дубль dot с другим значением)", () => {
    const { rows } = buildValidRows();
    const entry = textEntry(rows[0] as OpRow);
    const corrupted: OpRow = {
      seq: 3,
      delta: {
        created: [],
        entries: [{ ...entry, value: "HACKED" }],
        supersedes: [],
        votes: [],
        unvotes: [],
      },
    };

    const violation = checkFull([...rows, corrupted]);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S1");
  });
});

describe("SIM-08 / S1: checks.ts — обёртка над well-formed.ts с проставленным ID", () => {
  it("SIM-08 / S1: checkWellFormedIncremental прокидывает null для валидной строки", () => {
    const { rows } = buildValidRows();
    const state = createWellFormedState();
    for (let i = 0; i < rows.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: i < rows.length
      const violation = checkWellFormedIncremental(state, rows[i]!, i + 1);
      expect(violation).toBeNull();
    }
  });

  it("SIM-08 / S1: checkWellFormedIncremental прокидывает нарушение с property S1 для испорченной строки", () => {
    const { rows } = buildValidRows();
    const state = createWellFormedState();
    for (let i = 0; i < rows.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: i < rows.length
      expect(checkWellFormedIncremental(state, rows[i]!, i + 1)).toBeNull();
    }

    const entry = textEntry(rows[0] as OpRow);
    const corrupted: OpRow = {
      seq: 3,
      delta: {
        created: [],
        entries: [{ ...entry, value: "HACKED" }],
        supersedes: [],
        votes: [],
        unvotes: [],
      },
    };
    const violation = checkWellFormedIncremental(state, corrupted, rows.length + 1);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S1");
  });

  it("SIM-08 / S1: checkWellFormedFull — null на валидном журнале, нарушение с property S1 на испорченном", () => {
    const { rows } = buildValidRows();
    expect(checkWellFormedFull(rows, rows.length)).toBeNull();

    const entry = textEntry(rows[0] as OpRow);
    const corrupted: OpRow = {
      seq: 3,
      delta: {
        created: [],
        entries: [{ ...entry, value: "HACKED" }],
        supersedes: [],
        votes: [],
        unvotes: [],
      },
    };
    const violation = checkWellFormedFull([...rows, corrupted], rows.length + 1);
    expect(violation).not.toBeNull();
    expect(violation?.property).toBe("S1");
  });
});
