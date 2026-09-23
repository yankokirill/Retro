// T-015 § 1 — REQ-008: позиция стикера между соседями (frac).

import { describe, expect, it } from "vitest";
import { fracBetween } from "../src/frac.js";

const ALPHABET = /^[0-9A-Za-z]{1,64}$/;

/** Детерминированный ГПСЧ (mulberry32) — seed печатается в имени теста. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("fracBetween", () => {
  it("REQ-008: (null, null) даёт корректную строку алфавита длиной 1–64", () => {
    expect(fracBetween(null, null)).toMatch(ALPHABET);
  });

  it("REQ-008: результат строго между соседями", () => {
    const cases: [string | null, string | null][] = [
      ["a", "c"],
      ["a", "b"],
      ["0", "z"],
      ["Az", "B"],
      ["a", "a1"],
      [null, "a"],
      ["a", null],
    ];
    for (const [before, after] of cases) {
      const mid = fracBetween(before, after);
      expect(mid).toMatch(ALPHABET);
      if (before !== null) expect(before < mid).toBe(true);
      if (after !== null) expect(mid < after).toBe(true);
    }
  });

  it("REQ-008: границы алфавита — после 'z', перед '0', между '0' и '1'", () => {
    const afterZ = fracBetween("z", null);
    expect(afterZ).toMatch(ALPHABET);
    expect("z" < afterZ).toBe(true);
    const beforeZero = fracBetween(null, "0");
    if (beforeZero !== "0") {
      // строго меньше, если вставка возможна; иначе допустим возврат края (см. дизайн)
      expect(beforeZero < "0").toBe(true);
    }
    const mid = fracBetween("0", "1");
    expect(mid).toMatch(ALPHABET);
    expect("0" < mid && mid < "1").toBe(true);
  });

  it("REQ-008: равные соседи — возвращается before", () => {
    expect(fracBetween("m", "m")).toBe("m");
  });

  it("REQ-008: 200 вставок в конец — порядок сохранён, длина ≤ 64", () => {
    const list: string[] = [];
    for (let i = 0; i < 200; i++) {
      list.push(fracBetween(list[list.length - 1] ?? null, null));
    }
    for (const f of list) expect(f).toMatch(ALPHABET);
    for (let i = 1; i < list.length; i++)
      expect((list[i - 1] as string) < (list[i] as string)).toBe(true);
  });

  it("REQ-008: 200 вставок в начало — порядок сохранён, длина ≤ 64", () => {
    const list: string[] = [];
    for (let i = 0; i < 200; i++) {
      list.unshift(fracBetween(null, list[0] ?? null));
    }
    for (const f of list) expect(f).toMatch(ALPHABET);
    for (let i = 1; i < list.length; i++)
      expect((list[i - 1] as string) < (list[i] as string)).toBe(true);
  });

  it("REQ-008: 200 вставок в середину (между первым и вторым) — порядок сохранён, длина ≤ 64", () => {
    const list = [fracBetween(null, null)];
    list.push(fracBetween(list[0] as string, null));
    for (let i = 0; i < 200; i++) {
      list.splice(1, 0, fracBetween(list[0] as string, list[1] as string));
    }
    for (const f of list) expect(f).toMatch(ALPHABET);
    for (let i = 1; i < list.length; i++)
      expect((list[i - 1] as string) < (list[i] as string)).toBe(true);
  });

  for (const seed of [1, 2, 3, 4, 5]) {
    it(`REQ-008: случайные вставки сохраняют порядок и алфавит (seed=${seed})`, () => {
      const rnd = prng(seed);
      const list: string[] = [];
      for (let i = 0; i < 200; i++) {
        const index = Math.floor(rnd() * (list.length + 1));
        const frac = fracBetween(list[index - 1] ?? null, list[index] ?? null);
        expect(frac).toMatch(ALPHABET);
        list.splice(index, 0, frac);
      }
      for (let i = 1; i < list.length; i++) {
        expect((list[i - 1] as string) < (list[i] as string), `seed=${seed} i=${i}`).toBe(true);
      }
    });
  }
});
