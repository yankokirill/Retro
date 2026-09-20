// Главный цикл — docs/design/T-005-simulator.md § 5.2.
//
//   const prng = createPrng(config.seed);
//   const world = createWorld(config, prng);
//   пока world.acts < config.ops: выбрать событие (enabledEvents + веса
//   профиля), applyEvent, прогнать пошаговые проверки S1–S3/S7/S10/S11 над
//   наблюдением этого шага; на контрольной точке — drain (S9) + S4/S5/S6/S8
//   + полный S1.
//
// `--replay`/`--minimize` (SIM-10) — T-027, здесь их нет (docs/tasks.md § 7.1).

import { applyEvent } from "./apply.js";
import {
  checkAck,
  checkAckedOpsPersist,
  checkClientsMatchOracle,
  checkMessageSchema,
  checkNoAuthorLeak,
  checkNoRejectedResidue,
  checkReject,
  checkScreensAgree,
  checkSnapshotConsistency,
  checkVoteLimit,
  checkWellFormedFull,
  checkWellFormedIncremental,
} from "./checks.js";
import { CHECKPOINT_SPACING_DIVISOR, LONG_RUN_ACTS, type SimConfig } from "./config.js";
import { recordConflictAtCheckpoint } from "./coverage.js";
import { drain } from "./drain.js";
import { type Candidate, type Event, enabledEvents, resolveCandidate } from "./events.js";
import type { WorldHooks } from "./hooks.js";
import { foldNewRows } from "./oracle.js";
import { createStreams, type Prng, type Streams } from "./prng.js";
import type { Stats } from "./stats.js";
import type { Violation } from "./violation.js";
import { createWellFormedState, type WellFormedState } from "./well-formed.js";
import { createWorld, type World } from "./world.js";

export type RunResult =
  | { readonly ok: true; readonly decisions: readonly Event[]; readonly stats: Stats }
  | {
      readonly ok: false;
      readonly violation: Violation;
      readonly decisions: readonly Event[];
      readonly stats: Stats;
    };

const KIND_ORDER = [
  "act",
  "deliver",
  "cut",
  "serverNotice",
  "connect",
  "reload",
  "command",
  "snapshot",
  "storeFault",
] as const;

function eventWeight(world: World, kind: Candidate["kind"]): number {
  const events = world.config.profile.events;
  switch (kind) {
    case "act":
      return events.act;
    case "deliver":
      return events.deliver;
    case "cut":
      return events.cut;
    case "serverNotice":
      return events.serverNotice;
    case "connect":
      return events.connect;
    case "reload":
      // перезагрузка = welcome со всем состоянием: в длинных прогонах реже (см. LONG_RUN_ACTS)
      return events.reload * Math.min(1, LONG_RUN_ACTS / Math.max(world.acts, 1));
    case "command":
      return events.command;
    case "snapshot":
      // снапшот сжимает всё состояние, а свежий снапшот превращает переподключение в
      // welcome со всем состоянием: в длинных прогонах реже (см. LONG_RUN_ACTS)
      return events.snapshot * Math.min(1, LONG_RUN_ACTS / Math.max(world.acts, 1));
    case "storeFault":
      return events.storeFault;
  }
}

/**
 * Выбор события — сначала вид (E1..E9) взвешенно по профилю, затем
 * конкретный кандидат этого вида равномерно, начиная со случайного
 * смещения. Если ни один кандидат выбранного вида не резолвится
 * (`generateIntent`/`generateCommand` не нашли, что предложить) — вид
 * исключается из рассмотрения на этом шаге, пробуем следующий по весу.
 */
function chooseEvent(
  world: World,
  candidates: readonly Candidate[],
  streams: Streams,
): Event | null {
  const prng: Prng = streams.selection;
  const remainingKinds = new Set(candidates.map((c) => c.kind));

  while (remainingKinds.size > 0) {
    const weighted: (readonly [Candidate["kind"], number])[] = KIND_ORDER.filter((k) =>
      remainingKinds.has(k),
    )
      .map((k) => [k, eventWeight(world, k)] as const)
      .filter(([, weight]) => weight > 0);
    const totalWeight = weighted.reduce((sum, [, w]) => sum + w, 0);

    // Виды с нулевым весом профиль отключил (storeFault вне `faults`, snapshot в `reveal`):
    // равномерный выбор среди них нарушил бы профиль. Если положительных не осталось —
    // мир не может сделать ни шага, прогон завершается как есть.
    if (totalWeight <= 0) return null;
    const kind = prng.pick(weighted);
    if (kind === undefined) return null;

    const pool = candidates.filter((c) => c.kind === kind);
    const offset = pool.length > 0 ? prng.int(0, pool.length - 1) : 0;
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[(offset + i) % pool.length];
      if (!candidate) continue;
      const event = resolveCandidate(world, candidate, streams);
      if (event) return event;
    }
    remainingKinds.delete(kind);
  }
  return null;
}

