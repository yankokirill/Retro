// Конфигурация прогона симулятора — docs/spec/simulator.md § 5.3 («Профили»),
// docs/design/T-005-simulator.md § 5.1/5.6/11.1. Чистые данные и валидация,
// без случайности и без I/O (правило 7 CLAUDE.md, ADR-0009).
//
// Точные веса профилей, кроме `default`, — первое приближение по прозе §5.3
// спецификации, не выверенная константа. docs/design/T-005-simulator.md § 5
// (шаг 7 плана T-005, 2026-09-16): веса донастраиваются по факту покрытия
// SIM-11 (`packages/sim/test/coverage.test.ts`), а не выдумываются заранее —
// эта настройка ожидаема и не противоречит правилу 3 CLAUDE.md (подгоняются
// параметры генератора, а не сами проверки).

export type Profile = "default" | "conflicts" | "chaos" | "reveal" | "votes" | "faults";

export const PROFILES: readonly Profile[] = [
  "default",
  "conflicts",
  "chaos",
  "reveal",
  "votes",
  "faults",
];

export type Phase = "collect" | "group" | "vote" | "discuss" | "actions";

/** Вид намерения — подмножество `Intent["type"]` из `@retro/client-core` (§ 4). */
export type IntentKind =
  | "createSticker"
  | "editText"
  | "setColor"
  | "move"
  | "setGroup"
  | "delete"
  | "restore"
  | "createGroup"
  | "renameGroup"
  | "createAction"
  | "editAction"
  | "assign"
  | "setDone"
  | "vote"
  | "unvote";

/** События мира — E1..E9, § 4.2 спецификации. `act` — только E1, бюджет `--ops`. */
export interface EventWeights {
  readonly act: number;
  readonly deliver: number;
  readonly cut: number;
  readonly serverNotice: number;
  readonly connect: number;
  readonly reload: number;
  readonly command: number;
  readonly snapshot: number;
  readonly storeFault: number;
}

export type IntentWeightsByPhase = Readonly<
  Record<Phase, Readonly<Partial<Record<IntentKind, number>>>>
>;

export interface ProfileConfig {
  readonly name: Profile;
  /** Вероятность взять цель из последних 3 затронутых сущностей (§ 5.1 «горячая цель»). */
  readonly hot: number;
  readonly events: EventWeights;
  /** Вес намерения, явно не перечисленного в `intentWeights` для текущей фазы («остальное», § 5.6). */
  readonly defaultIntentWeight: number;
  readonly intentWeights: IntentWeightsByPhase;
  /** Доля `resetVotes` среди `command` в фазе `vote` (§ 5.6). */
  readonly resetVotesShare: number;
  /**
   * Первый `setPhase` из `collect` (reveal) выдаётся только при наличии клиента без
   * соединения (§ 5.3, профиль `reveal`: «разрывы и перезагрузки вокруг первого
   * `setPhase`»). Без этого условия сценарий H1 (клиент офлайн в момент reveal)
   * случается в единицах прогонов из десяти, и регрессия досылки проходит матрицу.
   */
  readonly revealNeedsOffline: boolean;
  /** Из какого диапазона генератор берёт `voteLimit` при создании доски (§ 3). */
  readonly voteLimitRange: readonly [number, number];
}

export interface SimConfig {
  readonly seed: number;
  readonly clients: number;
  readonly ops: number;
  readonly profile: ProfileConfig;
  readonly checkpointMin: number;
  readonly checkpointMax: number;
}

export const MIN_CLIENTS = 2;
export const MAX_CLIENTS = 20;
export const DEFAULT_CLIENTS = 5;
export const DEFAULT_OPS = 10_000;
/**
 * До скольких действий прогон идёт «как есть»; дальше события с полной стоимостью
 * O(состояния) редеют, чтобы время прогона росло линейно от `--ops`, а не квадратично:
 * вес E6 умножается на `min(1, LONG_RUN_ACTS / действий)` (перезагрузка = `welcome` со
 * всем состоянием), а шаг контрольных точек не меньше `действий / CHECKPOINT_SPACING_DIVISOR`
 * (контрольная точка сравнивает состояния целиком). Матрица `test:sim` (≤ 1500 оп) не затронута.
 */
export const LONG_RUN_ACTS = 1500;
export const CHECKPOINT_SPACING_DIVISOR = 8;

export const DEFAULT_CHECKPOINT_MIN = 200;
export const DEFAULT_CHECKPOINT_MAX = 800;
export const DEFAULT_PROFILE_NAME: Profile = "default";

/**
 * Формат решений трассы (docs/spec/simulator.md § 9.1, ВС-9): меняется только при
 * несовместимой правке структуры `Event`; такие трассы `--replay` явно отвергает.
 * 3 — `reload` несёт `actorId`, `command` — `commandId`.
 */
export const TRACE_VERSION = 3;

/**
 * Алгоритм случайных чисел и порядок перечисления событий (§ 6 п. 4): от него зависит
 * только «повторит ли прогон по `seed` эту трассу»; `--replay` генератор не вызывает,
 * поэтому трассы других версий планировщика проигрываются.
 * 2 — цель выбирается выборкой из состояния клиента, порядок таблиц по хешу, вес E6/E8
 * и шаг контрольных точек зависят от числа действий (`LONG_RUN_ACTS`);
 * 3 — подпотоки `selection`/`world`/`ids`, идентификаторы в решениях.
 */
