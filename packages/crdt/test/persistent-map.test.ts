// PersistentMap (HAMT) — заменяет копирование `new Map(a)` в merge (T-005, асимптотика
// прогона симулятора). Свойство: ведёт себя как `Map` и не меняет прежние версии.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PersistentMap } from "../src/persistent-map.js";

const keyArb = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constantFrom("a", "b", "c", "aa", "ab", "ba", "actor:1", "actor:2"),
);

describe("PersistentMap: эквивалентность Map", () => {
  it("PersistentMap: get/has/size/итерация совпадают с Map после любой последовательности set", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(keyArb, fc.integer()), { maxLength: 200 }), (pairs) => {
        const reference = new Map<string, number>();
        let persistent = PersistentMap.empty<number>();
        for (const [key, value] of pairs) {
          reference.set(key, value);
          persistent = persistent.set(key, value);
        }
        expect(persistent.size).toBe(reference.size);
        for (const [key, value] of reference) {
          expect(persistent.has(key)).toBe(true);
          expect(persistent.get(key)).toBe(value);
        }
        expect(persistent.get("нет такого ключа")).toBeUndefined();
        expect(new Map(persistent)).toEqual(reference);
        expect([...persistent.keys()].sort()).toEqual([...reference.keys()].sort());
        expect([...persistent.values()].sort()).toEqual([...reference.values()].sort());
      }),
    );
  });

  it("PersistentMap: set не меняет прежние версии (персистентность)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(keyArb, fc.integer()), { minLength: 1, maxLength: 60 }),
        (pairs) => {
          const versions: Array<{ map: PersistentMap<number>; expected: Map<string, number> }> = [];
          const reference = new Map<string, number>();
          let persistent = PersistentMap.empty<number>();
          for (const [key, value] of pairs) {
            reference.set(key, value);
            persistent = persistent.set(key, value);
            versions.push({ map: persistent, expected: new Map(reference) });
          }
          for (const { map, expected } of versions) {
            expect(new Map(map)).toEqual(expected);
            expect(map.size).toBe(expected.size);
          }
        },
      ),
    );
  });

  it("PersistentMap: nth(i) даёт i-ю пару итерации, вне диапазона — undefined", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(keyArb, fc.integer()), { maxLength: 300 }), (pairs) => {
        let persistent = PersistentMap.empty<number>();
        for (const [key, value] of pairs) persistent = persistent.set(key, value);
        const ordered = [...persistent];
        ordered.forEach((pair, index) => {
          expect(persistent.nth(index)).toEqual(pair);
        });
        expect(persistent.nth(-1)).toBeUndefined();
        expect(persistent.nth(persistent.size)).toBeUndefined();
      }),
    );
  });

  it("PersistentMap: много ключей (глубокие ветви) и перезапись одного ключа", () => {
    let map = PersistentMap.empty<number>();
    for (let i = 0; i < 5000; i++) map = map.set(`actor-${i % 7}:${i}`, i);
    expect(map.size).toBe(5000);
    expect(map.get("actor-6:1000")).toBe(1000);
    const rewritten = map.set("actor-6:1000", -1);
    expect(rewritten.size).toBe(5000);
    expect(rewritten.get("actor-6:1000")).toBe(-1);
    expect(map.get("actor-6:1000")).toBe(1000);
    let count = 0;
    for (const _ of map) count += 1;
    expect(count).toBe(5000);
  });

  it("PersistentMap: ключи с одинаковым 32-битным хешем (коллизии) различаются", () => {
    // FNV-1a 32: заведомо найденная пара коллизий недоступна без перебора, поэтому ищем её здесь.
    const seen = new Map<number, string>();
    let pair: [string, string] | null = null;
    for (let i = 0; i < 300000 && pair === null; i++) {
      const key = `k${i}`;
      let hash = 0x811c9dc5;
      for (let j = 0; j < key.length; j++) {
        hash ^= key.charCodeAt(j);
        hash = Math.imul(hash, 0x01000193);
      }
      hash >>>= 0;
      const other = seen.get(hash);
      if (other !== undefined) pair = [other, key];
      else seen.set(hash, key);
    }
    expect(pair, "в 300000 ключах должна найтись коллизия FNV-1a 32").not.toBeNull();
    const [a, b] = pair as [string, string];
    const map = PersistentMap.empty<string>().set(a, "A").set(b, "B").set("x", "X");
    expect(map.size).toBe(3);
    expect(map.get(a)).toBe("A");
    expect(map.get(b)).toBe("B");
    expect(map.set(a, "A2").get(a)).toBe("A2");
    expect(map.set(a, "A2").get(b)).toBe("B");
  });
});
