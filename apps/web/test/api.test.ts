// T-015 § 3 — REST-клиент (поддельный fetch).

import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "../src/api.js";

const BOARD = "22222222-2222-4222-8222-222222222222";
const TOKEN_A = "33333333-3333-4333-8333-333333333333";
const TOKEN_B = "44444444-4444-4444-8444-444444444444";
const GUEST = "guest-1";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const headerOf = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers).get(name);

const meta = {
  boardId: BOARD,
  title: "Ретро",
  phase: "collect",
  revealed: false,
  voteLimit: 3,
  timer: null,
  authors: {},
  role: "owner",
};

describe("createApi", () => {
  it("REQ-001: createBoard — POST /api/boards, JSON, x-guest-id", async () => {
    const { calls, fetchFn } = fakeFetch(201, {
      boardId: BOARD,
      participantLink: TOKEN_A,
      viewerLink: TOKEN_B,
    });
    const api = createApi({ fetch: fetchFn, guestId: GUEST });
    const res = await api.createBoard({ title: "Ретро", displayName: "Аня", voteLimit: 5 });
    expect(res).toEqual({ boardId: BOARD, participantLink: TOKEN_A, viewerLink: TOKEN_B });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/api/boards");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(headerOf(calls[0]?.init, "x-guest-id")).toBe(GUEST);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      title: "Ретро",
      displayName: "Аня",
      voteLimit: 5,
    });
  });

  it("REQ-002: join — GET /api/boards/join/<token>?displayName=<encoded>", async () => {
    const { calls, fetchFn } = fakeFetch(200, { boardId: BOARD, role: "participant" });
    const api = createApi({ fetch: fetchFn, guestId: GUEST });
    const res = await api.join(TOKEN_A, "Аня & Ко");
    expect(res).toEqual({ boardId: BOARD, role: "participant" });
    expect(calls[0]?.url).toContain(`/api/boards/join/${TOKEN_A}`);
    expect(calls[0]?.url).toContain(`displayName=${encodeURIComponent("Аня & Ко")}`);
    expect(headerOf(calls[0]?.init, "x-guest-id")).toBe(GUEST);
  });

  it("REQ-005: getBoard — мета с ролью", async () => {
    const { calls, fetchFn } = fakeFetch(200, meta);
    const api = createApi({ fetch: fetchFn, guestId: GUEST });
    expect(await api.getBoard(BOARD)).toEqual(meta);
    expect(calls[0]?.url).toContain(`/api/boards/${BOARD}`);
    expect(headerOf(calls[0]?.init, "x-guest-id")).toBe(GUEST);
  });

  it("REQ-002: getBoard 404 → null", async () => {
    const { fetchFn } = fakeFetch(404, { error: "not_found", message: "нет" });
    const api = createApi({ fetch: fetchFn, guestId: GUEST });
    expect(await api.getBoard(BOARD)).toBeNull();
  });

  it("REQ-002: не 2xx → ApiError со status/error/message из ErrorResponse", async () => {
    const { fetchFn } = fakeFetch(403, { error: "forbidden", message: "нельзя" });
    const api = createApi({ fetch: fetchFn, guestId: GUEST });
    const err = await api.join(TOKEN_A, "Аня").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, error: "forbidden", message: "нельзя" });
  });

  it("REQ-002: не 2xx с телом не по схеме → ApiError с error 'unknown'", async () => {
    const { fetchFn } = fakeFetch(500, "<html>oops</html>");
    const api = createApi({ fetch: fetchFn, guestId: GUEST });
    const err = await api.getBoard(BOARD).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 500, error: "unknown" });
  });

  it("REQ-001: ответ 2xx не по схеме — ошибка", async () => {
    const { fetchFn } = fakeFetch(201, { boardId: "не-uuid" });
    const api = createApi({ fetch: fetchFn, guestId: GUEST });
    await expect(api.createBoard({ title: "Ретро", displayName: "Аня" })).rejects.toBeDefined();
  });
});
