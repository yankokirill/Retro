// Таймер обсуждения — REQ-019 кр. 2: только показ, фазу сам не меняет.

import type { Phase, Role } from "@retro/protocol";
import { useState } from "react";

export interface TimerPanelProps {
  readonly phase: Phase;
  readonly timer: { readonly endsAt: string } | null;
  readonly role: Role | null;
  /** Миллисекунды эпохи. */
  readonly now: number;
  readonly onStart: (seconds: number) => void;
  readonly onStop: () => void;
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function TimerPanel({ phase, timer, role, now, onStart, onStop }: TimerPanelProps) {
  const [minutes, setMinutes] = useState("5");
  if (phase !== "discuss") return null;
  const canControl = role === "owner" || role === "facilitator";
  const remaining = timer === null ? null : Date.parse(timer.endsAt) - now;
  const minutesValue = Number(minutes);
  const valid = Number.isInteger(minutesValue) && minutesValue >= 1 && minutesValue <= 60;

  return (
    <section className="timer" aria-label="Таймер обсуждения">
      {timer === null && <p>Таймер не запущен</p>}
      {remaining !== null && remaining > 0 && <p role="timer">{formatRemaining(remaining)}</p>}
      {remaining !== null && remaining <= 0 && <p role="status">Время вышло</p>}
      {canControl && (
        <div>
          <input
            type="number"
            aria-label="Минуты"
            min={1}
            max={60}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
          <button type="button" disabled={!valid} onClick={() => onStart(minutesValue * 60)}>
            Запустить таймер
          </button>
          {timer !== null && (
            <button type="button" onClick={onStop}>
              Остановить таймер
            </button>
          )}
        </div>
      )}
    </section>
  );
}
