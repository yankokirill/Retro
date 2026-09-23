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
import type { CardView, Column, Item } from "@retro/crdt";
import type { Role } from "@retro/protocol";
import { useCallback, useEffect, useState } from "react";
import { useStore } from "zustand";
import type { BoardController } from "../board-controller.js";
import { AddStickerForm } from "./AddStickerForm.js";
import { CardItem } from "./CardItem.js";
import { FacilitatorPanel } from "./FacilitatorPanel.js";
import { PhaseBar } from "./PhaseBar.js";
import { TimerPanel } from "./TimerPanel.js";
import { TrashPanel } from "./TrashPanel.js";

const COLUMNS: readonly { id: Column; title: string }[] = [
  { id: "start", title: "Начать" },
  { id: "stop", title: "Прекратить" },
  { id: "continue", title: "Продолжать" },
];

const STATUS_TEXT = { offline: "Нет связи", connecting: "Подключение…", welcomed: "На связи" };

const isCard = (item: Item): item is CardView => !("cards" in item);

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
  const isOwner = state.role === "owner";

  const reloadMembers = useCallback(() => {
    loadMembers?.().then(setMembers, () => setMembers(null));
  }, [loadMembers]);
  useEffect(() => {
    if (isOwner) reloadMembers();
  }, [isOwner, reloadMembers]);
  const readOnly = state.role === "viewer";
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor));

  function onDragEnd(event: DragEndEvent): void {
    const active = String(event.active.id);
    const over = event.over ? String(event.over.id) : null;
    if (over === null || over === active) return;
    const columnIds: readonly string[] = COLUMNS.map((c) => c.id);
    if (columnIds.includes(over)) {
      controller.moveTo(active, over as Column, Number.MAX_SAFE_INTEGER);
      return;
    }
    for (const { id: column } of COLUMNS) {
      const items = state.view.columns.get(column) ?? [];
      const overIndex = items.findIndex((item) => item.id === over);
      if (overIndex === -1) continue;
      const activeIndex = items.findIndex((item) => item.id === active);
      // Без самого active индексы правее него сдвигаются на 1; при движении вниз вставляем после цели.
      const without = activeIndex !== -1 && activeIndex < overIndex ? overIndex - 1 : overIndex;
      const index = activeIndex !== -1 && activeIndex < overIndex ? without + 1 : without;
      controller.moveTo(active, column, index);
      return;
    }
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
                {(state.view.columns.get(id) ?? []).filter(isCard).map((card) => (
                  <DraggableCard key={card.id} id={card.id}>
                    <CardItem
                      card={card}
                      readOnly={readOnly}
                      onEditText={(text) => controller.editText(card.id, text)}
                      onSetColor={(color) => controller.setColor(card.id, color)}
                      onDelete={() => controller.remove(card.id)}
                    />
                  </DraggableCard>
                ))}
              </ColumnDrop>
              {!readOnly && (
                <AddStickerForm onAdd={(text, color) => controller.addSticker(id, text, color)} />
              )}
            </section>
          ))}
        </div>
      </DndContext>
      {isOwner && members !== null && (
        <FacilitatorPanel
          members={members}
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
