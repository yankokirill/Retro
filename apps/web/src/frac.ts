// Дробные индексы порядка внутри колонки (R5, consistency-model.md § 1.4) — docs/design/T-015-board-ui.md § 1.

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = ALPHABET.length;
const MAX_LENGTH = 64;

const digit = (char: string | undefined): number =>
  char === undefined ? 0 : ALPHABET.indexOf(char);

/** Строка строго между `a` (может быть пустой) и `b` (`null` — верхней границы нет); `null` — не нашлась. */
function midpoint(a: string, b: string | null): string | null {
  if (b !== null) {
    if (b === "") return null;
    let n = 0;
    while (n < b.length && (a[n] ?? "0") === b[n]) n += 1;
    if (n > 0) {
      const rest = midpoint(a.slice(n), b.slice(n));
      return rest === null ? null : b.slice(0, n) + rest;
    }
  }
  const da = digit(a[0]);
  const db = b === null ? BASE : digit(b[0]);
  if (db - da > 1) return ALPHABET[Math.round((da + db) / 2)] ?? null;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  const rest = midpoint(a.slice(1), null);
  return rest === null ? null : (ALPHABET[da] ?? "") + rest;
}

/**
 * `frac` строго между `before` и `after` (сравнение строк). Если вставить нельзя (равные соседи,
 * исчерпаны 64 символа) — возвращается `before ?? after`, порядок тогда решает `Dot` (R5).
 */
export function fracBetween(before: string | null, after: string | null): string {
  if (before === null && after === null) return "V";
  if (before !== null && after !== null && before >= after) return before;
  const found = midpoint(before ?? "", after);
  const valid =
    found !== null &&
    found.length > 0 &&
    found.length <= MAX_LENGTH &&
    found > (before ?? "") &&
    (after === null || found < after);
  return valid ? found : (before ?? after ?? "V");
}
