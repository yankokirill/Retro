// REST API — docs/spec/protocol.md § 7.
import { z } from "zod";
import {
  boardIdSchema,
  columnSchema,
  displayNameSchema,
  entityIdSchema,
  guestIdSchema,
  LIMITS,
  titleSchema,
} from "./wire.js";

export const GUEST_ID_HEADER = "x-guest-id";

export const createBoardRequestSchema = z.object({
  title: titleSchema,
  displayName: displayNameSchema,
  voteLimit: z.number().int().min(LIMITS.voteLimit.min).max(LIMITS.voteLimit.max).optional(),
});

export const createBoardResponseSchema = z.object({ boardId: boardIdSchema });

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
export type DeleteBoardRequest = z.infer<typeof deleteBoardRequestSchema>;
export type ExportResponse = z.infer<typeof exportResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
