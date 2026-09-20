// Общий тип нарушения проверки — используется well-formed.ts, checks.ts,
// drain.ts, run.ts. Отдельный модуль (не входит в список § 5.1 проекта
// буквально), чтобы избежать циклического импорта между well-formed.ts и
// checks.ts: S1 использует well-formed внутри checks, а well-formed сам
// должен уметь сообщить о W1–W4 в терминах того же типа отчёта.

export type PropertyId =
  | "S1"
  | "S2"
  | "S3"
  | "S4"
  | "S5"
  | "S6"
  | "S7"
  | "S8"
  | "S9"
  | "S10"
  | "S11";

export interface Violation {
  readonly property: PropertyId;
  /** `world.acts` в момент нарушения (номер шага для отчёта § 9.3). */
  readonly step: number;
  readonly message: string;
  /** Диагностика для отчёта — например, diff пяти компонент состояния (S4/S5). */
  readonly detail?: unknown;
}

export function violation(
  property: PropertyId,
  step: number,
  message: string,
  detail?: unknown,
): Violation {
  return { property, step, message, detail };
}
