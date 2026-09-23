// @vitest-environment jsdom
// T-018 § 4 — FacilitatorPanel. REQ-003 кр.2 (owner назначает фасилитатора).

import type { Role } from "@retro/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FacilitatorPanel } from "../src/ui/FacilitatorPanel.js";

afterEach(cleanup);

const m = (guestId: string, displayName: string, role: Role) => ({ guestId, displayName, role });

function setup(members: ReturnType<typeof m>[]) {
  const onGrant = vi.fn();
  const view = render(<FacilitatorPanel members={members} onGrant={onGrant} />);
  return { onGrant, container: view.container };
}

describe("FacilitatorPanel", () => {
  it("REQ-003: секция «Участники», по <li> на участника с именем и ролью словами", () => {
    setup([
      m("g1", "Оля", "owner"),
      m("g2", "Фаня", "facilitator"),
      m("g3", "Аня", "participant"),
      m("g4", "Боря", "viewer"),
    ]);
    const section = screen.getByRole("region", { name: "Участники" });
    const items = within(section).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    const expected: [string, string][] = [
      ["Оля", "Владелец"],
      ["Фаня", "Фасилитатор"],
      ["Аня", "Участник"],
      ["Боря", "Наблюдатель"],
    ];
    for (const [i, [name, role]] of expected.entries()) {
      expect(items[i]?.textContent).toContain(name);
      expect(items[i]?.textContent).toContain(role);
    }
  });

  it("REQ-003: кнопка назначения только у participant и viewer", () => {
    setup([
      m("g1", "Оля", "owner"),
      m("g2", "Фаня", "facilitator"),
      m("g3", "Аня", "participant"),
      m("g4", "Боря", "viewer"),
    ]);
    expect(screen.queryByRole("button", { name: "Назначить фасилитатором: Оля" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Назначить фасилитатором: Фаня" })).toBeNull();
    expect(screen.getByRole("button", { name: "Назначить фасилитатором: Аня" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Назначить фасилитатором: Боря" })).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("REQ-003: клик вызывает onGrant с guestId именно этого участника", async () => {
    const { onGrant } = setup([
      m("g1", "Оля", "owner"),
      m("g3", "Аня", "participant"),
      m("g4", "Боря", "viewer"),
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Назначить фасилитатором: Боря" }));
    expect(onGrant).toHaveBeenCalledTimes(1);
    expect(onGrant).toHaveBeenCalledWith("g4");
  });

  it("REQ-003: XSS — имя с HTML рендерится текстом, элементов не создаёт", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const { container } = setup([m("g3", payload, "participant")]);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("listitem").textContent).toContain(payload);
  });

  it("REQ-003: пустой список — секция есть, кнопок нет", () => {
    setup([]);
    expect(screen.getByRole("region", { name: "Участники" })).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
