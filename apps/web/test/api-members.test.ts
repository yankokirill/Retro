// T-018 § 3 — Api.listMembers. REQ-003 кр.2.

import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "../src/api.js";

const BOARD = "22222222-2222-4222-8222-222222222222";
const GUEST = "guest-1";

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const members = [
  { guestId: "11111111-1111-4111-8111-111111111111", displayName: "Оля", role: "owner" },
  { guestId: "33333333-3333-4333-8333-333333333333", displayName: "Аня", role: "participant" },
];

describe("Api.listMembers", () => {
  it("REQ-003: GET /api/boards/<id>/members с x-guest-id, возвращает массив участников", async () => {
    const { calls, fetchFn } = fakeFetch(200, { members });
    const api = createApi({ fetch: fetchFn, guestId: GUEST });
    expect(await api.listMembers(BOARD)).toEqual(members);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain(`/api/boards/${BOARD}/members`);
    expect(new Headers(calls[0]?.init?.headers).get("x-guest-id")).toBe(GUEST);
  });

  it("REQ-003: 403 — ApiError со status и error", async () => {
    const { fetchFn } = fakeFetch(403, { error: "forbidden", message: "нельзя" });
    const api = createApi({ fetch: fetchFn, guestId: GUEST });
    const err = await api.listMembers(BOARD).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, error: "forbidden" });
  });

  it("REQ-003: 404 — ApiError (не null)", async () => {
    const { fetchFn } = fakeFetch(404, { error: "not_found", message: "нет" });
    const api = createApi({ fetch: fetchFn, guestId: GUEST });
    const err = await api.listMembers(BOARD).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404 });
  });

  it("REQ-003: ответ 2xx не по схеме — ошибка", async () => {
    const { fetchFn } = fakeFetch(200, { members: [{ guestId: "x" }] });
    const api = createApi({ fetch: fetchFn, guestId: GUEST });
    await expect(api.listMembers(BOARD)).rejects.toBeDefined();
  });
});
