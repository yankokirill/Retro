import type { WorldHooks } from "./src/hooks.js";
import { buildConfig, runSimulation } from "./src/index.js";

for (const seed of [1, 2, 3, 4]) {
  let received = 0;
  const hooks: WorldHooks = {
    wrapServer: (server) => ({
      open: (c, b) => server.open(c, b),
      close: (c) => server.close(c),
      receive: async (c, raw) => {
        if (raw.includes('"type":"command"')) received++;
        return server.receive(c, raw);
      },
    }),
  };
  const c = buildConfig({ seed, clients: 5, ops: 1500, profile: "reveal" } as never);
  if (!c.ok) throw new Error(c.error);
  const r = await runSimulation(c.config, { hooks });
  const d = r.decisions as any[];
  const cmds = d.filter((e) => e.kind === "command");
  const cuts = d.filter((e) => e.kind === "cut").length;
  console.log(
    `seed ${seed}: decisions ${d.length}, command decisions ${cmds.length} (${cmds.map((e) => e.command.type + ":" + (e.command.phase ?? "")).join(",")}), received by server ${received}, cuts ${cuts}`,
  );
}
