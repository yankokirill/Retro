// T-018 § 3 — describeRejection знает unknown_target явно. REQ-003 кр.2.

import type { RejectReason } from "@retro/protocol";
import { describe, expect, it } from "vitest";
import { describeRejection } from "../src/messages.js";

describe("describeRejection: T-018", () => {
  it("REQ-003: unknown_target — непустая фраза, отличная от общей", () => {
    const text = describeRejection("unknown_target");
    const generic = describeRejection("brand_new" as RejectReason);
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).not.toBe(generic);
  });

  it("REQ-004: irreversible_phase и wrong_phase различаются между собой и с forbidden", () => {
    const set = new Set(
      ["irreversible_phase", "wrong_phase", "forbidden", "unknown_target"].map((r) =>
        describeRejection(r as RejectReason),
      ),
    );
    expect(set.size).toBe(4);
  });
});
