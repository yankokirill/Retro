// Трасса — docs/spec/simulator.md § 9.1. В T-005 нужна только запись (отчёт
// об упавшем прогоне § 9.3, хэш для SIM-02) и разбор для сравнения; сам
// `--replay`/`--minimize` (SIM-10) — T-027 (docs/tasks.md § 7.1 таблица:
// «T-027 … --replay/--minimize, мутанты M1–M7 … T-005»), поэтому здесь нет
// ни `replayTrace`, ни минимизации.

import type { Profile } from "./config.js";
import type { Event } from "./events.js";
import { TRACE_VERSION } from "./config.js";

export interface TraceConfig {
  readonly clients: number;
  readonly ops: number;
  readonly profile: Profile;
  readonly checkpointMin: number;
  readonly checkpointMax: number;
}

export interface Trace {
  readonly version: number;
  readonly seed: number;
  readonly config: TraceConfig;
  readonly decisions: readonly Event[];
}

export function createTrace(seed: number, config: TraceConfig, decisions: readonly Event[]): Trace {
  return { version: TRACE_VERSION, seed, config, decisions };
}

/**
 * Каноническая сериализация. Ключи объектов внутри `decisions` не
 * сортируются намеренно: порядок полей — часть исходного кода, который
 * строит `Event`/`Intent`, а не данных, и потому уже одинаков в любом
 * процессе, запустившем тот же код (SIM-02 кр. 1 требует побайтового
 * равенства, а не независимости от порядка ключей).
 */
export function serializeTrace(trace: Trace): string {
  return JSON.stringify(trace);
}
