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

import type { OpRow } from "@retro/server-core";
import type { PropertyId, Violation } from "./violation.js";

/** Непрозрачное накопленное состояние инкрементальной проверки — индексы по journal. */
export interface WellFormedState {
  readonly __brand: "WellFormedState";
}

export function createWellFormedState(): WellFormedState {
  throw new Error("createWellFormedState: not implemented");
}

/** Инкрементально добавляет одну строку журнала; `null` — нарушений нет. */
export function addRow(state: WellFormedState, row: OpRow): Violation | null {
  throw new Error("addRow: not implemented");
}

/**
 * Полная проверка всего журнала с нуля (в контрольной точке, § 6 проекта —
 * «сравнивает, что инкрементальный и полный результаты совпадают»).
 */
export function checkFull(rows: readonly OpRow[]): Violation | null {
  throw new Error("checkFull: not implemented");
}

export const WELL_FORMED_PROPERTY: PropertyId = "S1";
