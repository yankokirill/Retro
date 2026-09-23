// T-015 § 4 — REQ-024 кр. 2 (причины отказа для пользователя).

import { type RejectReason, rejectReasonSchema } from "@retro/protocol";
import { describe, expect, it } from "vitest";
import { describeRejection } from "../src/messages.js";

describe("describeRejection", () => {
  for (const reason of rejectReasonSchema.options) {
    it(`REQ-024: непустая фраза для причины ${reason}`, () => {
      expect(describeRejection(reason).trim().length).toBeGreaterThan(0);
    });
  }

  it("REQ-024: неизвестная причина — общая непустая фраза", () => {
    expect(describeRejection("brand_new" as RejectReason).trim().length).toBeGreaterThan(0);
  });

  it("REQ-024: фразы для forbidden, wrong_phase и vote_limit различаются", () => {
    const set = new Set(
      ["forbidden", "wrong_phase", "vote_limit"].map((r) => describeRejection(r as RejectReason)),
    );
    expect(set.size).toBe(3);
  });
});
