// Генератор намерений — docs/spec/simulator.md § 5.1/5.2, docs/design/
// T-005-simulator.md § 5.6. Ведёт себя как честный интерфейс: действует
// только на видимые клиенту сущности, предлагает только разрешённые
// матрицей `docs/security/permissions.md` действия для роли и фазы,
// которую клиент знает из своего последнего `meta`/`welcome` (SIM-06).
//
// Дельту сам не строит — намерение передаётся в `SyncClient.act` (ядро
// клиента строит дельту); генератор не может подделать операцию (SIM-06 кр. 1).
//
// Использует настоящие `checkPermission`/`checkVotePermission` из
// `@retro/server-core` (публичный API) для решения «разрешено ли это роли
// в этой фазе» — не копия правил V6/V7: генератор не оракул (SIM-01 кр. 2
// запрещает переизобретать V1–V7 только оракулу/проверкам, не «миру»); это
// тот же принцип, что использование настоящего `createBoardServer` для
// самого приёма. `classifyAction` не вызывается — она принимает уже
// построенную дельту, которой у генератора ещё нет; классификация
// намерение→`StickerAction` сделана заново по той же логике (маленькая,
// без риска: 5 строк соответствия вида намерения виду действия).

import type { Intent } from "@retro/client-core";
import type { Color, Column, EntityId, Kind, State } from "@retro/crdt";
import { elementAt, entityKind, isVoteActive, winner } from "@retro/crdt";
import type { Command, Phase } from "@retro/protocol";
import { checkPermission, checkVotePermission, type StickerAction } from "@retro/server-core";
import type { Prng } from "./prng.js";
import type { World } from "./world.js";

const COLUMNS: readonly Column[] = ["start", "stop", "continue"];
const COLORS: readonly Color[] = ["yellow", "green", "blue", "pink", "purple"];
const FRAC_ALPHABET = "abc";

function randomFrac(prng: Prng): string {
  const length = prng.int(1, 2);
  let frac = "";
  for (let i = 0; i < length; i++) frac += FRAC_ALPHABET[prng.int(0, FRAC_ALPHABET.length - 1)];
  return frac;
}

function pickOne<T>(prng: Prng, items: readonly T[]): T {
  const item = items[prng.int(0, items.length - 1)];
  if (item === undefined) throw new Error("pickOne: items must be non-empty");
  return item;
}

/** Сколько раз выборка пробует случайную сущность, прежде чем сдаться («подходящих нет»). */
const SAMPLE_TRIES = 24;

/** Проверка пригодности сущности как цели; вид известен из `created`. */
type Accept = (id: EntityId, kind: Kind) => boolean;

/**
 * Случайная подходящая цель из состояния клиента. С вероятностью `hot` — из последних
 * затронутых сущностей (§ 5.1), иначе равномерная выборка из `created` с отбраковкой:
 * O(SAMPLE_TRIES · log n) вместо построения полного view (O(n) на каждое действие).
 * `created` клиента — ровно то, что он знает (свои неподтверждённые создания тоже,
 * чужие скрытые стикеры до reveal — нет), так что «видимость» сохраняется.
 */
function pickEntity(
  prng: Prng,
  state: State,
  hot: number,
  recent: readonly EntityId[],
  accept: Accept,
): EntityId | undefined {
  if (state.created.size === 0) return undefined;
  if (recent.length > 0 && prng.next() < hot) {
    const pool = recent.filter((id) => {
      const kind = entityKind(state, id);
      return kind !== undefined && accept(id, kind);
    });
    if (pool.length > 0) return pickOne(prng, pool);
  }
  for (let attempt = 0; attempt < SAMPLE_TRIES; attempt++) {
    const created = elementAt(state.created, prng.int(0, state.created.size - 1));
    if (created && accept(created.id, created.kind)) return created.id;
  }
  return undefined;
}

/** Намерение → `StickerAction` (только для стикеров — как `classifyAction`, но без готовой дельты). */
function stickerActionFor(kind: Intent["type"]): StickerAction | null {
  switch (kind) {
    case "createSticker":
      return "createSticker";
    case "createAction":
      return "createAction";
    case "editText":
    case "setColor":
    case "delete":
    case "restore":
      return "editSticker";
    case "move":
      return "moveSticker";
    case "setGroup":
      return "assignGroup";
    default:
      return null;
  }
}

