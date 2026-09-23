import { useState } from "react";

export function AddGroupForm({ onAdd }: { onAdd: (title: string) => void }) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(): void {
    if (title.trim() === "") {
      setError("Введите название группы");
      return;
    }
    setError(null);
    onAdd(title);
    setTitle("");
  }

  return (
    <div className="add-group">
      <input
        aria-label="Новая группа"
        value={title}
        maxLength={200}
        onChange={(event) => setTitle(event.target.value)}
      />
      <button type="button" onClick={submit}>
        Создать группу
      </button>
      {error !== null && <div role="alert">{error}</div>}
    </div>
  );
}
