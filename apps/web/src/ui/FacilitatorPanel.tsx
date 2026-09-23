// Участники и назначение фасилитатора — REQ-003 кр. 2 (видно только owner, см. BoardView).

import type { Role } from "@retro/protocol";

const ROLE_NAMES: Record<Role, string> = {
  owner: "Владелец",
  facilitator: "Фасилитатор",
  participant: "Участник",
  viewer: "Наблюдатель",
};

export interface FacilitatorPanelProps {
  readonly members: readonly { guestId: string; displayName: string; role: Role }[];
  readonly onGrant: (guestId: string) => void;
}

export function FacilitatorPanel({ members, onGrant }: FacilitatorPanelProps) {
  return (
    <section aria-label="Участники" className="members">
      <h2>Участники</h2>
      <ul>
        {members.map((member) => (
          <li key={member.guestId}>
            <span>{member.displayName}</span> <span>{ROLE_NAMES[member.role]}</span>
            {(member.role === "participant" || member.role === "viewer") && (
              <button
                type="button"
                aria-label={`Назначить фасилитатором: ${member.displayName}`}
                onClick={() => onGrant(member.guestId)}
              >
                Назначить фасилитатором
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
