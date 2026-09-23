// @vitest-environment jsdom
// T-017 § 2 — VoteBudget. REQ-015 кр. 1, 4.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VoteBudget } from "../src/ui/VoteBudget.js";

afterEach(cleanup);

describe("VoteBudget", () => {
  it("REQ-015: показывает остаток и лимит в role=status", () => {
    render(<VoteBudget remaining={2} limit={5} />);
    const el = screen.getByRole("status", { name: "Оставшиеся голоса" });
    expect(el.textContent).toBe("Осталось голосов: 2 из 5");
  });

  it("REQ-015: нулевой остаток отображается как 0", () => {
    render(<VoteBudget remaining={0} limit={3} />);
    expect(screen.getByRole("status", { name: "Оставшиеся голоса" }).textContent).toBe(
      "Осталось голосов: 0 из 3",
    );
  });

  it("REQ-015: перерисовка с новым остатком обновляет текст", () => {
    const view = render(<VoteBudget remaining={3} limit={3} />);
    view.rerender(<VoteBudget remaining={2} limit={3} />);
    expect(screen.getByRole("status", { name: "Оставшиеся голоса" }).textContent).toBe(
      "Осталось голосов: 2 из 3",
    );
  });
});