export function generateIntent(world: World, clientIndex: number, prng: Prng): Intent | null {
  const client = world.clients[clientIndex];
  if (!client) return null;
  const guest = world.guests[client.guestIndex];
  if (!guest || guest.role === "viewer") return null;

  const snapshot = client.core.inspect();
  const phase: Phase = snapshot.meta?.phase ?? "collect";
  const role = guest.role;
  const state = snapshot.full;
  const profile = world.config.profile;
  const hot = profile.hot;
  const weights = profile.intentWeights[phase] ?? {};

  type Builder = () => Intent | null;
  const candidates: [Intent["type"], number, Builder][] = [];

  const permitted = (kind: Intent["type"], isOwn: boolean): boolean => {
    const action = stickerActionFor(kind);
    if (action === null) return true; // не гейтится T-011 — структурно всегда разрешено
    return checkPermission({ role, phase, action, isOwn }).ok;
  };

  const weightOf = (kind: Intent["type"]): number => weights[kind] ?? profile.defaultIntentWeight;

  const isDeleted = (id: EntityId): boolean =>
    winner(state, { entity: id, field: "deleted" })?.value === true;
  const isOwn = (id: EntityId): boolean => world.oracle.stickerAuthor.get(id) === guest.id;
  const target = (accept: Accept): EntityId | undefined =>
    pickEntity(prng, state, hot, world.recent, accept);

  /** Живой стикер, который эта роль может править в этой фазе: чужие — только там, где матрица прав это разрешает. */
  const stickerScope = (kind: Intent["type"]): Accept | null => {
    if (permitted(kind, false)) return (id, k) => k === "sticker" && !isDeleted(id);
    if (permitted(kind, true)) return (id, k) => k === "sticker" && !isDeleted(id) && isOwn(id);
    return null;
  };
  const liveGroup: Accept = (id, k) => k === "group" && !isDeleted(id);
  const liveAction: Accept = (id, k) => k === "action" && !isDeleted(id);
  const hasEntities = state.created.size > 0;

  if (permitted("createSticker", true)) {
    candidates.push([
      "createSticker",
      weightOf("createSticker"),
      () => ({
        type: "createSticker",
        column: pickOne(prng, COLUMNS),
        frac: randomFrac(prng),
        text: prng.word(),
        color: pickOne(prng, COLORS),
      }),
    ]);
  }

  if (permitted("createAction", true)) {
    candidates.push([
      "createAction",
      weightOf("createAction"),
      () => ({ type: "createAction", text: prng.word() }),
    ]);
  }

  // editText/setColor/delete — гейтятся только для СВОИХ стикеров: участник вне
  // collect/group не может ничего, а в этих фазах правит лишь свои (матрица прав).
  const editable = hasEntities ? stickerScope("editText") : null;
  if (editable) {
    candidates.push([
      "editText",
      weightOf("editText"),
      () => {
        const id = target(editable);
        return id === undefined ? null : { type: "editText", id, text: prng.word() };
      },
    ]);
    candidates.push([
      "setColor",
      weightOf("setColor"),
      () => {
        const id = target(editable);
        return id === undefined ? null : { type: "setColor", id, color: pickOne(prng, COLORS) };
      },
    ]);
    candidates.push([
      "delete",
      weightOf("delete"),
      () => {
        const id = target(editable);
        return id === undefined ? null : { type: "delete", id };
      },
    ]);
  }

  const movable = hasEntities ? stickerScope("move") : null;
  if (movable) {
    candidates.push([
      "move",
      weightOf("move"),
      () => {
        const id = target(movable);
        if (id === undefined) return null;
        return {
          type: "move",
          id,
          place: { column: pickOne(prng, COLUMNS), frac: randomFrac(prng) },
        };
      },
    ]);
  }

  if (hasEntities && permitted("setGroup", false)) {
    const anySticker: Accept = (id, k) => k === "sticker" && !isDeleted(id);
    candidates.push([
      "setGroup",
      weightOf("setGroup"),
      () => {
        const id = target(anySticker);
        if (id === undefined) return null;
        const group = prng.next() < 0.7 ? (target(liveGroup) ?? null) : null;
        return { type: "setGroup", id, group };
      },
    ]);
  }

  // restore гейтится как editSticker (classifyAction), но только для стикеров:
  // группы T-011 не гейтит. Участнику предлагаем лишь то, что интерфейс дал бы
  // восстановить — свои стикеры и группы (авторство стикера — по оракулу; у
  // ещё не подтверждённого своего стикера оно неизвестно, его пропускаем).
  if (hasEntities) {
    const anyRestore = permitted("restore", false);
    const ownRestore = permitted("restore", true);
    if (anyRestore || ownRestore) {
      const restorable: Accept = (id, k) => {
        if (k === "action" || !isDeleted(id)) return false;
        return k === "group" || anyRestore || isOwn(id);
      };
      candidates.push([
        "restore",
        weightOf("restore"),
        () => {
          const id = target(restorable);
          return id === undefined ? null : { type: "restore", id };
        },
      ]);
    }
  }

  // createGroup/renameGroup — не гейтится T-011 (classifyAction возвращает
  // null для group), доступно всегда, кроме viewer (уже исключён выше).
  candidates.push([
    "createGroup",
    weightOf("createGroup"),
    () => ({
      type: "createGroup",
      column: pickOne(prng, COLUMNS),
      frac: randomFrac(prng),
      title: prng.word(),
    }),
  ]);
  if (hasEntities) {
    candidates.push([
      "renameGroup",
      weightOf("renameGroup"),
      () => {
        const id = target(liveGroup);
        return id === undefined ? null : { type: "renameGroup", id, title: prng.word() };
      },
    ]);

    // editAction/assign/setDone — не гейтятся T-011, всегда доступны при наличии цели.
    candidates.push([
      "editAction",
      weightOf("editAction"),
      () => {
        const id = target(liveAction);
        return id === undefined ? null : { type: "editAction", id, text: prng.word() };
      },
    ]);
    candidates.push([
      "assign",
      weightOf("assign"),
      () => {
        const id = target(liveAction);
        if (id === undefined) return null;
        const guestIds = world.guests.map((g) => g.id);
        const assignee = prng.next() < 0.7 && guestIds.length > 0 ? pickOne(prng, guestIds) : null;
        return { type: "assign", id, guestId: assignee };
      },
    ]);
    candidates.push([
      "setDone",
      weightOf("setDone"),
      () => {
        const id = target(liveAction);
        return id === undefined ? null : { type: "setDone", id, done: prng.next() < 0.5 };
      },
    ]);
  }

  if (
    hasEntities &&
    snapshot.voterToken !== null &&
    checkVotePermission({ role, phase, action: "vote" }).ok
  ) {
    const votable: Accept = (id, k) => (k === "sticker" || k === "group") && !isDeleted(id);
    candidates.push([
      "vote",
      weightOf("vote"),
      () => {
        const id = target(votable);
        return id === undefined ? null : { type: "vote", target: id };
      },
    ]);
  }

  if (
    state.votes.size > 0 &&
    snapshot.voterToken !== null &&
    checkVotePermission({ role, phase, action: "unvote" }).ok
  ) {
    const voter = snapshot.voterToken;
    candidates.push([
      "unvote",
      weightOf("unvote"),
      () => {
        // Свои ещё не отозванные голоса: равномерная выборка из V⁺ с отбраковкой.
        for (let attempt = 0; attempt < SAMPLE_TRIES; attempt++) {
          const vote = elementAt(state.votes, prng.int(0, state.votes.size - 1));
          if (vote && vote.user === voter && isVoteActive(state, vote)) {
            return { type: "unvote", voteDot: vote.dot, target: vote.target };
          }
        }
        return null;
      },
    ]);
  }

  // Выбор вида по весам; если у выбранного нет подходящей цели — берём следующий.
  const remaining = [...candidates];
  while (remaining.length > 0) {
    const items: (readonly [Builder, number])[] = remaining.map(([, weight, build]) => [
      build,
      weight,
    ]);
    const build = prng.pick(items);
    const intent = build();
    if (intent) return intent;
    const index = remaining.findIndex(([, , candidate]) => candidate === build);
    remaining.splice(index, 1);
  }
  return null;
}

