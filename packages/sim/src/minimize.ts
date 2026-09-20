// Минимизация упавшей трассы — docs/spec/simulator.md § 9.2, SIM-10 кр. 2; дизайн § 5.8.
//
// ddmin (Zeller) по списку решений с оракулом «`replayTrace` падает на том же ID свойства».
// Три сокращения делают его практичным для трасс в тысячи решений:
//  1. обрезка хвоста — всё после решения, на котором найдено нарушение, не нужно;
//  2. пропущенные при воспроизведении решения ничего не меняли — выбрасываются даром, без прогона;
//  3. после каждого принятого кандидата пункты 1–2 применяются снова.
// Разбиения n = 2, 4, …; пробуются дополнения (трасса без одного куска). Когда n = число решений,
// перебрано удаление каждого одного решения — это и есть 1-минимальность (SIM-10 кр. 2).
// Число прогонов ограничено `budget`: при исчерпании возвращается лучшее найденное.

import type { Event } from "./events.js";
import type { WorldHooks } from "./hooks.js";
import { replayTrace } from "./replay.js";
import { type Trace, TraceError } from "./trace.js";
import type { PropertyId } from "./violation.js";

export const DEFAULT_MINIMIZE_BUDGET = 2000;

export interface MinimizeOptions {
  /** Подмены на границах ядер — только для мутантов (трасса мутанта минимизируется с тем же мутантом). */
  readonly hooks?: WorldHooks;
  /** Максимум прогонов воспроизведения (по умолчанию 2000). */
  readonly budget?: number;
  /** Вызывается после каждого принятого сокращения: сколько прогонов сделано и сколько решений осталось. */
  readonly onProgress?: (runs: number, remaining: number) => void;
}

export interface MinimizeResult {
  readonly trace: Trace;
  /** Свойство, на котором трасса падала и продолжает падать. */
  readonly property: PropertyId;
  readonly originalDecisions: number;
  readonly runs: number;
  /** `true` — бюджет кончился раньше, чем доказана 1-минимальность. */
  readonly exhausted: boolean;
}

class BudgetExhausted extends Error {}

export async function minimizeTrace(
  trace: Trace,
  options: MinimizeOptions = {},
): Promise<MinimizeResult> {
  const budget = options.budget ?? DEFAULT_MINIMIZE_BUDGET;
  const replayOptions = options.hooks ? { hooks: options.hooks } : {};
  let runs = 0;

  /** Прогон кандидата; при том же свойстве возвращает его сжатый вид (без хвоста и пропущенных). */
  const failsSame = async (
    decisions: readonly Event[],
    property: PropertyId,
  ): Promise<Event[] | null> => {
    if (runs >= budget) throw new BudgetExhausted();
    runs += 1;
    const result = await replayTrace({ ...trace, decisions }, replayOptions);
    if (result.violation?.property !== property) return null;
    const skipped = new Set(result.skippedIndexes);
    return decisions.slice(0, result.consumed).filter((_, index) => !skipped.has(index));
  };

  runs += 1;
  const baseline = await replayTrace(trace, replayOptions);
  if (!baseline.violation) {
    throw new TraceError("трасса не падает: минимизировать нечего");
  }
  const property = baseline.violation.property;
  const skippedInBaseline = new Set(baseline.skippedIndexes);
  let current: Event[] = trace.decisions
    .slice(0, baseline.consumed)
    .filter((_, index) => !skippedInBaseline.has(index));
  options.onProgress?.(runs, current.length);

  let exhausted = false;
  try {
    let parts = 2;
    while (current.length >= 2) {
      const chunk = Math.ceil(current.length / parts);
      let reduced = false;
      for (let start = 0; start < current.length; start += chunk) {
        const candidate = [...current.slice(0, start), ...current.slice(start + chunk)];
        const smaller = await failsSame(candidate, property);
        if (smaller) {
          current = smaller;
          parts = Math.max(parts - 1, 2);
          reduced = true;
          options.onProgress?.(runs, current.length);
          break;
        }
      }
      if (!reduced) {
        if (parts >= current.length) break; // проверено удаление каждого одного решения
        parts = Math.min(current.length, parts * 2);
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    exhausted = true;
  }

  return {
    trace: { ...trace, decisions: current },
    property,
    originalDecisions: trace.decisions.length,
    runs,
    exhausted,
  };
}
