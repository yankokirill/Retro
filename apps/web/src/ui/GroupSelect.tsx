export interface GroupSelectProps {
  readonly groups: readonly { id: string; title: string }[];
  readonly current: string | null;
  readonly onChange: (groupId: string | null) => void;
}

export function GroupSelect({ groups, current, onChange }: GroupSelectProps) {
  return (
    <select
      aria-label="Группа"
      value={current ?? ""}
      onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
    >
      <option value="">Без группы</option>
      {groups.map((group) => (
        <option key={group.id} value={group.id}>
          {group.title}
        </option>
      ))}
    </select>
  );
}
