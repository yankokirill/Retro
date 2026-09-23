// T-015 § 2 — маршруты SPA.

import { describe, expect, it } from "vitest";
import { boardPath, joinPath, parseRoute } from "../src/route.js";

const ID = "22222222-2222-4222-8222-222222222222";

describe("route", () => {
  it("REQ-001: / — главная", () => {
    expect(parseRoute("/")).toEqual({ name: "home" });
  });

  it("REQ-002: /j/<token> — вход по ссылке, хвостовой / допустим", () => {
    expect(parseRoute(`/j/${ID}`)).toEqual({ name: "join", linkToken: ID });
    expect(parseRoute(`/j/${ID}/`)).toEqual({ name: "join", linkToken: ID });
  });

  it("REQ-005: /b/<uuid> — доска", () => {
    expect(parseRoute(`/b/${ID}`)).toEqual({ name: "board", boardId: ID });
    expect(parseRoute(`/b/${ID}/`)).toEqual({ name: "board", boardId: ID });
  });

  it("REQ-005: прочее — notFound", () => {
    for (const p of ["/x", "/b/not-a-uuid", "/b/", "/j/", `/b/${ID}/extra`, "/api/boards"]) {
      expect(parseRoute(p)).toEqual({ name: "notFound" });
    }
  });

  it("REQ-005: boardPath/joinPath обратны parseRoute", () => {
    expect(parseRoute(boardPath(ID))).toEqual({ name: "board", boardId: ID });
    expect(parseRoute(joinPath(ID))).toEqual({ name: "join", linkToken: ID });
  });
});
