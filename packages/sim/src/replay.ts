// Воспроизведение трассы — docs/spec/simulator.md § 9.2, SIM-10. Выполняет записанные решения
// планировщика БЕЗ генератора: ни `enabledEvents`, ни `chooseEvent`, ни `generateIntent` здесь не
// вызываются, поэтому трассы переживают правки планировщика (ВС-9). Решение, неприменимое в
// текущем мире, пропускается и считается — это нужно минимизации, удалившей часть предпосылок.

import { buildConfig } from "./config.js";
import { drain } from "./drain.js";
import { isApplicable } from "./events.js";
import type { WorldHooks } from "./hooks.js";
import { createStreams } from "./prng.js";
import { checkpointChecks, step } from "./run.js";
import type { Stats } from "./stats.js";
import { type Trace, TraceError } from "./trace.js";
import type { Violation } from "./violation.js";
import { createWellFormedState } from "./well-formed.js";
import { createWorld } from "./world.js";

export interface ReplayResult {
  readonly ok: boolean;
  /** Первое нарушение; `undefined`, если трасса проиграна без нарушений. */
  readonly violation?: Violation;
  /** Сколько решений выполнено. */
  readonly applied: number;
  /** Сколько решений пропущено как неприменимые в этом мире (§ 9.2). */
  readonly skipped: number;
  /** Сколько решений трассы разобрано, включая то, на котором найдено нарушение (для обрезки хвоста). */
  readonly consumed: number;
  /** Номера пропущенных решений: они ничего не изменили, минимизация выбрасывает их даром. */
  readonly skippedIndexes: readonly number[];
  readonly stats: Stats;
}

export interface ReplayOptions {
  /** Подмены на границах ядер — только для мутантов; трасса мутанта проигрывается с тем же мутантом. */
  readonly hooks?: WorldHooks;
}

export async function replayTrace(
  trace: Trace,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const built = buildConfig({ seed: trace.seed, ...trace.config });
  if (!built.ok) throw new TraceError(`config трассы невалиден: ${built.error}`);
  const streams = createStreams(built.config.seed);
  const world = createWorld(built.config, streams.world, options.hooks);
  const wellFormedState = createWellFormedState();

  let applied = 0;
  const skippedIndexes: number[] = [];
  const result = (consumed: number, violation?: Violation): ReplayResult => ({
    ok: violation === undefined,
    ...(violation ? { violation } : {}),
    applied,
    skipped: skippedIndexes.length,
    consumed,
    skippedIndexes,
    stats: world.stats,
  });

  for (let index = 0; index < trace.decisions.length; index++) {
    const event = trace.decisions[index];
    if (!event) continue;
    if (event.kind === "checkpoint") {
      // Отметка контрольной точки. Записанная досылка уже выполнена решениями; на той же сборке
      // каналы пусты, и `drain` ничего не делает — остаётся исход (S9) и проверки покоя. На
      // ДРУГОЙ сборке (исправленный код, трасса мутанта) те же события порождают другие ответы,
      // и часть сообщений может остаться недоставленной — тогда досылка доводится тем же
      // `drain`, а не объявляется нарушением: иначе регрессионная трасса красна на исправленном коде.
      const violation =
        (await drain(world, streams, [], (next) => step(world, next, wellFormedState))) ??
        checkpointChecks(world);
      if (violation) return result(index + 1, violation);
      continue;
    }
    if (!isApplicable(world, event)) {
      skippedIndexes.push(index);
      continue;
    }

    const actsBefore = world.acts;
    let violation: Violation | null;
    try {
      violation = await step(world, event, wellFormedState);
    } catch (error) {
      // Намерение над сущностью, которой в этом мире нет (удалено вместе с созданием), ядро клиента
      // отвергает исключением. Для остальных решений исключение — настоящая ошибка, не пропуск.
      if (event.kind !== "act") throw error;
      world.acts = actsBefore;
      skippedIndexes.push(index);
      continue;
    }
    applied += 1;
    if (violation) return result(index + 1, violation);
  }

  return result(trace.decisions.length);
}
