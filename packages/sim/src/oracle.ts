// Оракул — независимое от проверяемого кода вычисление ожидаемого состояния
// и видимости, docs/spec/simulator.md § 8, docs/design/T-005-simulator.md
// § 5.4. Реализован заново по спецификации: `proj` НЕ импортирует
// `projectVisible` из `@retro/server-core` (SIM-01 кр. 2) — иначе оракул
// разделял бы ошибку с проверяемым кодом и M3/M6 (§ 10.2) не могли бы упасть.

import type { EntityId, State } from "@retro/crdt";
import { empty, fromWire, merge } from "@retro/crdt";
import type { OpRow } from "@retro/server-core";
import type { Phase } from "./config.js";

export interface OracleState {
  /** Свёртка `merge` всех строк журнала с начала — X_S (§ 8: не `currentState` хранилища). */
  x: State;
  /** До какого `seq` включительно уже свёрнуто — `foldNewRows` идёт от этого значения. */
  lastFoldedSeq: number;
  /** entityId → guestId, кем на самом деле создан стикер (истинное знание мира, не таблица авторов хранилища). */
  readonly stickerAuthor: Map<EntityId, string>;
}

export function createOracleState(): OracleState {
  return { x: empty(), lastFoldedSeq: 0, stickerAuthor: new Map() };
}

/**
 * Сворачивает строки журнала с `seq > state.lastFoldedSeq` в `state.x`
 * (вызывается после каждого `deliver toServer`, § 5.3 проекта — ядро сервера
 * уже применило операцию к журналу хранилища синхронно внутри `receive`,
 * SIM-05, так что новые строки в этот момент уже видны через `store.log`).
 * Строки должны идти по возрастанию `seq`, без пропуска — иначе исключение
 * (нарушение этого условия сигнализирует об ошибке в вызывающем коде, не
 * оракула).
 */
export function foldNewRows(state: OracleState, rows: readonly OpRow[]): void {
  throw new Error("foldNewRows: not implemented");
}

/**
 * `proj_u` — видимость для гостя `guestId` (§ 5 `consistency-model.md`,
 * REQ-006): сущность видна, если фаза ≠ `collect`, или вид сущности ≠
 * `sticker`, или стикер создан любой вкладкой этого гостя. Для компонент без
 * прямой ссылки на сущность (`entries`/`supersedes`/`votes`/`unvotes`) вид
 * определяется по `stickerAuthor`/структуре журнала, а не по наличию
 * `created` в `state` (стикер мог быть создан, но его `created` скрыт от
 * получателя).
 */
export function proj(
  state: State,
  phase: Phase,
  stickerAuthor: ReadonlyMap<EntityId, string>,
  guestId: string,
): State {
  throw new Error("proj: not implemented");
}

/** `proj_a(X) equals proj_b(X)` — совпадает ли видимость двух гостей (S5). */
export function visibleSame(
  state: State,
  phase: Phase,
  stickerAuthor: ReadonlyMap<EntityId, string>,
  a: string,
  b: string,
): boolean {
  throw new Error("visibleSame: not implemented");
}

/** Сворачивает произвольный список строк журнала в состояние с нуля (для тестов и не инкрементального пути). */
export function foldLog(rows: readonly OpRow[]): State {
  return rows.reduce((acc, row) => merge(acc, fromWire(row.delta)), empty());
}
