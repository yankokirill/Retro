// npm run sim:long — длинный набор (docs/spec/simulator.md § 11.2): все
// профили × --clients 5 и 20 × N seed (по умолчанию 20), --ops=10000. Для
// `check:full` и nightly, не для обычного `check`. Каждый прогон — отдельный
// процесс CLI; код выхода 1, если упал хотя бы один.
//
//   npm run sim:long [-- --seeds=20 --ops=10000 --concurrency=8 --clients=5,20]

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { availableParallelism, freemem } from "node:os";
import { parseArgs } from "node:util";

const PROFILES = ["default", "conflicts", "chaos", "reveal", "votes", "faults"];

const { values } = parseArgs({
  options: {
    seeds: { type: "string", default: "20" },
    ops: { type: "string", default: "10000" },
    clients: { type: "string", default: "5,20" },
    concurrency: { type: "string" },
  },
});

const seeds = Number(values.seeds);
const clientCounts = values.clients.split(",").map(Number);

// Прогон держит в памяти всё состояние доски у каждого клиента: замер 2026-09-21 — около 2,2 ГБ на
// 20 клиентов при 10⁴ оп и до ~0,8 ГБ на 5. Параллелизм «по числу ядер» на 16 ГБ упирался в память
// (система убивала процессы), поэтому по умолчанию считаем от свободной памяти и худшего случая набора.
const GIGABYTE = 1024 ** 3;
const worstClients = Math.max(...clientCounts);
const perRun = (worstClients >= 20 ? 2.6 : worstClients >= 10 ? 1.4 : 0.9) * GIGABYTE;
const byMemory = Math.max(1, Math.floor((freemem() * 0.8) / perRun));
const concurrency = Math.max(
  1,
  values.concurrency === undefined
    ? Math.min(availableParallelism(), byMemory)
    : Number(values.concurrency),
);

const jobs = [];
for (const profile of PROFILES) {
  for (const clients of clientCounts) {
    for (let seed = 1; seed <= seeds; seed++) jobs.push({ profile, clients, seed });
  }
}

function run({ profile, clients, seed }) {
  return new Promise((resolve) => {
    // Имя учитывает профиль и число клиентов: по умолчанию CLI пишет .sim/fail-<seed>.json,
    // и разные прогоны с одним seed затирали бы трассы друг друга.
    const tracePath = `.sim/long-${profile}-${clients}-${seed}.json`;
    const args = [
      "--import",
      "tsx",
      "src/cli.ts",
      `--profile=${profile}`,
      `--clients=${clients}`,
      `--ops=${values.ops}`,
      `--seed=${seed}`,
      "--quiet",
      `--trace=${tracePath}`,
    ];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    // Процесс мог не запуститься (лимит дескрипторов/процессов): это упавший прогон, а не
    // необработанное исключение, которое уронило бы весь sim:long.
    child.on("error", (error) => {
      resolve({ code: 1, output: `не удалось запустить прогон: ${error.message}` });
    });
    child.on("close", (code) => {
      // --trace пишет трассу и при успехе; оставляем только трассы упавших прогонов.
      if (code === 0) rmSync(tracePath, { force: true });
      resolve({ code, output: output.trim() });
    });
  });
}

console.log(
  `sim:long — ${jobs.length} прогонов (${seeds} seed × ${clientCounts.join("/")} клиентов × ${PROFILES.length} профилей), ops=${values.ops}, параллелизм ${concurrency}`,
);

let next = 0;
let failed = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const { code, output } = await run(job);
    if (code === 0) {
      console.log(output.split("\n")[0]);
    } else {
      failed += 1;
      console.error(
        `FAIL (код ${code}) profile=${job.profile} clients=${job.clients} seed=${job.seed}\n${output}`,
      );
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

console.log(
  failed === 0
    ? `sim:long: все ${jobs.length} прогонов зелёные`
    : `sim:long: упало ${failed} из ${jobs.length}`,
);
process.exit(failed === 0 ? 0 : 1);
