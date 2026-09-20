import { buildConfig, runSimulation } from "./src/index.js";
const ops = Number(process.argv[2] ?? 300);
const c = buildConfig({ seed: 1, clients: 5, ops, profile: "default" } as never);
if (!("config" in c)) { console.log(c); process.exit(1); }
const t = Date.now();
const r = await runSimulation(c.config as never);
console.log(ops, r.ok, r.stats && (r.stats as any).steps, Date.now() - t, "ms");
