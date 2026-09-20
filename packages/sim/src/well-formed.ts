// W1–W4 — docs/spec/consistency-model.md § 7, docs/spec/simulator.md § 8
// (S1), docs/design/T-005-simulator.md § 5.5. Проверяется журнал
// `MemoryBoardStore` (то, что реально было принято сервером), не X_S и не
// ядро — это свойство ДАННЫХ, а не поведения кода, поэтому не пересекается
// с оракулом § 5.4 (SIM-01 кр. 2 касается видимости/`proj`, не журнала).
//
// W1 — одна пара (ячейка, dot) не встречается в журнале с разными значениями.
// W2 — разные операции (разные dot) не делят одну и ту же метку (lamport, actor).
// W3 — каждое перекрытие (k, s) пришло в дельте с записью в k с lamport
//      строго больше lamport записи s (если s уже видна журналу).
// W4 — каждое `created (id, kind)` сопровождается в той же дельте записями
//      dot = id во всех обязательных полях этого вида (`consistency-model.md`
//      § 1.4 — не импортируется из server-core: W4 — свойство журнала по
//      спецификации, не проверка кода сервера, как и весь оракул § 5.4).

import { dotKey, type Field, type Kind, type Value } from "@retro/crdt";
import type { OpRow } from "@retro/server-core";
import { type Violation, violation } from "./violation.js";

/** § 1.4 consistency-model.md — обязательные поля, которые `created` обязан сопровождать записями в той же дельте. */
const FIELDS_BY_KIND: Readonly<Record<Kind, readonly Field[]>> = {
  sticker: ["text", "color", "place", "group", "deleted"],
  group: ["title", "place", "deleted"],
  action: ["text", "assignee", "done", "deleted"],
};

function canonicalValue(value: Value): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  return `place:${value.column}:${value.frac}`;
}

interface WellFormedInternal {
  /** W1: `entity|field|dotKey(dot)` → каноническое значение, впервые увиденное для этой пары. */
  readonly cellDot: Map<string, string>;
  /** W2: `lamport|actor` → dotKey операции, впервые занявшей эту метку. */
  readonly stampToDot: Map<string, string>;
  /** W3: `entity|field|dotKey(dot)` → lamport записи — для поиска перекрываемой записи по её dot. */
  readonly entryLamport: Map<string, number>;
}

/** Непрозрачное накопленное состояние инкрементальной проверки — индексы по журналу. */
export interface WellFormedState {
  readonly __brand: "WellFormedState";
}

function asInternal(state: WellFormedState): WellFormedInternal {
  return state as unknown as WellFormedInternal;
}

export function createWellFormedState(): WellFormedState {
  const internal: WellFormedInternal = {
    cellDot: new Map(),
    stampToDot: new Map(),
    entryLamport: new Map(),
  };
  return internal as unknown as WellFormedState;
}

/** Инкрементально добавляет одну строку журнала; `null` — нарушений нет. */
export function addRow(state: WellFormedState, row: OpRow): Violation | null {
  const s = asInternal(state);
  const { delta } = row;

  // W4 — прежде всего: created этой строки должен сопровождаться записями
  // во всех обязательных полях вида, с dot = id, В ЭТОЙ ЖЕ дельте (§ 3.1
  // consistency-model.md: «все записи одной операции несут один и тот же dot»).
  for (const created of delta.created) {
    for (const field of FIELDS_BY_KIND[created.kind]) {
      const hasEntry = delta.entries.some(
        (entry) =>
          entry.key.entity === created.id &&
          entry.key.field === field &&
          dotKey(entry.dot) === created.id,
      );
      if (!hasEntry) {
        return violation(
          "S1",
          row.seq,
          `W4: created ${created.id} (${created.kind}) — нет записи в поле "${field}" с dot = id в этой же строке`,
        );
      }
    }
  }

  // W1 и W2 — по каждой записи; попутно индексируем lamport для W3.
  for (const entry of delta.entries) {
    const cellKey = `${entry.key.entity}|${entry.key.field}|${dotKey(entry.dot)}`;
    const value = canonicalValue(entry.value);
    const prevValue = s.cellDot.get(cellKey);
    if (prevValue !== undefined && prevValue !== value) {
      return violation(
        "S1",
        row.seq,
        `W1: (ячейка ${entry.key.entity}.${entry.key.field}, dot ${dotKey(entry.dot)}) уже встречалась со значением ${prevValue}, теперь ${value}`,
      );
    }
    s.cellDot.set(cellKey, value);

    const stampKey = `${entry.stamp.lamport}|${entry.stamp.actor}`;
    const thisDot = dotKey(entry.dot);
    const prevDot = s.stampToDot.get(stampKey);
    if (prevDot !== undefined && prevDot !== thisDot) {
      return violation(
        "S1",
        row.seq,
        `W2: метка (lamport=${entry.stamp.lamport}, actor=${entry.stamp.actor}) уже занята операцией ${prevDot}, теперь ${thisDot}`,
      );
    }
    s.stampToDot.set(stampKey, thisDot);

    s.entryLamport.set(cellKey, entry.stamp.lamport);
  }

  // W3 — каждое перекрытие сопровождается записью в ту же ячейку в этой же
  // строке, чей lamport строго больше lamport перекрываемой записи (если та
  // уже видна журналу — более ранний снапшот мог её не содержать, тогда
  // сравнение пропускается, как указано в § 8 «если известна»).
  for (const supersede of delta.supersedes) {
    const ownEntry = delta.entries.find(
      (entry) =>
        entry.key.entity === supersede.key.entity && entry.key.field === supersede.key.field,
    );
    if (!ownEntry) {
      return violation(
        "S1",
        row.seq,
        `W3: перекрытие ${supersede.key.entity}.${supersede.key.field} не сопровождается записью в ту же ячейку в этой же строке`,
      );
    }
    const targetKey = `${supersede.key.entity}|${supersede.key.field}|${dotKey(supersede.dot)}`;
    const targetLamport = s.entryLamport.get(targetKey);
    if (targetLamport !== undefined && targetLamport >= ownEntry.stamp.lamport) {
      return violation(
        "S1",
        row.seq,
        `W3: перекрываемая запись (dot ${dotKey(supersede.dot)}) имеет lamport=${targetLamport}, не меньше lamport перекрывающей записи (${ownEntry.stamp.lamport})`,
      );
    }
  }

  return null;
}

/**
 * Полная проверка всего журнала с нуля (в контрольной точке, § 6 проекта —
 * «сравнивает, что инкрементальный и полный результаты совпадают»).
 */
export function checkFull(rows: readonly OpRow[]): Violation | null {
  const state = createWellFormedState();
  for (const row of rows) {
    const result = addRow(state, row);
    if (result) return result;
  }
  return null;
}
