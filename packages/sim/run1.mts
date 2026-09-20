import { buildConfig, runSimulation } from "./src/index.js";
const [profile, seed, clients, ops] = process.argv.slice(2);
const c = buildConfig({ seed: Number(seed), clients: Number(clients), ops: Number(ops), profile } as never);
if (!("config" in c)) { console.log("BADCONFIG", profile, seed, JSON.stringify(c)); process.exit(1); }
const t = Date.now();
const r = await runSimulation(c.config as never);
const ms = Date.now() - t;
console.log(r.ok ? "OK  " : "FAIL", profile, "seed=" + seed, "clients=" + clients, "steps=" + (r.stats as any).steps, ms + "ms", r.ok ? "" : JSON.stringify((r as any).violation));
