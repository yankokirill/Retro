// T-024: тело переехало в packages/server-core/src/rules/visibility.ts —
// правило чистое (без I/O), не зависит от apps/server. Реэкспорт сохраняет
// путь импорта для существующих тестов/кода этого пакета.

export type { AuthorOf } from "@retro/server-core";
export { isEmptyDelta, projectHidden, projectVisible } from "@retro/server-core";
