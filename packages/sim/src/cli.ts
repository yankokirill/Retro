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
  DEFAULT_CHECKPOINT_MAX,
  DEFAULT_CHECKPOINT_MIN,
  DEFAULT_CLIENTS,
  DEFAULT_OPS,
  DEFAULT_PROFILE_NAME,
  type ConfigInput,
  type Profile,
} from "./config.js";
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

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    console.error(`sim: ${parsed.error}`);
    return 2;
  }

  const seed = parsed.args.seed ?? randomSeed();
  console.log(seed);

  const configInput: ConfigInput = {
    seed,
    clients: parsed.args.clients,
    ops: parsed.args.ops,
    profile: parsed.args.profile as Profile,
    checkpointMin: parsed.args.checkpointMin,
    checkpointMax: parsed.args.checkpointMax,
  };
  const built = buildConfig(configInput);
  if (!built.ok) {
    console.error(`sim: ${built.error}`);
    return 2;
  }

  const result = await runSimulation(built.config);

  if (result.ok) {
    if (!parsed.args.quiet) {
      console.log(
        JSON.stringify({ ok: true, steps: result.stats.steps, accepted: result.stats.accepted }),
      );
    }
    return 0;
  }

  console.error(
    `SIM FAIL ${result.violation.property} at step ${result.violation.step}: ${result.violation.message}`,
  );
  console.error(
    `repro:    npm run sim -- --profile=${built.config.profile.name} --clients=${built.config.clients} --ops=${built.config.ops} --seed=${seed}`,
  );

  const tracePath = parsed.args.trace ?? `.sim/fail-${seed}.json`;
  const trace = createTrace(
    seed,
    {
      clients: built.config.clients,
      ops: built.config.ops,
      profile: built.config.profile.name,
      checkpointMin: built.config.checkpointMin,
      checkpointMax: built.config.checkpointMax,
    },
    result.decisions,
  );
  await mkdir(dirname(tracePath), { recursive: true });
  await writeFile(tracePath, serializeTrace(trace), "utf8");
  console.error(`trace:    ${tracePath}`);

  return 1;
}

// Точка входа — не выполняется при импорте модуля из тестов.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
