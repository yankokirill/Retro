// Проводной формат дельты — docs/spec/protocol.md § 1–3.
import type { Dot, WireDelta } from "@retro/crdt";
import { z } from "zod";

export const LIMITS = {
  messageBytes: 16 * 1024,
  text: 2000,
  title: 200,
  displayName: 50,
  entriesPerDelta: 16,
  supersedesPerDelta: 64,
  voteLimit: { min: 1, max: 10, default: 3 },
  timerSeconds: { min: 30, max: 3600 },
} as const;

export const actorIdSchema = z.uuid();
export const guestIdSchema = z.uuid();
export const boardIdSchema = z.uuid();

/** Ссылка-приглашение на роль participant/viewer (ADR-0007). */
export const linkTokenSchema = z.uuid();

/** `${actorId}:${counter}` — dot операции создания сущности. */
export const entityIdSchema = z.string().regex(/^[0-9a-fA-F-]{36}:[1-9]\d*$/);

export const dotSchema = z.object({
  actor: actorIdSchema,
  counter: z.number().int().positive(),
});

export const stampSchema = z.object({
  lamport: z.number().int().positive(),
  actor: actorIdSchema,
});

export const kindSchema = z.enum(["sticker", "group", "action"]);
export const columnSchema = z.enum(["start", "stop", "continue"]);
export const colorSchema = z.enum(["yellow", "green", "blue", "pink", "purple"]);
export const fieldSchema = z.enum([
  "text",
  "color",
  "place",
  "group",
  "deleted",
  "title",
  "assignee",
  "done",
]);

const nonBlank = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, "must not be blank");

export const textSchema = nonBlank(LIMITS.text);
export const titleSchema = nonBlank(LIMITS.title);
export const displayNameSchema = nonBlank(LIMITS.displayName);

export const placeSchema = z.object({
  column: columnSchema,
  frac: z.string().regex(/^[0-9A-Za-z]{1,64}$/),
});

export const keySchema = z.object({ entity: entityIdSchema, field: fieldSchema });

// Домен значения зависит от поля — consistency-model.md § 1.4.
const entryFor = <F extends z.infer<typeof fieldSchema>, V extends z.ZodType>(field: F, value: V) =>
  z.object({
    key: z.object({ entity: entityIdSchema, field: z.literal(field) }),
    dot: dotSchema,
    stamp: stampSchema,
    value,
  });

export const entrySchema = z.union([
  entryFor("text", textSchema),
  entryFor("title", titleSchema),
  entryFor("color", colorSchema),
  entryFor("place", placeSchema),
  entryFor("group", entityIdSchema.nullable()),
  entryFor("assignee", guestIdSchema.nullable()),
  entryFor("deleted", z.boolean()),
  entryFor("done", z.boolean()),
]);

export const createdSchema = z.object({ id: entityIdSchema, kind: kindSchema });
export const supersedeSchema = z.object({ key: keySchema, dot: dotSchema });
export const voteSchema = z.object({
  dot: dotSchema,
  user: z.string().min(1).max(128),
  target: entityIdSchema,
});
export const unvoteSchema = z.object({ dot: dotSchema, target: entityIdSchema });

/** Любая дельта или состояние (от сервера: снапшот, broadcast). */
export const wireDeltaSchema: z.ZodType<WireDelta> = z.object({
  created: z.array(createdSchema),
  entries: z.array(entrySchema),
  supersedes: z.array(supersedeSchema),
  votes: z.array(voteSchema),
  unvotes: z.array(unvoteSchema),
});

const dotString = (dot: { actor: string; counter: number }) => `${dot.actor}:${dot.counter}`;

/**
 * Идентичность одной операции: dot записей, голоса, созданной сущности.
 * Отзыв голоса собственного dot не имеет — его идентичность = dot отзываемого голоса.
 */
const operationDots = (delta: WireDelta): Set<string> =>
  new Set([
    ...delta.created.map((created) => created.id),
    ...delta.entries.map((entry) => dotString(entry.dot)),
    ...delta.votes.map((vote) => dotString(vote.dot)),
    ...delta.unvotes.map((unvote) => dotString(unvote.dot)),
  ]);

/**
 * Единственный dot операции в дельте от клиента (гарантировано ровно один —
 * `clientDeltaSchema` ниже). Используется сервером (T-009) для `ack.dot`:
 * для `unvote` это dot **отзываемого голоса** (`unvoteSchema.dot`), не
 * свежий dot самой операции отзыва — `unvote` его не имеет (T-002,
 * `packages/crdt`, `unvote` не тикает часы). Это годится для `ack`: клиент
 * сам прислал именно этот dot и по нему же сопоставит ответ со своей
 * очередью. Не путать с ключом идемпотентности журнала операций
 * (`AppendOpParams.dot` в `apps/server/src/ops/log.ts`) — там для `unvote`
 * осознанно `null` по другой причине (см. JSDoc там).
 */
export function operationDot(delta: WireDelta): Dot {
  const [entry] = delta.entries;
  if (entry) return entry.dot;
  const [vote] = delta.votes;
  if (vote) return vote.dot;
  const [unvote] = delta.unvotes;
  if (unvote) return unvote.dot;
  throw new Error("operationDot: delta has no operation (empty created/entries/votes/unvotes)");
}

/** Метка операции, если есть — у `vote`/`unvote` её нет (§ 3.1, 2P-set). */
export function operationLamport(delta: WireDelta): number | null {
  return delta.entries[0]?.stamp.lamport ?? null;
}

/** Дельта от клиента: ровно одна операция и лимиты размера (V2). */
export const clientDeltaSchema = z
  .object({
    created: z.array(createdSchema).max(1),
    entries: z.array(entrySchema).max(LIMITS.entriesPerDelta),
    supersedes: z.array(supersedeSchema).max(LIMITS.supersedesPerDelta),
    votes: z.array(voteSchema).max(1),
    unvotes: z.array(unvoteSchema).max(1),
  })
  .refine((delta) => operationDots(delta).size === 1, "delta must contain exactly one operation")
  .refine(
    (delta) => delta.unvotes.length === 0 || delta.entries.length + delta.votes.length === 0,
    "unvote must not be combined with other elements",
  )
  .refine(
    (delta) =>
      delta.supersedes.every((supersede) =>
        delta.entries.some(
          (entry) =>
            entry.key.entity === supersede.key.entity && entry.key.field === supersede.key.field,
        ),
      ),
    "every supersede must refer to the cell written by this delta",
  );
