// Трасса — docs/spec/simulator.md § 9.1. В T-005 нужна только запись (отчёт
// об упавшем прогоне § 9.3, хэш для SIM-02) и разбор для сравнения; сам
// `--replay`/`--minimize` (SIM-10) — T-027 (docs/tasks.md § 7.1 таблица:
// «T-027 … --replay/--minimize, мутанты M1–M7 … T-005»), поэтому здесь нет
// ни `replayTrace`, ни минимизации.

import type { Profile } from "./config.js";
import { SCHEDULER_VERSION, TRACE_VERSION } from "./config.js";
import type { Event } from "./events.js";

export interface TraceConfig {
  readonly clients: number;
  readonly ops: number;
  readonly profile: Profile;
  readonly checkpointMin: number;
  readonly checkpointMax: number;
}

export interface Trace {
  /** Формат решений (`TRACE_VERSION`). */
  readonly version: number;
  /** Алгоритм чисел и порядок событий (`SCHEDULER_VERSION`) — для `--replay` не важен. */
  readonly schedulerVersion: number;
  readonly seed: number;
  readonly config: TraceConfig;
  readonly decisions: readonly Event[];
}

export function createTrace(seed: number, config: TraceConfig, decisions: readonly Event[]): Trace {
  return { version: TRACE_VERSION, schedulerVersion: SCHEDULER_VERSION, seed, config, decisions };
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

/** Ошибка разбора или несовместимости трассы — CLI отвечает на неё кодом 2, а не «нарушением». */
export class TraceError extends Error {}

const EVENT_KINDS = new Set([
  "act",
  "deliver",
  "cut",
  "serverNotice",
  "connect",
  "reload",
  "command",
  "snapshot",
  "storeFault",
  "checkpoint",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

/**
 * Разбор текста трассы с проверкой формы (§ 9.1) — не содержимого намерений: их проверяет ядро
 * клиента при воспроизведении. Версия формата (`version`) должна совпасть с `TRACE_VERSION`;
 * `schedulerVersion` не сверяется — `--replay` генератор не вызывает (ВС-9).
 */
export function parseTrace(text: string): Trace {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TraceError("трасса не является валидным JSON");
  }
  if (!isRecord(raw)) throw new TraceError("трасса должна быть JSON-объектом");
  if (raw.version !== TRACE_VERSION) {
    throw new TraceError(
      `несовместимая версия формата трассы: ${String(raw.version)} (ожидается ${TRACE_VERSION}); такие трассы отвергаются, а не воспроизводятся иначе`,
    );
  }
  if (!isInt(raw.schedulerVersion)) throw new TraceError("нет schedulerVersion");
  if (!isInt(raw.seed) || raw.seed < 0 || raw.seed > 0xff_ff_ff_ff) {
    throw new TraceError("seed должен быть целым в [0, 2^32-1]");
  }
  const config = raw.config;
  if (
    !isRecord(config) ||
    !isInt(config.clients) ||
    !isInt(config.ops) ||
    typeof config.profile !== "string" ||
    !isInt(config.checkpointMin) ||
    !isInt(config.checkpointMax)
  ) {
    throw new TraceError(
      "config трассы неполон (clients, ops, profile, checkpointMin, checkpointMax)",
    );
  }
  if (!Array.isArray(raw.decisions)) throw new TraceError("decisions должен быть массивом");
  raw.decisions.forEach((decision, index) => {
    if (
      !isRecord(decision) ||
      typeof decision.kind !== "string" ||
      !EVENT_KINDS.has(decision.kind)
    ) {
      throw new TraceError(`решение #${index}: неизвестный или отсутствующий kind`);
    }
    const kind = decision.kind;
    const needsClient =
      kind === "act" || kind === "connect" || kind === "reload" || kind === "command";
    if (needsClient && !isInt(decision.client)) {
      throw new TraceError(`решение #${index} (${kind}): нужен целый client`);
    }
    const needsConnection = kind === "deliver" || kind === "cut" || kind === "serverNotice";
    if (needsConnection && !isInt(decision.connection)) {
      throw new TraceError(`решение #${index} (${kind}): нужен целый connection`);
    }
    if (
      kind === "deliver" &&
      decision.direction !== "toServer" &&
      decision.direction !== "toClient"
    ) {
      throw new TraceError(`решение #${index} (deliver): direction — toServer или toClient`);
    }
    if (kind === "act" && !isRecord(decision.intent)) {
      throw new TraceError(`решение #${index} (act): нужен intent`);
    }
    if (
      kind === "command" &&
      (!isRecord(decision.command) || typeof decision.commandId !== "string")
    ) {
      throw new TraceError(`решение #${index} (command): нужны command и commandId`);
    }
    if (kind === "reload" && typeof decision.actorId !== "string") {
      throw new TraceError(`решение #${index} (reload): нужен actorId`);
    }
    if (kind === "storeFault" && !isInt(decision.afterWrites)) {
      throw new TraceError(`решение #${index} (storeFault): нужен afterWrites`);
    }
  });
  return raw as unknown as Trace;
}