/**
 * Команда владельца/фасилитатора (E7) — `setPhase`/`resetVotes` (§ 5.6
 * проекта). `grantFacilitator`/таймер — вне области симулятора (§ 14
 * спецификации).
 */
export function generateCommand(world: World, clientIndex: number, prng: Prng): Command | null {
  const client = world.clients[clientIndex];
  if (!client) return null;
  const guest = world.guests[client.guestIndex];
  if (!guest || (guest.role !== "owner" && guest.role !== "facilitator")) return null;

  const phase = world.store.boardSync(world.boardId)?.phase ?? "collect";
  const profile = world.config.profile;

  // reveal только при клиенте без соединения (профиль reveal, H1): иначе — не сейчас.
  if (phase === "collect" && profile.revealNeedsOffline) {
    const someoneOffline = world.clients.some((c, i) => i !== clientIndex && c.connection === null);
    if (!someoneOffline) return null;
  }

  if (phase === "vote" && prng.next() < profile.resetVotesShare) {
    return { type: "resetVotes" };
  }

  // Изредка — запрещённая попытка вернуться в collect (S7: irreversible_phase).
  if (phase !== "collect" && prng.next() < 0.05) {
    return { type: "setPhase", phase: "collect" };
  }

  const order: Phase[] = ["collect", "group", "vote", "discuss", "actions"];
  const index = order.indexOf(phase);
  const next = order[Math.min(index + 1, order.length - 1)] ?? "actions";
  return { type: "setPhase", phase: next };
}
