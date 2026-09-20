#!/usr/bin/env node
// CLI симулятора — docs/spec/simulator.md § 11.1. Единственное место во всех
// чистых пакетах (`sim`/`server-core`/`client-core`/`crdt`), где разрешены
// `node:*`, часы и запись файлов (правило 7 CLAUDE.md, ADR-0009, SIM-02 кр. 2).
//
// В T-005 — только режим прогона (`run`). `--replay`/`--minimize` (SIM-10) —
// T-027 (docs/tasks.md § 7.1); здесь эти флаги ещё не разбираются.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  buildConfig,
  type ConfigInput,
  DEFAULT_CHECKPOINT_MAX,
  DEFAULT_CHECKPOINT_MIN,
  DEFAULT_CLIENTS,
  DEFAULT_OPS,
  DEFAULT_PROFILE_NAME,
  type Profile,
} from "./config.js";
import type { Event } from "./events.js";
import { runSimulation } from "./run.js";
import { createTrace, serializeTrace } from "./trace.js";

export interface ParsedArgs {
  readonly seed: number | undefined;
  readonly clients: number;
  readonly ops: number;
  readonly profile: string;
  readonly checkpointMin: number;
  readonly checkpointMax: number;
  readonly trace: string | undefined;
  readonly quiet: boolean;
}

export type ParseResult =
  | { readonly ok: true; readonly args: ParsedArgs }
  | { readonly ok: false; readonly error: string };

const CLI_OPTIONS = {
  seed: { type: "string" },
  clients: { type: "string" },
  ops: { type: "string" },
  profile: { type: "string" },
  "checkpoint-min": { type: "string" },
  "checkpoint-max": { type: "string" },
  trace: { type: "string" },
  quiet: { type: "boolean" },
} as const;

/** Разбор `argv` без побочных эффектов — сама случайность (seed по умолчанию) остаётся снаружи, в `main`. */
export function parseCliArgs(argv: readonly string[]): ParseResult {
  let values: ReturnType<
    typeof parseArgs<{ args: string[]; options: typeof CLI_OPTIONS }>
  >["values"];
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const toInt = (raw: string | undefined, fallback: number): number =>
    raw === undefined ? fallback : Number.parseInt(raw, 10);

  return {
    ok: true,
    args: {
      seed: values.seed === undefined ? undefined : Number.parseInt(values.seed, 10),
      clients: toInt(values.clients, DEFAULT_CLIENTS),
      ops: toInt(values.ops, DEFAULT_OPS),
      profile: values.profile ?? DEFAULT_PROFILE_NAME,
      checkpointMin: toInt(values["checkpoint-min"], DEFAULT_CHECKPOINT_MIN),
      checkpointMax: toInt(values["checkpoint-max"], DEFAULT_CHECKPOINT_MAX),
      trace: values.trace,
      quiet: values.quiet ?? false,
    },
  };
}

function randomSeed(): number {
  // Единственное законное место для настоящей случайности во всём пакете:
  // выбор seed ПРОГОНА, когда пользователь его не передал — сам прогон
  // дальше полностью детерминирован этим seed (SIM-02). Печатается первой
  // строкой (§ 11.1), чтобы прогон был воспроизводим.
  return Math.floor(Math.random() * 0x1_00_00_00_00);
}

function formatBytes(stats: { toServer: number; toClient: number }): string {
  return `toServer=${stats.toServer} toClient=${stats.toClient}`;
}

function formatCounts(counts: Partial<Record<string, number>>): string {
  const entries = Object.entries(counts).filter(([, n]) => n);
  return entries.length === 0 ? "—" : entries.map(([key, n]) => `${key}=${n}`).join(" ");
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function describeEvent(event: Event): string {
  const parts: string[] = [event.kind];
  if ("client" in event) parts.push(`client=${event.client}`);
  if ("connection" in event) parts.push(`conn=${event.connection}`);
  if ("direction" in event) parts.push(event.direction);
  return parts.join(":");
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    console.error(`sim: ${parsed.error}`);
    return 2;
  }
  const { quiet } = parsed.args;

  const seed = parsed.args.seed ?? randomSeed();
  // § 11.1: seed печатается первой строкой; при --quiet он входит в итоговую строку.
  if (!quiet) console.log(seed);

  const built = buildConfig({
    seed,
    clients: parsed.args.clients,
    ops: parsed.args.ops,
    profile: parsed.args.profile as Profile,
    checkpointMin: parsed.args.checkpointMin,
    checkpointMax: parsed.args.checkpointMax,
  });
  if (!built.ok) {
    console.error(`sim: ${built.error}`);
    return 2;
  }
  const { config } = built;
  const label = `seed=${seed} profile=${config.profile.name} clients=${config.clients} ops=${config.ops}`;

  const started = Date.now();
  let result: Awaited<ReturnType<typeof runSimulation>>;
  try {
    result = await runSimulation(config);
  } catch (err) {
    // Исключение из самого симулятора или ядер — не нарушение свойства (§ 11.1, код 2).
    console.error(
      `sim: внутренняя ошибка (${label}): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    return 2;
  }
  const elapsed = formatSeconds(Date.now() - started);
  const { stats } = result;

  const trace = createTrace(
    seed,
    {
      clients: config.clients,
      ops: config.ops,
      profile: config.profile.name,
      checkpointMin: config.checkpointMin,
      checkpointMax: config.checkpointMax,
    },
    result.decisions,
  );
  const writeTrace = async (path: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serializeTrace(trace), "utf8");
  };

  if (result.ok) {
    console.log(`OK ${label} steps=${stats.steps} time=${elapsed}`);
    if (!quiet) {
      console.log(`  E1 по намерениям: ${formatCounts(stats.actsByIntent)}`);
      console.log(
        `  принято операций: ${stats.accepted}; отказы по причинам: ${formatCounts(stats.rejectedByReason)}`,
      );
      console.log(
        `  разрывы: ${stats.cuts}; перезагрузки: ${stats.reloads}; дубли ack: ${stats.duplicateAcks}; контрольные точки: ${stats.checkpoints}`,
      );
      console.log(
        `  max |P|: ${stats.maxPending}; max сообщение (байт): ${formatBytes(stats.maxMessageBytes)}`,
      );
    }
    if (parsed.args.trace !== undefined) {
      await writeTrace(parsed.args.trace);
      console.log(`trace: ${parsed.args.trace}`);
    }
    return 0;
  }

  const { violation } = result;
  const tracePath = parsed.args.trace ?? `.sim/fail-${seed}.json`;
  console.error(
    `SIM FAIL ${violation.property} at step ${violation.step}, checkpoint ${stats.checkpoints}`,
  );
  console.error(`  ${label}`);
  console.error(`  ${violation.message}`);
  if (violation.detail !== undefined)
    console.error(`  detail: ${JSON.stringify(violation.detail)}`);
  console.error(`  last events: ${result.decisions.slice(-8).map(describeEvent).join(" ")}`);
  console.error(
    `  repro:    npm run sim -- --profile=${config.profile.name} --clients=${config.clients} --ops=${config.ops} --seed=${seed}`,
  );
  await writeTrace(tracePath);
  console.error(`  trace:    ${tracePath}`);
  return 1;
}

// Точка входа — не выполняется при импорте модуля из тестов.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
