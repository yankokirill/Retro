// Персистентная (неизменяемая) хеш-таблица со строковыми ключами — HAMT, 32-way.
//
// Зачем: состояние CRDT — пять таблиц, и `merge(state, delta)` раньше копировал
// каждую целиком (`new Map(a)`): O(размер состояния) на КАЖДУЮ принятую дельту,
// то есть O(n²) на прогон. Здесь `set` копирует только путь от корня к листу
// (≤ 7 узлов по 5 бита хеша), остальное разделяется между версиями: O(log₃₂ n).
//
// Реализует `ReadonlyMap<string, V>`, поэтому потребители (`get`/`has`/`size`/
// `values`/итерация) не меняются. Порядок итерации детерминирован (по хешу), но
// НЕ равен порядку вставки — семантика CRDT от порядка не зависит (I3).

const BITS = 5;
const MASK = (1 << BITS) - 1;

interface Leaf<V> {
  readonly kind: 0;
  readonly hash: number;
  readonly key: string;
  readonly value: V;
}

interface Branch<V> {
  readonly kind: 1;
  readonly bitmap: number;
  /** Число листьев в поддереве — для `nth` (равномерная выборка за O(log n)). */
  readonly count: number;
  readonly children: readonly Node<V>[];
}

/** Ключи с полностью совпавшим 32-битным хешем (редко, но обязаны работать). */
interface Collision<V> {
  readonly kind: 2;
  readonly hash: number;
  readonly leaves: readonly Leaf<V>[];
}

type Node<V> = Leaf<V> | Branch<V> | Collision<V>;

