// T-024: тело переехало в packages/server-core/src/rules/permissions.ts —
// правило чистое (без I/O), не зависит от apps/server. Реэкспорт сохраняет
// путь импорта для существующих тестов/кода этого пакета.

export type {
  CheckPermissionParams,
  CheckPermissionResult,
  StickerAction,
} from "@retro/server-core";
export { checkPermission, classifyAction } from "@retro/server-core";
