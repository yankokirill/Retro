// REST-клиент — docs/spec/protocol.md § 7, docs/design/T-015-board-ui.md § 3.

import {
  type BoardMeta,
  createBoardResponseSchema,
  errorResponseSchema,
  GUEST_ID_HEADER,
  getBoardResponseSchema,
  joinBoardResponseSchema,
  type Role,
} from "@retro/protocol";
import type { z } from "zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Api {
  createBoard(input: {
    title: string;
    displayName: string;
    voteLimit?: number;
  }): Promise<z.infer<typeof createBoardResponseSchema>>;
  join(linkToken: string, displayName: string): Promise<{ boardId: string; role: Role }>;
  getBoard(boardId: string): Promise<(BoardMeta & { role: Role }) | null>;
}

export function createApi(deps: { fetch: typeof fetch; guestId: string }): Api {
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    return deps.fetch(path, {
      ...init,
      headers: { ...init.headers, [GUEST_ID_HEADER]: deps.guestId },
    });
  }

  async function failure(response: Response): Promise<ApiError> {
    const body = errorResponseSchema.safeParse(await response.json().catch(() => null));
    return body.success
      ? new ApiError(response.status, body.data.error, body.data.message)
      : new ApiError(response.status, "unknown", `HTTP ${response.status}`);
  }

  async function parse<S extends z.ZodType>(response: Response, schema: S): Promise<z.infer<S>> {
    if (!response.ok) throw await failure(response);
    return schema.parse(await response.json());
  }

  return {
    async createBoard(input) {
      const response = await call("/api/boards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return parse(response, createBoardResponseSchema);
    },
    async join(linkToken, displayName) {
      const query = `displayName=${encodeURIComponent(displayName)}`;
      const response = await call(`/api/boards/join/${encodeURIComponent(linkToken)}?${query}`);
      return parse(response, joinBoardResponseSchema);
    },
    async getBoard(boardId) {
      const response = await call(`/api/boards/${encodeURIComponent(boardId)}`);
      if (response.status === 404) return null;
      return parse(response, getBoardResponseSchema);
    },
  };
}