/** FNV-1a, 32 бита. */
function hashKey(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function countOf<V>(node: Node<V>): number {
  return node.kind === 0 ? 1 : node.kind === 2 ? node.leaves.length : node.count;
}

function popcount(value: number): number {
  let x = value - ((value >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

function fragment(hash: number, shift: number): number {
  return (hash >>> shift) & MASK;
}

function get<V>(root: Node<V> | null, hash: number, key: string): Leaf<V> | undefined {
  let node = root;
  let shift = 0;
  while (node !== null) {
    if (node.kind === 0) return node.hash === hash && node.key === key ? node : undefined;
    if (node.kind === 2) {
      if (node.hash !== hash) return undefined;
      return node.leaves.find((leaf) => leaf.key === key);
    }
    const bit = 1 << fragment(hash, shift);
    if ((node.bitmap & bit) === 0) return undefined;
    node = node.children[popcount(node.bitmap & (bit - 1))] ?? null;
    shift += BITS;
  }
  return undefined;
}

/** Слияние двух листьев с разными ключами в поддерево, начиная с уровня `shift`. */
function merge2<V>(a: Leaf<V>, b: Leaf<V>, shift: number): Node<V> {
  if (a.hash === b.hash) return { kind: 2, hash: a.hash, leaves: [a, b] };
  const fa = fragment(a.hash, shift);
  const fb = fragment(b.hash, shift);
  if (fa === fb) {
    return { kind: 1, bitmap: 1 << fa, count: 2, children: [merge2(a, b, shift + BITS)] };
  }
  return {
    kind: 1,
    bitmap: (1 << fa) | (1 << fb),
    count: 2,
    children: fa < fb ? [a, b] : [b, a],
  };
}

/** `[новый узел, добавлен ли новый ключ]`. */
function set<V>(node: Node<V>, leaf: Leaf<V>, shift: number): readonly [Node<V>, boolean] {
  if (node.kind === 0) {
    if (node.hash === leaf.hash && node.key === leaf.key) return [leaf, false];
    return [merge2(node, leaf, shift), true];
  }
  if (node.kind === 2) {
    if (node.hash !== leaf.hash) {
      // Узел-коллизия на уровне ниже: разводим его и новый лист по фрагментам хеша.
      const fc = fragment(node.hash, shift);
      const fl = fragment(leaf.hash, shift);
      if (fc === fl) {
        const [child, added] = set(node, leaf, shift + BITS);
        return [{ kind: 1, bitmap: 1 << fc, count: countOf(child), children: [child] }, added];
      }
      return [
        {
          kind: 1,
          bitmap: (1 << fc) | (1 << fl),
          count: node.leaves.length + 1,
          children: fc < fl ? [node, leaf] : [leaf, node],
        },
        true,
      ];
    }
    const index = node.leaves.findIndex((existing) => existing.key === leaf.key);
    if (index === -1) return [{ kind: 2, hash: node.hash, leaves: [...node.leaves, leaf] }, true];
    const leaves = node.leaves.slice();
    leaves[index] = leaf;
    return [{ kind: 2, hash: node.hash, leaves }, false];
  }
  const bit = 1 << fragment(leaf.hash, shift);
  const index = popcount(node.bitmap & (bit - 1));
  if ((node.bitmap & bit) === 0) {
    const children = node.children.slice();
    children.splice(index, 0, leaf);
    return [{ kind: 1, bitmap: node.bitmap | bit, count: node.count + 1, children }, true];
  }
  const existing = node.children[index];
  if (existing === undefined) throw new Error("PersistentMap: corrupt branch");
  const [child, added] = set(existing, leaf, shift + BITS);
  const children = node.children.slice();
  children[index] = child;
  return [{ kind: 1, bitmap: node.bitmap, count: node.count + (added ? 1 : 0), children }, added];
}

/** Обход листьев одним генератором с явным стеком (вложенные `yield*` в разы медленнее). */
function* leavesOf<V>(root: Node<V> | null): Generator<Leaf<V>> {
  if (root === null) return;
  const stack: Node<V>[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Node<V>;
    if (node.kind === 0) {
      yield node;
    } else if (node.kind === 2) {
      for (const leaf of node.leaves) yield leaf;
    } else {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i] as Node<V>);
    }
  }
}

function walk<V>(node: Node<V>, visit: (leaf: Leaf<V>) => void): void {
  if (node.kind === 0) {
    visit(node);
  } else if (node.kind === 2) {
    for (const leaf of node.leaves) visit(leaf);
  } else {
    for (const child of node.children) walk(child, visit);
  }
}

export class PersistentMap<V> implements ReadonlyMap<string, V> {
  private constructor(
    private readonly root: Node<V> | null,
    readonly size: number,
  ) {}

  static empty<V>(): PersistentMap<V> {
    return new PersistentMap<V>(null, 0);
  }

  /** Из любого набора пар; повторный ключ — побеждает последний. */
  static from<V>(entries: Iterable<readonly [string, V]>): PersistentMap<V> {
    let map = PersistentMap.empty<V>();
    for (const [key, value] of entries) map = map.set(key, value);
    return map;
  }

  get(key: string): V | undefined {
    return get(this.root, hashKey(key), key)?.value;
  }

  has(key: string): boolean {
    return get(this.root, hashKey(key), key) !== undefined;
  }

  /**
   * `index`-я по порядку итерации пара, `undefined` вне `[0, size)`. O(log n): по
   * счётчикам в узлах — так из состояния выбирается равномерно случайная сущность,
   * не обходя его целиком.
   */
  nth(index: number): [string, V] | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.size) return undefined;
    let node = this.root;
    let remaining = index;
    while (node !== null) {
      if (node.kind === 0) return [node.key, node.value];
      if (node.kind === 2) {
        const leaf = node.leaves[remaining];
        return leaf ? [leaf.key, leaf.value] : undefined;
      }
      let next: Node<V> | null = null;
      for (const child of node.children) {
        const size = countOf(child);
        if (remaining < size) {
          next = child;
          break;
        }
        remaining -= size;
      }
      node = next;
    }
    return undefined;
  }

  /** Новая версия с `key → value`; эта версия не меняется. */
  set(key: string, value: V): PersistentMap<V> {
    const leaf: Leaf<V> = { kind: 0, hash: hashKey(key), key, value };
    if (this.root === null) return new PersistentMap(leaf, 1);
    const [root, added] = set(this.root, leaf, 0);
    return new PersistentMap(root, added ? this.size + 1 : this.size);
  }

  *entries(): IterableIterator<[string, V]> {
    for (const leaf of leavesOf(this.root)) yield [leaf.key, leaf.value];
  }

  *keys(): IterableIterator<string> {
    for (const leaf of leavesOf(this.root)) yield leaf.key;
  }

  *values(): IterableIterator<V> {
    for (const leaf of leavesOf(this.root)) yield leaf.value;
  }

  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.entries();
  }

  forEach(
    callback: (value: V, key: string, map: ReadonlyMap<string, V>) => void,
    thisArg?: unknown,
  ): void {
    if (this.root === null) return;
    walk(this.root, (leaf) => callback.call(thisArg, leaf.value, leaf.key, this));
  }
}
