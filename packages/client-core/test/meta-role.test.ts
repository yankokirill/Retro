// T-030 (docs/design/T-030-meta-commands.md): `meta` может нести `role` —
// сервер так сообщает повышенному участнику (grantFacilitator, REQ-003 кр. 2–3).
// `receive(meta)`: если `role` есть, `snapshot.role := role`; `meta` заменяется
// целиком, как раньше.

import { describe, expect, it } from "vitest";
import { createSyncClient } from "../src/client.js";
import { makeConfig, makeMeta, makePorts, welcomeMessage } from "./fixtures.js";

/** Сырое сообщение `meta` с полем `role` — фикстура `metaMessage` его не умеет. */
function metaWithRole(meta: ReturnType<typeof makeMeta>, role?: string): string {
  return JSON.stringify({ type: "meta", meta, ...(role === undefined ? {} : { role }) });
}

function welcomed(role: "participant" | "viewer" | "facilitator" | "owner") {
  const meta = makeMeta({ phase: "discuss", revealed: true });
  const client = createSyncClient(makeConfig(), makePorts());
  client.connected();
  client.receive(welcomeMessage({ role, meta }));
  return { client, meta };
}

describe("meta.role", () => {
  it("REQ-003: receive(meta с role) обновляет snapshot.role", () => {
    const { client, meta } = welcomed("participant");
    expect(client.inspect().role).toBe("participant");

    client.receive(metaWithRole(meta, "facilitator"));

    expect(client.inspect().role).toBe("facilitator");
  });

  it("REQ-003: meta с role заменяет meta целиком, как и без role", () => {
    const { client, meta } = welcomed("participant");
    const next = { ...meta, timer: { endsAt: "2026-09-23T12:00:00.000Z" } };

    client.receive(metaWithRole(next, "facilitator"));

    expect(client.inspect().meta).toEqual(next);
  });

  it("REQ-003: meta без role роль не меняет", () => {
    const { client, meta } = welcomed("facilitator");

    client.receive(metaWithRole({ ...meta, phase: "actions" }));

    const snapshot = client.inspect();
    expect(snapshot.role).toBe("facilitator");
    expect(snapshot.meta?.phase).toBe("actions");
  });

  it("REQ-003: последующий welcome снова задаёт роль из сообщения", () => {
    const { client, meta } = welcomed("participant");
    client.receive(metaWithRole(meta, "facilitator"));

    client.disconnected();
    client.connected();
    client.receive(welcomeMessage({ role: "facilitator", meta }));

    expect(client.inspect().role).toBe("facilitator");
  });
});
