// Стикер — docs/design/T-015-board-ui.md § 5. Текст только как текст (XSS), права — подсказка.

import type { CardView, Color } from "@retro/crdt";
import { useState } from "react";
import { COLORS } from "./colors.js";

export interface CardItemProps {
  readonly card: CardView;
  readonly readOnly: boolean;
  readonly onEditText: (text: string) => void;
  readonly onSetColor: (color: Color) => void;
  readonly onDelete: () => void;
}

export function CardItem({ card, readOnly, onEditText, onSetColor, onDelete }: CardItemProps) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <article className="card" data-card-id={card.id} data-color={card.color}>
      {card.conflict && <div role="alert">Конфликт правок: выберите вариант</div>}
      {card.text.map((variant) => (
        <div key={variant}>
          <p data-variant>{variant}</p>
          {card.conflict && !readOnly && (
            <button type="button" onClick={() => onEditText(variant)}>
              Оставить этот вариант
            </button>
          )}
        </div>
      ))}
      {!readOnly && draft === null && (
        <div className="card-actions">
          <button type="button" onClick={() => setDraft(card.text[0] ?? "")}>
            Редактировать
          </button>
          <button type="button" onClick={onDelete}>
            Удалить
          </button>
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`swatch swatch-${color}`}
              aria-label={`Цвет: ${color}`}
              onClick={() => onSetColor(color)}
            />
          ))}
        </div>
      )}
      {!readOnly && draft !== null && (
        <div>
          <textarea
            aria-label="Текст стикера"
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
    </article>
  );
}
