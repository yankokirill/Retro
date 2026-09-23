import { useState } from "react";

export function AddActionForm({ onAdd }: { onAdd: (text: string) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(): void {
    if (text.trim() === "") {
      setError("Введите текст действия");
      return;
    }
    setError(null);
    onAdd(text);
    setText("");
  }

  return (
    <div className="add-action">
      <textarea
        aria-label="Новое действие"
        value={text}
        maxLength={2000}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="button" onClick={submit}>
        Добавить действие
      </button>
      {error !== null && <div role="alert">{error}</div>}
    </div>
  );
}
