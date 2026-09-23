// Фазы ретро — docs/design/T-018-phases-ui.md § 4, REQ-004. Права — подсказка, решает сервер.

import type { Phase, Role } from "@retro/protocol";
import { useState } from "react";

export const PHASE_NAMES: Record<Phase, string> = {
  collect: "Сбор",
  group: "Группировка",
  vote: "Голосование",
  discuss: "Обсуждение",
  actions: "Действия",
};
const PHASES = Object.keys(PHASE_NAMES) as Phase[];

export interface PhaseBarProps {
  readonly phase: Phase;
  readonly role: Role | null;
  readonly onSetPhase: (phase: Phase) => void;
}

export function PhaseBar({ phase, role, onSetPhase }: PhaseBarProps) {
  const [pending, setPending] = useState<Phase | null>(null);
  const canSwitch = role === "owner" || role === "facilitator";

  function choose(target: Phase): void {
    if (phase === "collect") setPending(target);
    else onSetPhase(target);
  }

  return (
    <nav className="phases">
      <p role="status">{PHASE_NAMES[phase]}</p>
      {canSwitch &&
        PHASES.map((target) => (
          <button
            key={target}
            type="button"
            aria-current={target === phase ? "step" : undefined}
            disabled={target === phase || (target === "collect" && phase !== "collect")}
            onClick={() => choose(target)}
          >
            {PHASE_NAMES[target]}
          </button>
        ))}
      {pending !== null && (
        <div role="alertdialog" aria-label="Подтверждение">
          <p>Раскрыть стикеры и их авторов? Это необратимо</p>
          <button
            type="button"
            onClick={() => {
              onSetPhase(pending);
              setPending(null);
            }}
          >
            Подтвердить
          </button>
          <button type="button" onClick={() => setPending(null)}>
            Отмена
          </button>
        </div>
      )}
    </nav>
  );
}
