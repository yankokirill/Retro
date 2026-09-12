import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("GET /healthz", () => {
  it('отвечает 200 и {status: "ok"}, подтверждая, что сервис поднялся (веха В1)', async () => {
    const app = buildApp();

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("GET /", () => {
  it("отвечает 200, а не 404 — корень не должен выглядеть как упавший сервис", async () => {
    const app = buildApp();

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });
});
