// События мира — docs/spec/simulator.md § 4.2 (E1–E9), docs/design/
// T-005-simulator.md § 5.1/§ 6. Событие — сериализуемое решение
// планировщика, ровно то, что записывается в трассу (trace.ts).
//
// Индексы (`client`/`connection`) — позиции в `World.clients`/
// `World.connections`, стабильные в пределах одного прогона (§ 6 проекта).

import type { Intent } from "@retro/client-core";
import type { Command } from "@retro/protocol";
import type { World } from "./world.js";

export type Direction = "toServer" | "toClient";

export type Event =
  | { readonly kind: "act"; readonly client: number; readonly intent: Intent }
  | { readonly kind: "deliver"; readonly connection: number; readonly direction: Direction }
  | { readonly kind: "cut"; readonly connection: number }
  | { readonly kind: "serverNotice"; readonly connection: number }
  | { readonly kind: "connect"; readonly client: number }
  | { readonly kind: "reload"; readonly client: number }
  | { readonly kind: "command"; readonly client: number; readonly command: Command }
  | { readonly kind: "snapshot" }
  | { readonly kind: "storeFault"; readonly afterWrites: number };

export type EventMode = "run" | "drain";

/**
 * Все события, разрешённые сейчас, в фиксированном порядке (§ 6 проекта: по
 * индексу клиента, затем по номеру соединения, затем по направлению).
 * `mode: "drain"` запрещает E1, E3, E6, E7, E9 (§ 7 спецификации, шаг 1
 * процедуры досылки) — `act`/`cut`/`reload`/`command`/`storeFault` не входят
 * в результат. Веса и сам выбор — не здесь (run.ts/drain.ts, через `Prng.pick`).
 */
export function enabledEvents(world: World, mode: EventMode): readonly Event[] {
  throw new Error("enabledEvents: not implemented");
}
