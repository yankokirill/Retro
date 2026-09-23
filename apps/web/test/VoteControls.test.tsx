// @vitest-environment jsdom
// T-017 § 2 — VoteControls. REQ-015 кр. 1, 3, 4, 5.

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoteControls } from "../src/ui/VoteControls.js";

afterEach(cleanup);

function setup(over: Partial<Parameters<typeof VoteControls>[0]> = {}) {
  const onVote = vi.fn();
  const onUnvote = vi.fn();
  const view = render(
    <VoteControls
      total={4}
      mine={0}
      remaining={2}
      interactive
      onVote={onVote}
      onUnvote={onUnvote}
      {...over}
    />,
  );
  return { onVote, onUnvote, container: view.container };
}

describe("VoteControls", () => {
  it("REQ-015: кр. 5 — корень с aria-label 'Голоса' и суммарным числом", () => {
    const { container } = setup({ total: 4 });
    expect(screen.getByLabelText("Голоса")).toBeTruthy();
    expect(container.querySelector("[data-total]")?.textContent).toBe("Голоса: 4");
  });

  it("REQ-015: кр. 5 — 'Мои' не показываются при mine = 0", () => {
    const { container } = setup({ mine: 0 });
    expect(container.querySelector("[data-mine]")).toBeNull();
  });

  it("REQ-015: кр. 5 — при mine > 0 показано 'Мои: N'", () => {
    const { container } = setup({ mine: 2 });
    expect(container.querySelector("[data-mine]")?.textContent).toBe("Мои: 2");
  });

  it("REQ-015: кр. 1 — клик 'Отдать голос' вызывает onVote", async () => {
    const { onVote, onUnvote } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Отдать голос" }));
    expect(onVote).toHaveBeenCalledTimes(1);
    expect(onUnvote).not.toHaveBeenCalled();
  });

  it("REQ-015: кр. 4 — клик 'Отозвать голос' вызывает onUnvote при mine > 0", async () => {
    const { onVote, onUnvote } = setup({ mine: 1 });
    await userEvent.click(screen.getByRole("button", { name: "Отозвать голос" }));
    expect(onUnvote).toHaveBeenCalledTimes(1);
    expect(onVote).not.toHaveBeenCalled();
  });

  it("REQ-015: 'Отдать голос' disabled при remaining <= 0, клик не вызывает onVote", async () => {
    const { onVote } = setup({ remaining: 0 });
    const btn = screen.getByRole("button", { name: "Отдать голос" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await userEvent.click(btn);
    expect(onVote).not.toHaveBeenCalled();
  });

  it("REQ-015: 'Отдать голос' доступна при remaining > 0", () => {
    setup({ remaining: 1 });
    expect(
      (screen.getByRole("button", { name: "Отдать голос" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("REQ-015: 'Отозвать голос' disabled при mine = 0", async () => {
    const { onUnvote } = setup({ mine: 0 });
    const btn = screen.getByRole("button", { name: "Отозвать голос" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await userEvent.click(btn);
    expect(onUnvote).not.toHaveBeenCalled();
  });

  it("REQ-015: не interactive — ни одной кнопки, суммы видны", () => {
    const { container } = setup({ interactive: false, mine: 1 });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(container.querySelector("[data-total]")?.textContent).toBe("Голоса: 4");
    expect(container.querySelector("[data-mine]")?.textContent).toBe("Мои: 1");
  });
});
