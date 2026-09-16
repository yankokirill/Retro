// Генератор намерений — docs/spec/simulator.md § 5.1/5.2, docs/design/
// T-005-simulator.md § 5.6. Ведёт себя как честный интерфейс: действует
// только на видимые клиенту сущности, предлагает только разрешённые
// матрицей `docs/security/permissions.md` действия для роли и фазы,
// которую клиент знает из своего последнего `meta`/`welcome` (SIM-06).
//
// Дельту сам не строит — намерение передаётся в `SyncClient.act` (ядро
// клиента строит дельту); генератор не может подделать операцию (SIM-06 кр. 1).

import type { Intent } from "@retro/client-core";
import type { Prng } from "./prng.js";
import type { World } from "./world.js";

/**
 * `null` — этому клиенту сейчас нечего предложить (`viewer`, пустой экран,
 * нет подходящей цели ни у одного разрешённого вида намерения). Такой шаг
 * не расходует бюджет `--ops` (E1 не происходит) — вызывающий (apply.ts)
 * выбирает другое событие.
 */
export function generateIntent(world: World, clientIndex: number, prng: Prng): Intent | null {
  throw new Error("generateIntent: not implemented");
}
