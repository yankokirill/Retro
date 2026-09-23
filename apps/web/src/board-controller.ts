// Контроллер доски: действия пользователя ↔ ядро клиента — docs/design/T-015-board-ui.md § 4.

import type { ActResult, ClientStatus, SyncClient } from "@retro/client-core";
import {
  type Color,
  type Column,
  type EntityId,
  entityKind,
  type Item,
  type Place,
  type State,
  type View,
  values,
  winner,
} from "@retro/crdt";
import type { BoardMeta, Role } from "@retro/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import { fracBetween } from "./frac.js";
import { describeRejection } from "./messages.js";

export interface TrashItem {
  readonly id: EntityId;
  readonly text: string[];
}

export interface Notice {
  readonly id: number;
  readonly text: string;
}

export interface BoardState {
  readonly status: ClientStatus;
  readonly role: Role | null;
  readonly meta: BoardMeta | null;
  readonly view: View;
  readonly trash: TrashItem[];
  readonly pendingCount: number;
  readonly notices: Notice[];
}

export interface BoardController {
  readonly store: StoreApi<BoardState>;
  refresh(): void;
  dismissNotice(id: number): void;
  addSticker(column: Column, text: string, color: Color): ActResult;
  editText(id: EntityId, text: string): ActResult;
  setColor(id: EntityId, color: Color): ActResult;
  moveTo(id: EntityId, column: Column, index: number): ActResult;
  remove(id: EntityId): ActResult;
  restore(id: EntityId): ActResult;
}

const placeOf = (state: State, id: EntityId): Place | undefined =>
  winner(state, { entity: id, field: "place" })?.value as Place | undefined;

export function createBoardController(deps: {
  client: SyncClient;
  send: (lines: readonly string[]) => void;
}): BoardController {
  const { client } = deps;
  let shownRejections = 0;
  let nextNoticeId = 1;

  const initial = client.inspect();
  const store = createStore<BoardState>(() => ({
    status: initial.status,
    role: initial.role,
    meta: initial.meta,
    view: initial.view,
    trash: [],
    pendingCount: 0,
    notices: [],
  }));

  function trashOf(state: State, view: View): TrashItem[] {
    return view.trash.map((id) => {
      const field = entityKind(state, id) === "group" ? "title" : "text";
      const text = values(state, { entity: id, field }).filter(
        (value): value is string => typeof value === "string",
      );
      return { id, text };
    });
  }

  function refresh(): void {
    const snapshot = client.inspect();
    const fresh = snapshot.rejections.slice(shownRejections);
    shownRejections = snapshot.rejections.length;
    const view = snapshot.view;
    store.setState((prev) => ({
      status: snapshot.status,
      role: snapshot.role,
      meta: snapshot.meta,
      view,
      trash: trashOf(snapshot.full, view),
      pendingCount: snapshot.pending.length,
      notices: [
        ...prev.notices,
        ...fresh.map((rejection) => ({
          id: nextNoticeId++,
          text: describeRejection(rejection.reason),
        })),
      ],
    }));
  }

  function run(result: ActResult): ActResult {
    if (result.ok) deps.send(result.send);
    refresh();
    return result;
  }

  const fracOf = (item: Item | undefined): string | null => {
    if (!item) return null;
    return placeOf(client.inspect().full, item.id)?.frac ?? null;
  };

  return {
    store,
    refresh,
    dismissNotice(id) {
      store.setState((prev) => ({ notices: prev.notices.filter((n) => n.id !== id) }));
    },
    addSticker(column, rawText, color) {
      const text = rawText.trim();
      if (text === "") return { ok: false, reason: "invalid_intent" };
      const items = client.inspect().view.columns.get(column) ?? [];
      const frac = fracBetween(fracOf(items[items.length - 1]), null);
      return run(client.act({ type: "createSticker", column, frac, text, color }));
    },
    editText: (id, text) => run(client.act({ type: "editText", id, text })),
    setColor: (id, color) => run(client.act({ type: "setColor", id, color })),
    moveTo(id, column, index) {
      const others = (client.inspect().view.columns.get(column) ?? []).filter(
        (item) => item.id !== id,
      );
      const at = Math.max(0, Math.min(index, others.length));
      const frac = fracBetween(fracOf(others[at - 1]), fracOf(others[at]));
      return run(client.act({ type: "move", id, place: { column, frac } }));
    },
    remove: (id) => run(client.act({ type: "delete", id })),
    restore: (id) => run(client.act({ type: "restore", id })),
  };
}
