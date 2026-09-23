export interface TrashPanelProps {
  readonly items: readonly { id: string; text: string[] }[];
  readonly readOnly: boolean;
  readonly onRestore: (id: string) => void;
}

export function TrashPanel({ items, readOnly, onRestore }: TrashPanelProps) {
  return (
    <aside aria-label="Корзина" className="trash">
      <h2>Корзина</h2>
      {items.length === 0 ? (
        <p>Корзина пуста</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id} data-card-id={item.id}>
              {item.text.map((variant) => (
                <p key={variant}>{variant}</p>
              ))}
              {!readOnly && (
                <button type="button" onClick={() => onRestore(item.id)}>
                  Восстановить
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
