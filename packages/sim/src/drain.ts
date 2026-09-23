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
import type { Streams } from "./prng.js";
import { type Violation, violation } from "./violation.js";
import type { World } from "./world.js";

/**
 * `B = 10 · (c + 1) · (сообщений в каналах + Σ|P(u)| + c) + 100 + всплеск reveal`, `c` — число
 * клиентов (§ 7 спецификации, SIM-07). Экспортирована для теста формулы (drain.test.ts) и для
 * диагностики упавших прогонов — сама не делает I/O, чистая функция мира.
 */
export function drainBudget(world: World): number {
  const inChannels = world.connections.reduce(
    (sum, c) => sum + c.toServer.length + c.toClient.length,
    0,
  );
  const pendingTotal = world.clients.reduce((sum, c) => sum + c.core.inspect().pending.length, 0);
  const clients = world.clients.length;
  // Каждая операция порождает пересылку, ack и рассылку остальным (~c + 1 сообщений): без множителя
  // c + 1 досылка, которая сходится, но не укладывается в B, давала ложный S9 (замер 2026-09-21).
  const base = 10 * (clients + 1) * (inChannels + pendingTotal + clients) + 100;
  // Разовый всплеск reveal (docs/spec/simulator.md § 7): `sendRevealCatchup` при первом уходе из
  // `collect` рассылает КАЖДОМУ подписчику весь журнал (до logSize строк) одним ответом сервера —
  // формула выше видит только статический снимок каналов на входе в drain() и не знает, что уже
  // ОТПРАВЛЕННАЯ, но ещё НЕ ДОСТАВЛЕННАЯ команда setPhase вызовет этот всплеск во время самой
  // досылки. Пока доска не покинула collect, такая команда может лежать где угодно в очереди —
  // добавляем запас на весь журнал × число клиентов. После reveal (фаза ≠ collect) второго такого
  // всплеска быть не может (переход из collect необратим, REQ-004 кр. 2), запас не нужен.
  // Найдено: замер 2026-09-22, seed=11 профиля chaos, 5 клиентов — один deliver увеличил каналы
  // на 2837 при logSize=807 (807·5=4035 ≥ 2837 — с запасом).
  const phase = world.store.boardSync(world.boardId)?.phase ?? "collect";
  const revealBurst = phase === "collect" ? clients * world.store.logSize(world.boardId) : 0;
  return base + revealBurst;
}

export async function drain(
  world: World,
  streams: Streams,
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
      const chosenCandidate = candidates[streams.selection.int(0, candidates.length - 1)];
      if (!chosenCandidate) break;
      const event = resolveCandidate(world, chosenCandidate, streams);
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

  return drainResidue(world, budget);
}

/**
 * Остаток после досылки (SIM-07, S9): каналы пусты и ни у кого нет неотвеченных дельт. Общая для
 * `drain` (тогда известен бюджет `B`) и для воспроизведения трассы, где досылка уже записана
 * решениями и остаётся лишь проверить, чем она кончилась.
 */
export function drainResidue(world: World, budget?: number): Violation | null {
  const channelsNonEmpty = world.connections.some(
    (c) => c.toServer.length > 0 || c.toClient.length > 0,
  );
  if (channelsNonEmpty) {
    return violation(
      "S9",
      world.acts,
      budget === undefined
        ? "досылка не сошлась: каналы не пусты"
        : `досылка не сошлась за B=${budget} доставок`,
    );
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
