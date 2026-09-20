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

import type { Intent, PendingEntry } from "@retro/client-core";
import type { CardView, Color, Column, EntityId, GroupView, State, View } from "@retro/crdt";
import { activeVotes, empty, entityKind, fromWire, merge } from "@retro/crdt";
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

/** С вероятностью `hot` — из последних затронутых сущностей (если это пересекается с кандидатами); иначе равномерно (§ 5.1). */
function pickTarget(
  prng: Prng,
  candidates: readonly EntityId[],
  hot: number,
  recent: readonly EntityId[],
): EntityId | undefined {
  if (candidates.length === 0) return undefined;
  const hotPool = candidates.filter((id) => recent.includes(id));
  if (hotPool.length > 0 && prng.next() < hot) return pickOne(prng, hotPool);
  return pickOne(prng, candidates);
}

interface Screen {
  readonly cards: readonly CardView[];
  readonly ownCards: readonly CardView[];
  readonly groups: readonly GroupView[];
  readonly trash: readonly EntityId[];
  readonly actions: readonly ActionScreenItem[];
}

interface ActionScreenItem {
  readonly id: EntityId;
}

function buildScreen(world: World, guestId: string, view: View): Screen {
  const cards: CardView[] = [];
  const groups: GroupView[] = [];
  for (const items of view.columns.values()) {
    for (const item of items) {
      if ("cards" in item) {
        groups.push(item);
        for (const card of item.cards) cards.push(card);
      } else {
        cards.push(item);
      }
    }
  }
  const ownCards = cards.filter((c) => world.oracle.stickerAuthor.get(c.id) === guestId);
  return { cards, ownCards, groups, trash: [...view.trash], actions: [...view.actions] };
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

function pendingState(pending: readonly PendingEntry[]): State {
  let state = empty();
  for (const entry of pending) state = merge(state, fromWire(entry.delta));
  return state;
}

export function generateIntent(world: World, clientIndex: number, prng: Prng): Intent | null {
  const client = world.clients[clientIndex];
  if (!client) return null;
  const guest = world.guests[client.guestIndex];
  if (!guest || guest.role === "viewer") return null;

  const snapshot = client.core.inspect();
  const phase: Phase = snapshot.meta?.phase ?? "collect";
  const role = guest.role;
  const screen = buildScreen(world, guest.id, snapshot.view);
  const profile = world.config.profile;
  const hot = profile.hot;
  const weights = profile.intentWeights[phase] ?? {};

  type Builder = () => Intent;
  const candidates: [Intent["type"], number, Builder][] = [];

  const permitted = (kind: Intent["type"], isOwn: boolean): boolean => {
    const action = stickerActionFor(kind);
    if (action === null) return true; // не гейтится T-011 — структурно всегда разрешено
    return checkPermission({ role, phase, action, isOwn }).ok;
  };

  const weightOf = (kind: Intent["type"]): number => weights[kind] ?? profile.defaultIntentWeight;

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

  // editText/setColor/delete/restore — гейтятся только для СВОИХ стикеров
  // (isOwn=true в вызове permitted); классификация не знает вида до
  // выбора цели, поэтому проверяем на "своих" и на "видимых вообще"
  // раздельно: participant вне collect может редактировать чужой стикер
  // ТОЛЬКО в group (permitted(..., false) для этой фазы — true у owner/
  // facilitator всегда, у participant только если checkPermission не
  // требует владения в этой фазе).
  const ownIds = screen.ownCards.map((c) => c.id);
  const anyCardIds = screen.cards.map((c) => c.id);

  const editableIds = permitted("editText", false)
    ? anyCardIds
    : permitted("editText", true)
      ? ownIds
      : [];
  if (editableIds.length > 0) {
    candidates.push([
      "editText",
      weightOf("editText"),
      () => ({
        type: "editText",
        id: mustPick(prng, editableIds, hot, world.recent),
        text: prng.word(),
      }),
    ]);
    candidates.push([
      "setColor",
      weightOf("setColor"),
      () => ({
        type: "setColor",
        id: mustPick(prng, editableIds, hot, world.recent),
        color: pickOne(prng, COLORS),
      }),
    ]);
    candidates.push([
      "delete",
      weightOf("delete"),
      () => ({ type: "delete", id: mustPick(prng, editableIds, hot, world.recent) }),
    ]);
  }

  const moveIds = permitted("move", false) ? anyCardIds : permitted("move", true) ? ownIds : [];
  if (moveIds.length > 0) {
    candidates.push([
      "move",
      weightOf("move"),
      () => ({
        type: "move",
        id: mustPick(prng, moveIds, hot, world.recent),
        place: { column: pickOne(prng, COLUMNS), frac: randomFrac(prng) },
      }),
    ]);
  }

  if (anyCardIds.length > 0 && permitted("setGroup", false)) {
    candidates.push([
      "setGroup",
      weightOf("setGroup"),
      () => {
        const id = mustPick(prng, anyCardIds, hot, world.recent);
        const groupIds = screen.groups.map((g) => g.id);
        const group = groupIds.length > 0 && prng.next() < 0.7 ? pickOne(prng, groupIds) : null;
        return { type: "setGroup", id, group };
      },
    ]);
  }

  // restore гейтится как editSticker (classifyAction), но только для стикеров:
  // группы T-011 не гейтит. Участнику предлагаем лишь то, что интерфейс дал бы
  // восстановить — свои стикеры и группы (авторство стикера — по оракулу; у
  // ещё не подтверждённого своего стикера оно неизвестно, его пропускаем).
  let restorableIds: readonly EntityId[] = screen.trash;
  if (!permitted("restore", false)) {
    const canRestoreOwn = permitted("restore", true);
    let withPending: State | null = null;
    restorableIds = screen.trash.filter((id) => {
      let kind = entityKind(snapshot.confirmed, id);
      if (kind === undefined) {
        withPending ??= merge(snapshot.confirmed, pendingState(snapshot.pending));
        kind = entityKind(withPending, id);
      }
      if (kind === "group") return true;
      return canRestoreOwn && world.oracle.stickerAuthor.get(id) === guest.id;
    });
  }
  if (restorableIds.length > 0) {
    candidates.push([
      "restore",
      weightOf("restore"),
      () => ({ type: "restore", id: mustPick(prng, restorableIds, hot, world.recent) }),
    ]);
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
  if (screen.groups.length > 0) {
    const groupIds = screen.groups.map((g) => g.id);
    candidates.push([
      "renameGroup",
      weightOf("renameGroup"),
      () => ({
        type: "renameGroup",
        id: mustPick(prng, groupIds, hot, world.recent),
        title: prng.word(),
      }),
    ]);
  }

  // editAction/assign/setDone — не гейтятся T-011, всегда доступны при наличии цели.
  if (screen.actions.length > 0) {
    const actionIds = screen.actions.map((a) => a.id);
    candidates.push([
      "editAction",
      weightOf("editAction"),
      () => ({
        type: "editAction",
        id: mustPick(prng, actionIds, hot, world.recent),
        text: prng.word(),
      }),
    ]);
    candidates.push([
      "assign",
      weightOf("assign"),
      () => {
        const guestIds = world.guests.map((g) => g.id);
        const assignee = prng.next() < 0.7 && guestIds.length > 0 ? pickOne(prng, guestIds) : null;
        return {
          type: "assign",
          id: mustPick(prng, actionIds, hot, world.recent),
          guestId: assignee,
        };
      },
    ]);
    candidates.push([
      "setDone",
      weightOf("setDone"),
      () => ({
        type: "setDone",
        id: mustPick(prng, actionIds, hot, world.recent),
        done: prng.next() < 0.5,
      }),
    ]);
  }

  if (snapshot.voterToken !== null && checkVotePermission({ role, phase, action: "vote" }).ok) {
    const voteTargets = [...anyCardIds, ...screen.groups.map((g) => g.id)];
    if (voteTargets.length > 0) {
      candidates.push([
        "vote",
        weightOf("vote"),
        () => ({ type: "vote", target: mustPick(prng, voteTargets, hot, world.recent) }),
      ]);
    }
  }

  if (snapshot.voterToken !== null && checkVotePermission({ role, phase, action: "unvote" }).ok) {
    const owned = merge(snapshot.confirmed, pendingState(snapshot.pending));
    const myVotes = activeVotes(owned).filter((v) => v.user === snapshot.voterToken);
    if (myVotes.length > 0) {
      candidates.push([
        "unvote",
        weightOf("unvote"),
        () => {
          const vote = pickOne(prng, myVotes);
          return { type: "unvote", voteDot: vote.dot, target: vote.target };
        },
      ]);
    }
  }

  if (candidates.length === 0) return null;
  const items: (readonly [Builder, number])[] = candidates.map(([, weight, build]) => [
    build,
    weight,
  ]);
  const build = prng.pick(items);
  return build();
}

function mustPick(
  prng: Prng,
  candidates: readonly EntityId[],
  hot: number,
  recent: readonly EntityId[],
): EntityId {
  const id = pickTarget(prng, candidates, hot, recent);
  if (id === undefined) throw new Error("mustPick: candidates must be non-empty");
  return id;
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