/** `applyEvent` + пошаговые проверки над наблюдением этого шага (S1 инкрементально, S2, S3, S7, S10, S11). */
async function step(
  world: World,
  event: Event,
  wellFormedState: WellFormedState,
): Promise<Violation | null> {
  const observation = await applyEvent(world, event);

  if (observation.newLogRows.length > 0) {
    foldNewRows(world.oracle, observation.newLogRows);
    for (const row of observation.newLogRows) {
      const violation = checkWellFormedIncremental(wellFormedState, row, world.acts);
      if (violation) return violation;
    }
    const voteViolation = checkVoteLimit(world, world.acts);
    if (voteViolation) return voteViolation;
  }

  for (const ack of observation.acks) {
    const violation = checkAck(world, ack, world.acts);
    if (violation) return violation;
  }
  for (const reject of observation.rejects) {
    const violation = checkReject(world, reject, world.acts);
    if (violation) return violation;
  }
  for (const outgoing of observation.outgoing) {
    const violation = checkNoAuthorLeak(world, outgoing, world.acts);
    if (violation) return violation;
  }
  for (const sent of observation.sentRaw) {
    const violation = checkMessageSchema(sent.direction, sent.raw, world.acts);
    if (violation) return violation;
    world.stats.schemaChecked[sent.direction] += 1;
  }
  return null;
}

/** Досылка (SIM-07) + проверки, верные только «в покое»: S4, S5, S6, S7 (резидуа), S8, полный S1. */
async function checkpoint(
  world: World,
  streams: Streams,
  decisions: Event[],
  wellFormedState: WellFormedState,
): Promise<Violation | null> {
  const drainViolation = await drain(world, streams, decisions, (event) =>
    step(world, event, wellFormedState),
  );
  if (drainViolation) return drainViolation;

  world.stats.checkpoints += 1;
  recordConflictAtCheckpoint(world);

  const fullViolation = checkWellFormedFull(world.store.log(world.boardId), world.acts);
  if (fullViolation) return fullViolation;

  const s4 = checkClientsMatchOracle(world, world.acts);
  if (s4) return s4;
  const s5 = checkScreensAgree(world, world.acts);
  if (s5) return s5;
  const s6 = checkAckedOpsPersist(world, world.acts);
  if (s6) return s6;
  const s7 = checkNoRejectedResidue(world, world.acts);
  if (s7) return s7;
  const s8 = checkSnapshotConsistency(world, world.snapshotsObserved, world.acts);
  world.snapshotsObserved.length = 0;
  if (s8) return s8;

  return null;
}

function ok(decisions: readonly Event[], stats: Stats): RunResult {
  return { ok: true, decisions, stats };
}

function fail(violation: Violation, decisions: readonly Event[], stats: Stats): RunResult {
  return { ok: false, violation, decisions, stats };
}

export interface RunOptions {
  /** Подмены на границах ядер — только для мутантов (`mutants.ts`), в обычном прогоне не задаётся. */
  readonly hooks?: WorldHooks;
}

export async function runSimulation(
  config: SimConfig,
  options: RunOptions = {},
): Promise<RunResult> {
  const streams = createStreams(config.seed);
  const prng = streams.selection;
  const world = createWorld(config, streams.world, options.hooks);
  const wellFormedState = createWellFormedState();
  const decisions: Event[] = [];
  let nextCheckpoint = prng.int(config.checkpointMin, config.checkpointMax);

  while (world.acts < config.ops) {
    const candidates = enabledEvents(world, "run");
    const event = chooseEvent(world, candidates, streams);
    if (!event) break; // мир не может сделать ни шага — завершаем прогон как есть

    decisions.push(event);
    world.stats.steps += 1;
    const violation = await step(world, event, wellFormedState);
    if (violation) return fail(violation, decisions, world.stats);

    if (world.acts >= nextCheckpoint) {
      const violation2 = await checkpoint(world, streams, decisions, wellFormedState);
      if (violation2) return fail(violation2, decisions, world.stats);
      // не чаще, чем раз в 1/8 уже выполненных действий: сравнение состояний целиком (S4/S5)
      // стоит O(состояния), суммарная стоимость проверок должна расти линейно
      nextCheckpoint =
        world.acts +
        Math.max(
          prng.int(config.checkpointMin, config.checkpointMax),
          Math.floor(world.acts / CHECKPOINT_SPACING_DIVISOR),
        );
    }
  }

  const violation = await checkpoint(world, streams, decisions, wellFormedState);
  return violation ? fail(violation, decisions, world.stats) : ok(decisions, world.stats);
}
