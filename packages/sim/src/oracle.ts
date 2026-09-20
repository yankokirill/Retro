// Оракул — независимое от проверяемого кода вычисление ожидаемого состояния
// и видимости, docs/spec/simulator.md § 8, docs/design/T-005-simulator.md
// § 5.4. Реализован заново по спецификации: `proj` НЕ импортирует
// `projectVisible` из `@retro/server-core` (SIM-01 кр. 2) — иначе оракул
// разделял бы ошибку с проверяемым кодом и M3/M6 (§ 10.2) не могли бы упасть.

import type { Created, EntityId, Entry, Kind, State, Supersede, Unvote, Vote } from "@retro/crdt";
import { empty, equals, fromWire, merge } from "@retro/crdt";
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
  for (const row of rows) {
    if (row.seq <= state.lastFoldedSeq) {
      throw new Error(
        `foldNewRows: строка seq=${row.seq} не больше уже свёрнутого lastFoldedSeq=${state.lastFoldedSeq}`,
      );
    }
    state.x = merge(state.x, fromWire(row.delta));
    state.lastFoldedSeq = row.seq;
  }
}

function isVisible(
  id: EntityId,
  phase: Phase,
  kindOf: ReadonlyMap<EntityId, Kind>,
  stickerAuthor: ReadonlyMap<EntityId, string>,
  guestId: string,
): boolean {
  if (phase !== "collect") return true;
  // Стикер — это либо известный вид `sticker`, либо сущность с записанным автором: `created`
  // мог быть скрыт от получателя или ещё не прийти, а записи/голоса на неё уже есть.
  const isSticker = kindOf.get(id) === "sticker" || stickerAuthor.has(id);
  if (!isSticker) return true;
  return stickerAuthor.get(id) === guestId;
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
  const kindOf = new Map<EntityId, Kind>();
  for (const created of state.created.values()) kindOf.set(created.id, created.kind);
  const visible = (id: EntityId): boolean => isVisible(id, phase, kindOf, stickerAuthor, guestId);

  const created = new Map<string, Created>();
  for (const [k, v] of state.created) if (visible(v.id)) created.set(k, v);
  const entries = new Map<string, Entry>();
  for (const [k, v] of state.entries) if (visible(v.key.entity)) entries.set(k, v);
  const supersedes = new Map<string, Supersede>();
  for (const [k, v] of state.supersedes) if (visible(v.key.entity)) supersedes.set(k, v);
  const votes = new Map<string, Vote>();
  for (const [k, v] of state.votes) if (visible(v.target)) votes.set(k, v);
  const unvotes = new Map<string, Unvote>();
  for (const [k, v] of state.unvotes) if (visible(v.target)) unvotes.set(k, v);

  return { created, entries, supersedes, votes, unvotes };
}

/** `proj_a(X) equals proj_b(X)` — совпадает ли видимость двух гостей (S5). */
export function visibleSame(
  state: State,
  phase: Phase,
  stickerAuthor: ReadonlyMap<EntityId, string>,
  a: string,
  b: string,
): boolean {
  return equals(proj(state, phase, stickerAuthor, a), proj(state, phase, stickerAuthor, b));
}

/** Сворачивает произвольный список строк журнала в состояние с нуля (для тестов и не инкрементального пути). */
export function foldLog(rows: readonly OpRow[]): State {
  return rows.reduce((acc, row) => merge(acc, fromWire(row.delta)), empty());
}
