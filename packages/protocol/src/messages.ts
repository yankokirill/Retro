// WebSocket-сообщения — docs/spec/protocol.md § 4–5.
import { z } from "zod";
import {
  actorIdSchema,
  boardIdSchema,
  clientDeltaSchema,
  displayNameSchema,
  dotSchema,
  entityIdSchema,
  guestIdSchema,
  LIMITS,
  titleSchema,
  wireDeltaSchema,
} from "./wire.js";

export const PROTOCOL_VERSION = 1;

export const phaseSchema = z.enum(["collect", "group", "vote", "discuss", "actions"]);
export const roleSchema = z.enum(["owner", "facilitator", "participant", "viewer"]);

export const rejectReasonSchema = z.enum([
  "stale_dot",
  "invalid_shape",
  "unknown_target",
  "unjustified_supersede",
  "invalid_stamp",
  "forbidden",
  "wrong_phase",
  "vote_limit",
  "not_own_vote",
  "irreversible_phase",
  "rate_limited",
  "too_large",
]);

const seqSchema = z.number().int().positive();

// Клиент → сервер

export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setPhase"), phase: phaseSchema }),
  z.object({ type: z.literal("grantFacilitator"), guestId: guestIdSchema }),
  z.object({ type: z.literal("resetVotes") }),
  z.object({
    type: z.literal("startTimer"),
    seconds: z.number().int().min(LIMITS.timerSeconds.min).max(LIMITS.timerSeconds.max),
  }),
  z.object({ type: z.literal("stopTimer") }),
]);

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocol: z.literal(PROTOCOL_VERSION),
    guestId: guestIdSchema,
    displayName: displayNameSchema,
    actorId: actorIdSchema,
    lastSeq: z.number().int().nonnegative().nullable(),
  }),
  z.object({ type: z.literal("op"), delta: clientDeltaSchema }),
  z.object({
    type: z.literal("command"),
    id: z.string().min(1).max(64),
    command: commandSchema,
  }),
]);

// Сервер → клиент

export const boardMetaSchema = z.object({
  boardId: boardIdSchema,
  title: titleSchema,
  phase: phaseSchema,
  revealed: z.boolean(),
  voteLimit: z.number().int().min(LIMITS.voteLimit.min).max(LIMITS.voteLimit.max),
  timer: z.object({ endsAt: z.iso.datetime() }).nullable(),
  authors: z.record(entityIdSchema, displayNameSchema),
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    role: roleSchema,
    voterToken: z.string().min(1).max(128),
    meta: boardMetaSchema,
    snapshot: z
      .object({ upToSeq: z.number().int().nonnegative(), state: wireDeltaSchema })
      .nullable(),
    ops: z.array(z.object({ seq: seqSchema, delta: wireDeltaSchema })),
  }),
  z.object({ type: z.literal("ack"), dot: dotSchema, seq: seqSchema }),
  z.object({
    type: z.literal("reject"),
    dot: dotSchema,
    reason: rejectReasonSchema,
    message: z.string(),
  }),
  z.object({ type: z.literal("op"), seq: seqSchema, delta: wireDeltaSchema }),
  z.object({ type: z.literal("meta"), meta: boardMetaSchema }),
  z.object({
    type: z.literal("commandResult"),
    id: z.string().min(1).max(64),
    ok: z.boolean(),
    reason: rejectReasonSchema.optional(),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal("error"), reason: rejectReasonSchema, message: z.string() }),
]);

export type Phase = z.infer<typeof phaseSchema>;
export type Role = z.infer<typeof roleSchema>;
export type RejectReason = z.infer<typeof rejectReasonSchema>;
export type Command = z.infer<typeof commandSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type BoardMeta = z.infer<typeof boardMetaSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
