// Доска: три колонки, перетаскивание (dnd-kit), корзина, уведомления об отказах.

import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { CardView, Column, GroupView, Item, View } from "@retro/crdt";
import type { Role } from "@retro/protocol";
import { useCallback, useEffect, useState } from "react";
import { useStore } from "zustand";
import type { BoardController } from "../board-controller.js";
import { ActionItemRow } from "./ActionItemRow.js";
import { AddActionForm } from "./AddActionForm.js";
import { AddGroupForm } from "./AddGroupForm.js";
import { AddStickerForm } from "./AddStickerForm.js";
import { CardItem } from "./CardItem.js";
import { FacilitatorPanel } from "./FacilitatorPanel.js";
import { GroupItem } from "./GroupItem.js";
import { GroupSelect } from "./GroupSelect.js";
import { PhaseBar } from "./PhaseBar.js";
import { TimerPanel } from "./TimerPanel.js";
import { TrashPanel } from "./TrashPanel.js";
import { VoteBudget } from "./VoteBudget.js";
import { VoteControls } from "./VoteControls.js";

const COLUMNS: readonly { id: Column; title: string }[] = [
  { id: "start", title: "Начать" },
  { id: "stop", title: "Прекратить" },
  { id: "continue", title: "Продолжать" },
];

const STATUS_TEXT = { offline: "Нет связи", connecting: "Подключение…", welcomed: "На связи" };

function DraggableCard({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id,
  });
  const { setNodeRef: setDropRef } = useDroppable({ id });
  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        setDropRef(node);
      }}
      className="draggable"
      style={{ opacity: isDragging ? 0.4 : 1 }}
    >
      <span
        ref={setActivatorNodeRef}
        className="handle"
        title="Перетащить"
        {...attributes}
        {...listeners}
      >
        ⠿
      </span>
      {children}
    </div>
  );
}

function ColumnDrop({ id, children }: { id: Column; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className="column-body">
      {children}
    </div>
  );
}

const isGroup = (item: Item): item is GroupView => "cards" in item;

function allGroups(view: View): GroupView[] {
  const result: GroupView[] = [];
  for (const items of view.columns.values())
    for (const item of items) if (isGroup(item)) result.push(item);
  return result;
}

function groupOfCard(view: View, cardId: string): GroupView | undefined {
  return allGroups(view).find((group) => group.cards.some((card) => card.id === cardId));
}

type Members = { guestId: string; displayName: string; role: Role }[];

