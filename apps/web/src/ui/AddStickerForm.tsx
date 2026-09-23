import type { Color } from "@retro/crdt";
import { useState } from "react";
import { COLORS } from "./colors.js";

export function AddStickerForm({ onAdd }: { onAdd: (text: string, color: Color) => void }) {
  const [text, setText] = useState("");
  const [color, setColor] = useState<Color>("yellow");
  const [error, setError] = useState<string | null>(null);

  function submit(): void {
    if (text.trim() === "") {
      setError("Введите текст стикера");
      return;
    }
    setError(null);
    onAdd(text, color);
    setText("");
  }

  return (
    <div className="add-form">
      <textarea
        aria-label="Новый стикер"
        value={text}
        maxLength={2000}
        onChange={(event) => setText(event.target.value)}
      />
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className={`swatch swatch-${c}`}
          aria-label={`Цвет: ${c}`}
          aria-pressed={c === color}
          onClick={() => setColor(c)}
        />
      ))}
      <button type="button" onClick={submit}>
        Добавить
      </button>
      {error !== null && <div role="alert">{error}</div>}
    </div>
  );
}
