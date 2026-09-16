// Досылка и покой — docs/spec/simulator.md § 7, SIM-07.
//
// Процедура: 1) E1/E3/E6/E7/E9 запрещены; 2) все клиенты без соединения
// выполняют E5; 3) все отложенные E4 выполняются; 4) сообщения доставляются
// (E2) в случайном порядке, пока хотя бы один канал не пуст. Решения
// досылки дописываются в `decisions` — трасса полная, replay не использует
// генератор вовсе (§ 9.1).

import type { Event } from "./events.js";
import type { Prng } from "./prng.js";
import type { Violation } from "./violation.js";
import type { World } from "./world.js";

/**
 * `null` — покой достигнут: все каналы пусты, все клиенты `welcomed`, у всех
 * `P(u) = ∅`. Нарушение S9 — либо превышена граница
 * `B = 10 · (сообщений в каналах + Σ|P(u)| + число клиентов) + 100`
 * доставок, либо каналы опустели, а `P(u) ≠ ∅` у кого-то (сразу, без ожидания `B`).
 */
export async function drain(
  world: World,
  prng: Prng,
  decisions: Event[],
): Promise<Violation | null> {
  throw new Error("drain: not implemented");
}