/** Текущее время раз в секунду — для обратного отсчёта таймера. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, []);
  return now;
}

export function BoardView({
  controller,
  loadMembers,
}: {
  controller: BoardController;
  loadMembers?: () => Promise<Members>;
}) {
  const state = useStore(controller.store);
  const now = useNow();
  const [members, setMembers] = useState<Members | null>(null);
  const readOnly = state.role === "viewer";
  const isOwner = state.role === "owner";
  const phase = state.meta?.phase ?? null;
  const showVotes = phase === "vote" || phase === "discuss" || phase === "actions";
  const canVote = phase === "vote" && !readOnly;

  const reloadMembers = useCallback(() => {
    loadMembers?.().then(setMembers, () => setMembers(null));
  }, [loadMembers]);
  // Список участников (`protocol.md` § 7): owner/facilitator всегда, остальные — после reveal.
  const canListMembers =
    state.role !== null &&
    (state.role === "owner" ||
      state.role === "facilitator" ||
      (phase !== null && phase !== "collect"));
  useEffect(() => {
    if (canListMembers && phase !== null) reloadMembers();
  }, [canListMembers, phase, reloadMembers]);
  const showActions = phase === "discuss" || phase === "actions";
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor));

  const groups = allGroups(state.view);

  function onDragEnd(event: DragEndEvent): void {
    const active = String(event.active.id);
    const over = event.over ? String(event.over.id) : null;
    if (over === null || over === active) return;
    const activeIsGroup = groups.some((g) => g.id === active);
    const activeGroup = groupOfCard(state.view, active);
    const columnIds: readonly string[] = COLUMNS.map((c) => c.id);

    if (columnIds.includes(over)) {
      if (activeGroup) controller.setGroup(active, null);
      controller.moveTo(active, over as Column, Number.MAX_SAFE_INTEGER);
      return;
    }

    // Куда указывает `over`: на группу (сама или её стикер) либо на элемент колонки верхнего уровня.
    const overGroup = groups.find((g) => g.id === over) ?? groupOfCard(state.view, over);
    if (!activeIsGroup && overGroup) {
      if (activeGroup?.id !== overGroup.id) controller.setGroup(active, overGroup.id);
      return;
    }
    const topId = overGroup ? overGroup.id : over;
    for (const { id: column } of COLUMNS) {
      const items = state.view.columns.get(column) ?? [];
      const overIndex = items.findIndex((item) => item.id === topId);
      if (overIndex === -1) continue;
      // `moveTo` считает индекс без самого active: вниз (active левее цели) — «после цели»,
      // вверх — «перед целью»; в обоих случаях это индекс цели в исходном списке.
      if (activeGroup) controller.setGroup(active, null);
      controller.moveTo(active, column, overIndex);
      return;
    }
  }

  const groupChoices = groups.map((g) => ({ id: g.id, title: g.title.join(" / ") }));

  function renderCard(card: CardView, groupId: string | null) {
    return (
      <DraggableCard key={card.id} id={card.id}>
        <CardItem
          card={card}
          readOnly={readOnly}
          onEditText={(text) => controller.editText(card.id, text)}
          onSetColor={(color) => controller.setColor(card.id, color)}
          onDelete={() => controller.remove(card.id)}
        />
        {!readOnly && (
          <GroupSelect
            groups={groupChoices}
            current={groupId}
            onChange={(next) => controller.setGroup(card.id, next)}
          />
        )}
        {showVotes && (
          <VoteControls
            total={card.votes}
            mine={state.myVotes[card.id] ?? 0}
            remaining={state.votesLeft ?? 0}
            interactive={canVote}
            onVote={() => controller.vote(card.id)}
            onUnvote={() => controller.unvote(card.id)}
          />
        )}
      </DraggableCard>
    );
  }

  return (
    <div className="board">
      <header>
        <h1>{state.meta?.title ?? "Доска"}</h1>
        <span className="status" data-status={state.status}>
          {STATUS_TEXT[state.status]}
          {state.pendingCount > 0 ? ` · не отправлено: ${state.pendingCount}` : ""}
        </span>
      </header>
      {state.meta && (
        <>
          <PhaseBar
            phase={state.meta.phase}
            role={state.role}
            onSetPhase={(phase) => controller.setPhase(phase)}
          />
          <TimerPanel
            phase={state.meta.phase}
            timer={state.meta.timer}
            role={state.role}
            now={now}
            onStart={(seconds) => controller.startTimer(seconds)}
            onStop={() => controller.stopTimer()}
          />
        </>
      )}
      {canVote && state.votesLeft !== null && state.voteLimit !== null && (
        <VoteBudget remaining={state.votesLeft} limit={state.voteLimit} />
      )}
      <div className="notices">
        {state.notices.map((notice) => (
          <div key={notice.id} role="status" className="notice">
            {notice.text}
            <button
              type="button"
              aria-label="Скрыть"
              onClick={() => controller.dismissNotice(notice.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="columns">
          {COLUMNS.map(({ id, title }) => (
            <section key={id} className="column" aria-label={title}>
              <h2>{title}</h2>
              <ColumnDrop id={id}>
                {(state.view.columns.get(id) ?? []).map((item) =>
                  isGroup(item) ? (
                    <DraggableCard key={item.id} id={item.id}>
                      <GroupItem
                        group={item}
                        readOnly={readOnly}
                        onRename={(title) => controller.renameGroup(item.id, title)}
                        onDelete={() => controller.remove(item.id)}
                      >
                        {item.cards.map((card) => renderCard(card, item.id))}
                        {showVotes && (
                          <VoteControls
                            total={item.votes}
                            mine={state.myVotes[item.id] ?? 0}
                            remaining={state.votesLeft ?? 0}
                            interactive={canVote}
                            onVote={() => controller.vote(item.id)}
                            onUnvote={() => controller.unvote(item.id)}
                          />
                        )}
                      </GroupItem>
                    </DraggableCard>
                  ) : (
                    renderCard(item, null)
                  ),
                )}
              </ColumnDrop>
              {!readOnly && (
                <>
                  <AddStickerForm onAdd={(text, color) => controller.addSticker(id, text, color)} />
                  <AddGroupForm onAdd={(title) => controller.createGroup(id, title)} />
                </>
              )}
            </section>
          ))}
        </div>
      </DndContext>
      {showActions && (
        <section aria-label="Действия" className="actions">
          <h2>Действия</h2>
          <ul>
            {state.view.actions.map((action) => (
              <ActionItemRow
                key={action.id}
                action={action}
                members={members ?? []}
                readOnly={readOnly}
                onEditText={(text) => controller.editAction(action.id, text)}
                onAssign={(guestId) => controller.assign(action.id, guestId)}
                onSetDone={(done) => controller.setDone(action.id, done)}
                onDelete={() => controller.remove(action.id)}
              />
            ))}
          </ul>
          {!readOnly && <AddActionForm onAdd={(text) => controller.createAction(text)} />}
        </section>
      )}
      {isOwner && members !== null && (
        <FacilitatorPanel
          members={members}
          onRefresh={reloadMembers}
          onGrant={(guestId) => {
            controller.grantFacilitator(guestId);
            // Ответ сервера owner'у не несёт новой роли цели — перечитываем список чуть позже.
            setTimeout(reloadMembers, 500);
          }}
        />
      )}
      <TrashPanel
        items={state.trash}
        readOnly={readOnly}
        onRestore={(id) => controller.restore(id)}
      />
    </div>
  );
}
