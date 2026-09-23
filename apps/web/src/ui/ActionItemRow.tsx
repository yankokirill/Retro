// Action item — docs/design/T-019-action-items.md § 3. Тексты и имена — только текстом (XSS).

import type { ActionView } from "@retro/crdt";
import { useState } from "react";

export interface ActionItemRowProps {
  readonly action: ActionView;
  readonly members: readonly { guestId: string; displayName: string }[];
  readonly readOnly: boolean;
  readonly onEditText: (text: string) => void;
  readonly onAssign: (guestId: string | null) => void;
  readonly onSetDone: (done: boolean) => void;
  readonly onDelete: () => void;
}

export function ActionItemRow({
  action,
  members,
  readOnly,
  onEditText,
  onAssign,
  onSetDone,
  onDelete,
}: ActionItemRowProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const assignee = members.find((member) => member.guestId === action.assignee);

  return (
    <li data-action-id={action.id}>
      {action.conflict && <div role="alert">Конфликт правок</div>}
      {action.text.map((variant) => (
        <div key={variant}>
          <p data-variant>{variant}</p>
          {action.conflict && !readOnly && (
            <button type="button" onClick={() => onEditText(variant)}>
              Оставить этот вариант
            </button>
          )}
        </div>
      ))}
      <input
        type="checkbox"
        aria-label="Выполнено"
        checked={action.done}
        disabled={readOnly}
        onChange={(event) => onSetDone(event.target.checked)}
      />
      {readOnly ? (
        <span>
          Ответственный:{" "}
          {action.assignee === null
            ? "не назначен"
            : (assignee?.displayName ?? "неизвестный участник")}
        </span>
      ) : (
        <select
          aria-label="Ответственный"
          value={action.assignee ?? ""}
          onChange={(event) => onAssign(event.target.value === "" ? null : event.target.value)}
        >
          <option value="">Не назначен</option>
          {members.map((member) => (
            <option key={member.guestId} value={member.guestId}>
              {member.displayName}
            </option>
          ))}
        </select>
      )}
      {!readOnly && draft === null && (
        <>
          <button type="button" onClick={() => setDraft(action.text[0] ?? "")}>
            Редактировать
          </button>
          <button type="button" onClick={onDelete}>
            Удалить
          </button>
        </>
      )}
      {!readOnly && draft !== null && (
        <div>
          <textarea
            aria-label="Текст действия"
            value={draft}
            maxLength={2000}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="button"
            onClick={() => {
              onEditText(draft);
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
    </li>
  );
}
