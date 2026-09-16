// Применение одного события — единственное место, где мир меняется
// (docs/design/T-005-simulator.md § 5.2/5.3). `applyEvent` сам не решает,
// нарушено ли какое-то свойство — только сообщает, что произошло; проверки
// (checks.ts) вызывает run.ts/drain.ts на основе этого наблюдения (см.
// комментарий в run.ts к `step`).

import type { OpRow } from "@retro/server-core";
import type {
  AckObservation,
  ErrorObservation,
  OutgoingObservation,
  RejectObservation,
} from "./checks.js";
import type { Direction, Event } from "./events.js";
import type { Prng } from "./prng.js";
import type { World } from "./world.js";

export interface StepObservation {
  /** Новые строки журнала, появившиеся за это событие (обычно 0 или 1 — только `deliver toServer`, принявший операцию). */
  readonly newLogRows: readonly OpRow[];
  readonly acks: readonly AckObservation[];
  readonly rejects: readonly (RejectObservation | ErrorObservation)[];
  /** Сообщения «сервер → клиент», ушедшие в каналы за это событие — для S10, с фазой на момент отправки. */
  readonly outgoing: readonly OutgoingObservation[];
  /** Каждая строка, реально пересланная по сети за это событие — для S11 (обе стороны). */
  readonly sentRaw: readonly { readonly direction: Direction; readonly raw: string }[];
}

export async function applyEvent(world: World, event: Event, prng: Prng): Promise<StepObservation> {
  throw new Error("applyEvent: not implemented");
}
