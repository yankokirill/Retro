// Темп смены фаз — docs/spec/simulator.md § 5.3: профиль `votes` — «фаза `vote` большую часть
// прогона», `reveal` — «долгий `collect`». Мерка — доля принятых сервером сообщений, пришедшихся на
// фазу: без темпа (`phaseShare`) все фазы проскакивали за первые сотни действий, а остаток
// прогона проходил в `actions` — скрытая фаза и голосование проверялись лишь в короткий отрезок.

import { describe, expect, it } from "vitest";
import { buildConfig, type Profile } from "../src/config.js";
import type { WorldHooks } from "../src/hooks.js";
import { runSimulation } from "../src/run.js";

/** Доля сообщений серверу по фазам, суммарно по нескольким seed. */
async function phaseShares(profile: Profile): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const seed of [1, 2, 3, 4]) {
    const hooks: WorldHooks = {
      wrapServer: (server, { store, boardId }) => ({
        open: (connection, board) => server.open(connection, board),
        close: (connection) => server.close(connection),
        receive: async (connection, raw) => {
          const phase = store.boardSync(boardId)?.phase ?? "collect";
          counts[phase] = (counts[phase] ?? 0) + 1;
          total += 1;
          return server.receive(connection, raw);
        },
      }),
    };
    const built = buildConfig({ seed, clients: 4, ops: 800, profile });
    if (!built.ok) throw new Error(built.error);
    const run = await runSimulation(built.config, { hooks });
    expect(run.ok, `${profile}/${seed}`).toBe(true);
  }
  return Object.fromEntries(Object.entries(counts).map(([phase, n]) => [phase, n / total]));
}

describe("§ 5.3: темп смены фаз по профилям", () => {
  it("§ 5.3: профиль votes проводит основную часть прогона в фазе vote", async () => {
    const shares = await phaseShares("votes");
    expect(shares.vote ?? 0, JSON.stringify(shares)).toBeGreaterThan(0.4);
  }, 120_000);

  it("§ 5.3: профиль reveal дольше остальных остаётся в collect, а default не проскакивает фазы", async () => {
    const reveal = await phaseShares("reveal");
    const normal = await phaseShares("default");
    expect(reveal.collect ?? 0, `reveal ${JSON.stringify(reveal)}`).toBeGreaterThan(
      normal.collect ?? 0,
    );
    // default: фазы не проскакивают — голосование и обсуждение получают заметную долю прогона.
    expect(normal.vote ?? 0, `default ${JSON.stringify(normal)}`).toBeGreaterThan(0.1);
    expect(normal.discuss ?? 0, `default ${JSON.stringify(normal)}`).toBeGreaterThan(0.05);
  }, 120_000);
});
