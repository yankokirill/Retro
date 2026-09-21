// § 9.3 — отчёт о нарушении объясняет расхождение, а не только называет свойство: для S4 в
// `violation.detail` лежит клиент и что у него отсутствует и что лишнее относительно proj_u(X_S).

import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config.js";
import { mutantHooks } from "../src/mutants.js";
import { runSimulation } from "../src/run.js";

describe("§ 9.3: клиент-специфичное различие в отчёте о нарушении", () => {
  it("§ 9.3: S4 (мутант M7 — пустой хвост welcome) несёт клиента, его актора и чего не хватает в X_c", async () => {
    const built = buildConfig({ seed: 1, clients: 5, ops: 300, profile: "default" });
    if (!built.ok) throw new Error(built.error);
    const run = await runSimulation(built.config, { hooks: mutantHooks("M7") });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.violation.property).toBe("S4");

    const detail = run.violation.detail as {
      client: number;
      guest: string;
      role: string;
      actor: string;
      connections: number[];
      missingInClient: { createdCount: number; created: string[]; entries: number };
      extraInClient: { createdCount: number; entries: number };
    };
    expect(detail.client).toBeGreaterThanOrEqual(0);
    expect(detail.guest).toMatch(/^[0-9a-f-]{36}$/);
    expect(["owner", "facilitator", "participant", "viewer"]).toContain(detail.role);
    expect(detail.actor).toMatch(/^[0-9a-f-]{36}$/);
    expect(detail.connections.length).toBeGreaterThan(0);
    // M7 отдаёт пустой хвост: клиент не получил чужие сущности — не хватает, лишнего нет.
    expect(detail.missingInClient.createdCount).toBeGreaterThan(0);
    expect(detail.missingInClient.created.length).toBeLessThanOrEqual(5);
    expect(detail.missingInClient.entries).toBeGreaterThan(0);
    expect(detail.extraInClient.createdCount).toBe(0);
    expect(detail.extraInClient.entries).toBe(0);
  });
});
