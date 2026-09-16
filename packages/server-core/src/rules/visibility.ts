// T-013 — проекция видимости `proj_u` (docs/spec/consistency-model.md § 5,
// REQ-006). Чистая функция: видимость сущности решает только то, был ли для
// неё записан автор (`store.authors`, только `kind === "sticker"`) и
// совпадает ли он с получателем — группы/action item авторства не имеют и
// поэтому всегда видимы (REQ-006 говорит только про стикеры: «участник
// видит только стикеры, автором которых является он сам»). Решение о ТОМ,
// когда вообще фильтровать (только пока `phase === "collect"`, до reveal) —
// не здесь, а на стороне вызывающего (`handlers/hello.ts`/`handlers/op.ts`):
// вне `collect` `projectVisible`/`projectHidden` не вызываются, дельта идёт
// как есть.
//
// T-024: переехала из apps/server/src/ops/visibility.ts (реэкспорт там
// остаётся) без изменения поведения.

import type { EntityId, WireDelta } from "@retro/crdt";

/** `undefined` — автор не записан (не стикер, либо авторство ещё не записано). */
export type AuthorOf = (id: EntityId) => string | undefined;

function filterDelta(delta: WireDelta, keep: (id: EntityId) => boolean): WireDelta {
  return {
    created: delta.created.filter((c) => keep(c.id)),
    entries: delta.entries.filter((e) => keep(e.key.entity)),
    supersedes: delta.supersedes.filter((s) => keep(s.key.entity)),
    votes: delta.votes.filter((v) => keep(v.target)),
    unvotes: delta.unvotes.filter((w) => keep(w.target)),
  };
}

/**
 * `proj_u(delta)` — то, что видно `guestId` прямо сейчас: свои стикеры и
 * всё, у чего нет отслеживаемого автора (P1: фильтр покомпонентный, поэтому
 * `projectVisible(X ⊔ Y) = projectVisible(X) ⊔ projectVisible(Y)`).
 */
export function projectVisible(delta: WireDelta, authorOf: AuthorOf, guestId: string): WireDelta {
  return filterDelta(delta, (id) => {
    const author = authorOf(id);
    return author === undefined || author === guestId;
  });
}

/**
 * Дополнение `projectVisible` — то, что было скрыто от `guestId` именно
 * потому, что принадлежит другому автору. Используется в момент `reveal`
 * (protocol.md § 6): «сервер рассылает... `op` с сущностями, которые
 * получатель раньше не видел» — раньше не видел ровно то, что не прошло бы
 * `projectVisible` для него, пока доска была в `collect`. Также используется
 * досылкой при переподключении после `reveal` (T-026, H1).
 */
export function projectHidden(delta: WireDelta, authorOf: AuthorOf, guestId: string): WireDelta {
  return filterDelta(delta, (id) => {
    const author = authorOf(id);
    return author !== undefined && author !== guestId;
  });
}

/** Пустая ли дельта после фильтрации — не слать `op` без содержимого (не течь фактом «что-то произошло», CLAUDE.md § 5 «утечка авторства... через... время операций»). */
export function isEmptyDelta(delta: WireDelta): boolean {
  return (
    delta.created.length === 0 &&
    delta.entries.length === 0 &&
    delta.supersedes.length === 0 &&
    delta.votes.length === 0 &&
    delta.unvotes.length === 0
  );
}
