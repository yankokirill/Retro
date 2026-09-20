// Детерминированный генератор случайных чисел — единственный источник
// случайности во всём мире симулятора (docs/spec/simulator.md § 5.7, SIM-02
// кр. 3). Алгоритм зафиксирован: смена — TRACE_VERSION + 1 (config.ts).
//
// sfc32, состояние — четыре uint32, инициализация: splitmix32(seed)
// четырежды, затем 15 холостых шагов.

export interface Prng {
  /** Следующее число с плавающей точкой в [0, 1). */
  next(): number;
  /** Целое в [a, b] включительно. */
  int(a: number, b: number): number;
  /**
   * Взвешенный выбор — ровно один `next()` на решение (§ 5.7). Веса
   * суммируются в переданном порядке — вызывающий отвечает за фиксированный
   * порядок элементов (`enabledEvents`, § 6 проекта).
   */
  pick<T>(items: readonly (readonly [T, number])[]): T;
  /** UUID v4 (122 случайных бита, корректные биты версии/варианта, § 5.7). */
  uuid(): string;
  /** Одно слово из словаря `WORDS` (§ 5.1 — тексты стикеров/групп/action items). */
  word(): string;
}

/** Словарь из 8 слов (§ 5.1: «текст — из словаря из 8 слов, часты одинаковые конкурентные тексты»). */
export const WORDS: readonly string[] = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "zeta",
  "eta",
  "theta",
];

function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e37_79b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a_2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

/** sfc32 — состояние захватывается замыканием и мутируется на каждый вызов. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  let sa = a >>> 0;
  let sb = b >>> 0;
  let sc = c >>> 0;
  let sd = d >>> 0;
  return () => {
    let t = (sa + sb) | 0;
    sa = sb ^ (sb >>> 9);
    sb = (sc + (sc << 3)) | 0;
    sc = (sc << 21) | (sc >>> 11);
    sd = (sd + 1) | 0;
    t = (t + sd) | 0;
    sc = (sc + t) | 0;
    return (t >>> 0) / 4_294_967_296;
  };
}

export function createPrng(seed: number): Prng {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xff_ff_ff_ff) {
    throw new Error(`createPrng: seed must be an integer in [0, 2^32-1], got ${seed}`);
  }
  const seeder = splitmix32(seed);
  const raw = sfc32(seeder(), seeder(), seeder(), seeder());
  for (let i = 0; i < 15; i++) raw();

  const next = (): number => raw();

  const int = (a: number, b: number): number => {
    if (!Number.isInteger(a) || !Number.isInteger(b) || b < a) {
      throw new Error(`Prng.int: invalid range [${a}, ${b}]`);
    }
    return a + Math.floor(next() * (b - a + 1));
  };

  const pick = <T>(items: readonly (readonly [T, number])[]): T => {
    if (items.length === 0) throw new Error("Prng.pick: items must be non-empty");
    const total = items.reduce((sum, [, weight]) => sum + weight, 0);
    if (!(total > 0)) throw new Error("Prng.pick: total weight must be positive");
    let r = next() * total;
    let lastPositive: T | undefined;
    let found = false;
    for (const [item, weight] of items) {
      if (!(weight > 0)) continue; // нулевой вес — вид отключён, выбираться не может
      lastPositive = item;
      found = true;
      if (r < weight) return item;
      r -= weight;
    }
    // Плавающая точка: остаток может не дойти до конца из-за накопленной ошибки
    // округления — берём последний элемент с ПОЛОЖИТЕЛЬНЫМ весом, а не просто последний
    // (им может оказаться отключённый профилем вид).
    if (!found) throw new Error("Prng.pick: unreachable");
    return lastPositive as T;
  };

  const uuid = (): string => {
    const bytes: number[] = [];
    for (let i = 0; i < 16; i++) bytes.push(int(0, 255));
    const b6 = bytes[6];
    const b8 = bytes[8];
    if (b6 === undefined || b8 === undefined) throw new Error("uuid: unreachable");
    bytes[6] = (b6 & 0x0f) | 0x40;
    bytes[8] = (b8 & 0x3f) | 0x80;
    const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };

  const word = (): string => {
    const w = WORDS[int(0, WORDS.length - 1)];
    if (w === undefined) throw new Error("word: unreachable");
    return w;
  };

  return { next, int, pick, uuid, word };
}
