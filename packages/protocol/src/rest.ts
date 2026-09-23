// REST API — docs/spec/protocol.md § 7.
import { z } from "zod";
import { boardMetaSchema, roleSchema } from "./messages.js";
import {
  boardIdSchema,
  columnSchema,
  displayNameSchema,
  entityIdSchema,
  guestIdSchema,
  LIMITS,
  linkTokenSchema,
  titleSchema,
} from "./wire.js";

export const GUEST_ID_HEADER = "x-guest-id";

export const createBoardRequestSchema = z.object({
  title: titleSchema,
  displayName: displayNameSchema,
  voteLimit: z.number().int().min(LIMITS.voteLimit.min).max(LIMITS.voteLimit.max).optional(),
});

/** ADR-0007: создатель — сразу owner, остальные роли — по одной из двух ссылок. */
export const createBoardResponseSchema = z.object({
  boardId: boardIdSchema,
  participantLink: linkTokenSchema,
  viewerLink: linkTokenSchema,
});

/** `GET /api/boards/join/:linkToken` (ADR-0007, REQ-002 кр. 5–7). */
export const joinBoardResponseSchema = z.object({
  boardId: boardIdSchema,
  role: roleSchema,
});

/** `GET /api/boards/:boardId` — `BoardMeta` + собственная роль запросившего (не часть `meta`, см. `welcome` в § 5). */
export const getBoardResponseSchema = boardMetaSchema.extend({ role: roleSchema });

/** `GET /api/boards/:boardId/members` — T-018, `protocol.md` § 7. */
export const membersResponseSchema = z.object({
  members: z.array(z.object({ guestId: z.string(), displayName: z.string(), role: roleSchema })),
});

export const deleteBoardRequestSchema = z.object({ confirm: boardIdSchema });

const exportCardSchema = z.object({
  id: entityIdSchema,
  text: z.array(z.string()),
  author: displayNameSchema,
  votes: z.number().int().nonnegative(),
});

export const exportResponseSchema = z.object({
  columns: z.record(
    columnSchema,
    z.array(
      z.union([
        z.object({ kind: z.literal("sticker"), card: exportCardSchema }),
        z.object({
          kind: z.literal("group"),
          id: entityIdSchema,
          title: z.array(z.string()),
          votes: z.number().int().nonnegative(),
          cards: z.array(exportCardSchema),
        }),
      ]),
    ),
  ),
  actionItems: z.array(
    z.object({
      id: entityIdSchema,
      text: z.array(z.string()),
      assignee: guestIdSchema.nullable(),
      done: z.boolean(),
    }),
  ),
});

export const errorResponseSchema = z.object({ error: z.string(), message: z.string() });

export type CreateBoardRequest = z.infer<typeof createBoardRequestSchema>;
export type CreateBoardResponse = z.infer<typeof createBoardResponseSchema>;
export type JoinBoardResponse = z.infer<typeof joinBoardResponseSchema>;
export type GetBoardResponse = z.infer<typeof getBoardResponseSchema>;
export type MembersResponse = z.infer<typeof membersResponseSchema>;
export type DeleteBoardRequest = z.infer<typeof deleteBoardRequestSchema>;
export type ExportResponse = z.infer<typeof exportResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
