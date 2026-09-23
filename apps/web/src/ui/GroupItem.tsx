// Группа стикеров — docs/design/T-016-groups.md § 3. Название только текстом (XSS).

import type { GroupView } from "@retro/crdt";
import { type ReactNode, useState } from "react";

export interface GroupItemProps {
  readonly group: GroupView;
  readonly readOnly: boolean;
  readonly onRename: (title: string) => void;
  readonly onDelete: () => void;
  readonly children?: ReactNode;
}

export function GroupItem({ group, readOnly, onRename, onDelete, children }: GroupItemProps) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <section className="group" data-group-id={group.id}>
      {group.conflict && <div role="alert">Конфликт названий</div>}
      {group.title.map((variant) => (
        <div key={variant}>
          <h3 data-variant>{variant}</h3>
          {group.conflict && !readOnly && (
            <button type="button" onClick={() => onRename(variant)}>
              Оставить это название
            </button>
          )}
        </div>
      ))}
      {!readOnly && draft === null && (
        <div>
          <button type="button" onClick={() => setDraft(group.title[0] ?? "")}>
            Переименовать
          </button>
          <button type="button" onClick={onDelete}>
            Удалить группу
          </button>
        </div>
      )}
      {!readOnly && draft !== null && (
        <div>
          <input
            aria-label="Название группы"
            value={draft}
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="button"
            onClick={() => {
              onRename(draft);
              setDraft(null);
            }}
          >
            Сохранить
          </button>
          <button type="button" onClick={() => setDraft(null)}>
            Отмена
          </button>
        </div>
      )}
      {children}
    </section>
  );
}