export const SCHEDULER_VERSION = 3;

const BASE_EVENTS: EventWeights = {
  act: 30,
  deliver: 55,
  cut: 2,
  serverNotice: 3,
  connect: 4,
  reload: 0.5,
  command: 1,
  snapshot: 0.3,
  storeFault: 0,
};

const BASE_INTENTS: IntentWeightsByPhase = {
  collect: {
    createSticker: 40,
    editText: 25,
    setColor: 10,
    move: 10,
    delete: 5,
    restore: 5,
    createGroup: 10,
  },
  group: {
    move: 25,
    setGroup: 20,
    createGroup: 10,
    renameGroup: 10,
    editText: 15,
    createSticker: 10,
    delete: 5,
    restore: 5,
  },
  vote: { vote: 60, unvote: 30 },
  discuss: { createAction: 30, editAction: 20, assign: 20, setDone: 20, delete: 10 },
  actions: { createAction: 30, editAction: 20, assign: 20, setDone: 20, delete: 10 },
};

function profile(overrides: Partial<ProfileConfig> & { readonly name: Profile }): ProfileConfig {
  return {
    hot: 0.3,
    events: BASE_EVENTS,
    defaultIntentWeight: 1,
    intentWeights: BASE_INTENTS,
    resetVotesShare: 0.1,
    revealNeedsOffline: false,
    voteLimitRange: [1, 3],
    ...overrides,
  };
}

const PROFILE_CONFIGS: Readonly<Record<Profile, ProfileConfig>> = {
  default: profile({ name: "default" }),
  conflicts: profile({
    name: "conflicts",
    hot: 0.8,
    events: { ...BASE_EVENTS, cut: 0.5, serverNotice: 0.5, reload: 0.1 },
  }),
  chaos: profile({
    name: "chaos",
    events: { ...BASE_EVENTS, cut: 8, serverNotice: 10, reload: 3, connect: 8 },
  }),
  reveal: profile({
    name: "reveal",
    events: { ...BASE_EVENTS, cut: 8, serverNotice: 6, reload: 0.5, snapshot: 0 },
    revealNeedsOffline: true,
  }),
  votes: profile({
    name: "votes",
    resetVotesShare: 0.4,
    voteLimitRange: [1, 2],
    intentWeights: { ...BASE_INTENTS, vote: { vote: 70, unvote: 30 } },
  }),
  faults: profile({ name: "faults", events: { ...BASE_EVENTS, storeFault: 0.3 } }),
};

export function profileConfig(name: Profile): ProfileConfig {
  const config = PROFILE_CONFIGS[name];
  if (!config) throw new Error(`profileConfig: unknown profile ${JSON.stringify(name)}`);
  return config;
}

export interface ConfigInput {
  readonly seed: number;
  readonly clients?: number;
  readonly ops?: number;
  readonly profile?: Profile;
  readonly checkpointMin?: number;
  readonly checkpointMax?: number;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: SimConfig }
  | { readonly ok: false; readonly error: string };

/** Строит и валидирует `SimConfig` из аргументов CLI/теста. Чистая функция — CLI решает, что делать с ошибкой (код выхода 2, § 11.1). */
export function buildConfig(input: ConfigInput): ConfigResult {
  const clients = input.clients ?? DEFAULT_CLIENTS;
  const ops = input.ops ?? DEFAULT_OPS;
  const profileName = input.profile ?? DEFAULT_PROFILE_NAME;
  const checkpointMin = input.checkpointMin ?? DEFAULT_CHECKPOINT_MIN;
  const checkpointMax = input.checkpointMax ?? DEFAULT_CHECKPOINT_MAX;

  if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 0xff_ff_ff_ff) {
    return { ok: false, error: `seed must be an integer in [0, 2^32-1], got ${input.seed}` };
  }
  if (!Number.isInteger(clients) || clients < MIN_CLIENTS || clients > MAX_CLIENTS) {
    return {
      ok: false,
      error: `clients must be an integer in [${MIN_CLIENTS}, ${MAX_CLIENTS}], got ${clients}`,
    };
  }
  if (!Number.isInteger(ops) || ops <= 0) {
    return { ok: false, error: `ops must be a positive integer, got ${ops}` };
  }
  if (!PROFILES.includes(profileName)) {
    return { ok: false, error: `unknown profile ${JSON.stringify(profileName)}` };
  }
  if (!Number.isInteger(checkpointMin) || checkpointMin <= 0) {
    return { ok: false, error: `checkpointMin must be a positive integer, got ${checkpointMin}` };
  }
  if (!Number.isInteger(checkpointMax) || checkpointMax < checkpointMin) {
    return {
      ok: false,
      error: `checkpointMax (${checkpointMax}) must be >= checkpointMin (${checkpointMin})`,
    };
  }

  return {
    ok: true,
    config: {
      seed: input.seed,
      clients,
      ops,
      profile: profileConfig(profileName),
      checkpointMin,
      checkpointMax,
    },
  };
}
