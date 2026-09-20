#!/usr/bin/env node
// CLI симулятора — docs/spec/simulator.md § 11.1. Единственное место во всех
// чистых пакетах (`sim`/`server-core`/`client-core`/`crdt`), где разрешены
// `node:*`, часы и запись файлов (правило 7 CLAUDE.md, ADR-0009, SIM-02 кр. 2).
//
// В T-005 — только режим прогона (`run`). `--replay`/`--minimize` (SIM-10) —
// T-027 (docs/tasks.md § 7.1); здесь эти флаги ещё не разбираются.

import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
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
import { replayTrace } from "./replay.js";
import { runSimulation } from "./run.js";
import { createTrace, parseTrace, serializeTrace, TraceError } from "./trace.js";
import type { Violation } from "./violation.js";

export interface ParsedArgs {
  readonly seed: number | undefined;
  readonly clients: number;
  readonly ops: number;
  readonly profile: string;
  readonly checkpointMin: number;
  readonly checkpointMax: number;
  readonly trace: string | undefined;
  readonly quiet: boolean;
  /** Путь к трассе для `--replay`; в этом режиме флаги прогона не принимаются. */
  readonly replay: string | undefined;
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
  replay: { type: "string" },
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

  // Строго: `Number.parseInt("12abc")` = 12, а `--ops=1e4` = 1 — опечатка в seed давала бы
  // другой, но «валидный» прогон без единого сообщения.
  if (values.replay !== undefined) {
    const runFlags = [
      "seed",
      "clients",
      "ops",
      "profile",
      "checkpoint-min",
      "checkpoint-max",
    ] as const;
    const given = runFlags.filter((flag) => values[flag] !== undefined);
    if (given.length > 0) {
      return {
        ok: false,
        error: `--replay берёт конфигурацию из трассы; флаги ${given.map((flag) => `--${flag}`).join(", ")} с ним не сочетаются`,
      };
    }
  }

  const invalid: string[] = [];
  const toInt = (flag: string, raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) {
      invalid.push(`--${flag} must be a non-negative integer, got ${JSON.stringify(raw)}`);
      return fallback;
    }
    return Number(raw);
  };
  const seed = values.seed === undefined ? undefined : toInt("seed", values.seed, 0);
  const clients = toInt("clients", values.clients, DEFAULT_CLIENTS);
  const ops = toInt("ops", values.ops, DEFAULT_OPS);
  const checkpointMin = toInt("checkpoint-min", values["checkpoint-min"], DEFAULT_CHECKPOINT_MIN);
  const checkpointMax = toInt("checkpoint-max", values["checkpoint-max"], DEFAULT_CHECKPOINT_MAX);
  if (invalid.length > 0) return { ok: false, error: invalid.join("; ") };

  return {
    ok: true,
    args: {
      seed,
      clients,
      ops,
      profile: values.profile ?? DEFAULT_PROFILE_NAME,
      checkpointMin,
      checkpointMax,
      trace: values.trace,
      quiet: values.quiet ?? false,
      replay: values.replay,
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

/** Строки отчёта о нарушении (§ 9.3): свойство, шаг, контрольная точка, конфигурация, сообщение, последние события. */
function printViolation(
  violation: Violation,
  checkpoints: number,
  label: string,
  decisions: readonly Event[],
): void {
  console.error(
    `SIM FAIL ${violation.property} at step ${violation.step}, checkpoint ${checkpoints}`,
  );
  console.error(`  ${label}`);
  console.error(`  ${violation.message}`);
  if (violation.detail !== undefined)
    console.error(`  detail: ${JSON.stringify(violation.detail)}`);
  console.error(`  last events: ${decisions.slice(-8).map(describeEvent).join(" ")}`);
}

/** `--replay=<trace.json>`: выполняет решения трассы без генератора (§ 9.2, SIM-10 кр. 1). */
async function replayMain(path: string, quiet: boolean): Promise<number> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    console.error(
      `sim: не удалось прочитать трассу ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  let trace: ReturnType<typeof parseTrace>;
  try {
    trace = parseTrace(text);
  } catch (error) {
    if (error instanceof TraceError) {
      console.error(`sim: ${error.message}`);
      return 2;
    }
    throw error;
  }

  const label = `seed=${trace.seed} profile=${trace.config.profile} clients=${trace.config.clients} ops=${trace.config.ops}`;
  const started = Date.now();
  let result: Awaited<ReturnType<typeof replayTrace>>;
  try {
    result = await replayTrace(trace);
  } catch (error) {
    if (error instanceof TraceError) {
      console.error(`sim: ${error.message}`);
      return 2;
    }
    console.error(
      `sim: внутренняя ошибка при воспроизведении (${label}): ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return 2;
  }
  const elapsed = formatSeconds(Date.now() - started);
  const counts = `решений=${trace.decisions.length} выполнено=${result.applied} пропущено=${result.skipped}`;

  if (result.violation) {
    printViolation(
      result.violation,
      result.stats.checkpoints,
      `${label} (replay ${path}; ${counts})`,
      trace.decisions,
    );
    return 1;
  }
  console.log(`REPLAY OK ${label} ${counts} time=${elapsed}`);
  if (!quiet && result.skipped > 0) {
    console.log(`  пропущено решений, неприменимых в этом мире: ${result.skipped} (§ 9.2)`);
  }
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    console.error(`sim: ${parsed.error}`);
    return 2;
  }
  const { quiet } = parsed.args;
  if (parsed.args.replay !== undefined) return replayMain(parsed.args.replay, quiet);

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
  printViolation(violation, stats.checkpoints, label, result.decisions);
  console.error(
    `  repro:    npm run sim -- --profile=${config.profile.name} --clients=${config.clients} --ops=${config.ops} --seed=${seed}`,
  );
  await writeTrace(tracePath);
  console.error(`  trace:    ${tracePath}`);
  return 1;
}

// Точка входа — не выполняется при импорте модуля из тестов. Сравнение идёт по реальному
// пути (`realpath`) и через `pathToFileURL`: `bin` запускается через симлинк в
// node_modules/.bin, а путь с пробелом или не-ASCII в `import.meta.url` закодирован.
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
