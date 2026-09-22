// SIM-07 (docs/spec/simulator.md § 7) — бюджет досылки B учитывает всплеск reveal.
//
// Найдено 2026-09-22 через npm run sim:long (не сконструированный мутант — настоящее падение на
// seed=11 профиля chaos, 5 клиентов, 10⁴ оп): drainBudget считал только статический снимок
// каналов на входе в drain(), но ещё не доставленная команда setPhase (уже принятая в P клиента,
// сидящая в его канале) при доставке вызывает sendRevealCatchup — сервер рассылает КАЖДОМУ
// подписчику весь журнал одним ответом. На реальном прогоне один такой deliver увеличил суммарный
// размер каналов на 2837 при logSize=807, а бюджет (посчитанный по маленькому снимку до всплеска)
// был всего 2500 — S9 «не сошлась за B» на честном, не сконструированном прогоне.
//
// Тест не гоняет полный прогон (дорого — 130+ с): проверяет саму формулу на снимке мира, который
// строится настоящими act/deliver (не переизобретает журнал вручную).

import { describe, expect, it } from "vitest";
import { applyEvent } from "../src/apply.js";
import { buildConfig } from "../src/config.js";
import { drainBudget } from "../src/drain.js";
import { createStreams } from "../src/prng.js";
import { createWorld } from "../src/world.js";

/** Мир с уже подключёнными клиентами и журналом из `rows` настоящих created-стикеров. */
async function worldWithJournal(rows: number) {
  const built = buildConfig({ seed: 1, clients: 3, ops: 10_000, profile: "default" });
  if (!built.ok) throw new Error(built.error);
  const streams = createStreams(built.config.seed);
  const world = createWorld(built.config, streams.world);

  await applyEvent(world, { kind: "connect", client: 0 });
  await applyEvent(world, { kind: "deliver", connection: 0, direction: "toServer" }); // hello
  await applyEvent(world, { kind: "deliver", connection: 0, direction: "toClient" }); // welcome

  for (let i = 0; i < rows; i++) {
    await applyEvent(world, {
      kind: "act",
      client: 0,
      intent: { type: "createSticker", column: "start", frac: "a", text: "x", color: "yellow" },
    });
    await applyEvent(world, { kind: "deliver", connection: 0, direction: "toServer" });
    await applyEvent(world, { kind: "deliver", connection: 0, direction: "toClient" }); // ack
  }
  return world;
}

describe("SIM-07: drainBudget учитывает возможный всплеск reveal-catchup", () => {
  it("SIM-07: в фазе collect бюджет не меньше logSize × clients — на случай ещё не доставленного setPhase", async () => {
    const world = await worldWithJournal(120);
    expect(world.store.boardSync(world.boardId)?.phase).toBe("collect");
    expect(world.store.logSize(world.boardId)).toBe(120);
    const budget = drainBudget(world);
    // Без запаса на всплеск (10 · (c+1) · (0+0+c) + 100 при c=3) бюджет был бы всего 10·4·3+100=220 —
    // заметно меньше 120·3=360, которые реально нужны при доставке скрытого журнала всем подписчикам.
    expect(budget).toBeGreaterThanOrEqual(120 * 3);
  });

  it("SIM-07: после reveal (фаза ≠ collect) второго такого всплеска быть не может — запас не добавляется", async () => {
    const world = await worldWithJournal(120);
    await applyEvent(world, {
      kind: "command",
      client: 0,
      command: { type: "setPhase", phase: "group" },
      commandId: "cmd-1",
    });
    await applyEvent(world, { kind: "deliver", connection: 0, direction: "toServer" }); // setPhase доставлен
    await applyEvent(world, { kind: "deliver", connection: 0, direction: "toClient" }); // commandResult
    expect(world.store.boardSync(world.boardId)?.phase).toBe("group");

    const budgetInGroup = drainBudget(world);
    // Тот же журнал (120 строк), но reveal уже произошёл: базовая формула, без 120·3.
    expect(budgetInGroup).toBeLessThan(120 * 3);
  });

  it("SIM-07: запас на всплеск пропорционален размеру журнала, а не постоянная надбавка", async () => {
    const small = drainBudget(await worldWithJournal(2));
    const large = drainBudget(await worldWithJournal(200));
    // Разница почти целиком — вклад запаса (clients=3): (200-2)·3 = 594, остальное (снимок каналов
    // на входе) отличается не более чем на несколько сообщений между двумя одинаково построенными мирами.
    expect(large - small).toBeGreaterThanOrEqual((200 - 2) * 3 - 20);
    expect(large - small).toBeLessThanOrEqual((200 - 2) * 3 + 20);
  });
});
