// T-024: тело переехало в packages/server-core/src/rules/validate.ts —
// правило чистое (без I/O), не зависит от apps/server. Реэкспорт сохраняет
// путь импорта для существующих тестов/кода этого пакета.

export type { ValidateOpParams, ValidateOpResult } from "@retro/server-core";
export { MAX_LAMPORT_AHEAD, validateOp } from "@retro/server-core";
