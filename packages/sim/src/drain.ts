// Досылка и покой — docs/spec/simulator.md § 7, SIM-07.
//
// Процедура: 1) E1/E3/E6/E7/E9 запрещены (drain.ts их просто не вызывает);
// 2) все клиенты без соединения выполняют E5; 3) все отложенные E4
// выполняются; 4) сообщения доставляются (E2) в случайном порядке, пока
// хотя бы один канал не пуст. Решения досылки дописываются в `decisions` —
// трасса полная, replay не использует генератор вовсе (§ 9.1).
//
// `step` — колбэк от run.ts (applyEvent + пошаговые проверки, § 5.2/5.5
// проекта): drain.ts не импортирует run.ts напрямую, чтобы не создавать
// цикл (run.ts вызывает drain() на каждой контрольной точке).

import { type Event, enabledEvents, resolveCandidate } from "./events.js";
import type { Prng } from "./prng.js";
import { type Violation, violation } from "./violation.js";
import type { World } from "./world.js";

/** `B = 10 · (сообщений в каналах + Σ|P(u)| + число клиентов) + 100` (§ 7 спецификации). */
function drainBudget(world: World): number {
  const inChannels = world.connections.reduce(
    (sum, c) => sum + c.toServer.length + c.toClient.length,
    0,
  );
  const pendingTotal = world.clients.reduce((sum, c) => sum + c.core.inspect().pending.length, 0);
  return 10 * (inChannels + pendingTotal + world.clients.length) + 100;
}

export async function drain(
  world: World,
  prng: Prng,
  decisions: Event[],
  step: (event: Event) => Promise<Violation | null>,
): Promise<Violation | null> {
  const budget = drainBudget(world);
  let deliveries = 0;

  // Раунд: подключить всех офлайн, снять отложенные E4, доставлять до пустоты.
  // Раундов может быть больше одного: взведённый ранее сбой хранилища (E9) срабатывает
  // на первой же записи уже во время досылки, сервер закрывает соединение, клиент
  // уходит в офлайн — «покой» требует подключить его снова.
  for (;;) {
    let progressed = false;

    // 2. Все клиенты без соединения подключаются.
    for (let i = 0; i < world.clients.length; i++) {
      const client = world.clients[i];
      if (!client || client.connection !== null) continue;
      const event: Event = { kind: "connect", client: i };
      decisions.push(event);
      const result = await step(event);
      if (result) return result;
      progressed = true;
    }

    // 3. Все отложенные E4 (сервер узнаёт о разрыве) выполняются.
    for (let i = 0; i < world.connections.length; i++) {
      const connection = world.connections[i];
      if (!connection || connection.alive || !connection.noticePending) continue;
      const event: Event = { kind: "serverNotice", connection: i };
      decisions.push(event);
      const result = await step(event);
      if (result) return result;
      progressed = true;
    }

    // 4. Доставка (E2) в случайном порядке, пока хотя бы один канал не пуст.
    while (deliveries < budget) {
      const candidates = enabledEvents(world, "drain");
      if (candidates.length === 0) break;
      const chosenCandidate = candidates[prng.int(0, candidates.length - 1)];
      if (!chosenCandidate) break;
      const event = resolveCandidate(world, chosenCandidate, prng);
      if (!event) break; // deliver-кандидаты всегда резолвятся — защитный выход
      decisions.push(event);
      const result = await step(event);
      if (result) return result;
      deliveries += 1;
      progressed = true;
    }

    const stillOffline = world.clients.some((c) => c.connection === null);
    if (!stillOffline || !progressed || deliveries >= budget) break;
  }

  const channelsNonEmpty = world.connections.some(
    (c) => c.toServer.length > 0 || c.toClient.length > 0,
  );
  if (channelsNonEmpty) {
    return violation("S9", world.acts, `досылка не сошлась за B=${budget} доставок`);
  }

  const pendingNonEmpty = world.clients.some((c) => c.core.inspect().pending.length > 0);
  if (pendingNonEmpty) {
    return violation(
      "S9",
      world.acts,
      "каналы опустели, но P(u) ≠ ∅ у кого-то из клиентов — операция без ответа",
    );
  }

  return null;
}
