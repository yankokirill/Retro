// @vitest-environment jsdom
// T-018 § 4 — PhaseBar. REQ-004 кр.3 (переходы фаз), кр.2 (collect необратим).

import type { Phase, Role } from "@retro/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhaseBar } from "../src/ui/PhaseBar.js";

afterEach(cleanup);

const NAMES: Record<Phase, string> = {
  collect: "Сбор",
  group: "Группировка",
  vote: "Голосование",
  discuss: "Обсуждение",
  actions: "Действия",
};
const PHASES = Object.keys(NAMES) as Phase[];

function setup(phase: Phase, role: Role | null) {
  const onSetPhase = vi.fn();
  render(<PhaseBar phase={phase} role={role} onSetPhase={onSetPhase} />);
  return { onSetPhase };
}

describe("PhaseBar", () => {
  for (const phase of PHASES) {
    it(`REQ-004: текущая фаза ${phase} показана в role=status русским названием`, () => {
      setup(phase, "participant");
      expect(screen.getByRole("status").textContent).toBe(NAMES[phase]);
    });
  }

  for (const role of ["participant", "viewer", null] as const) {
    it(`REQ-004: роль ${role} — только текст фазы, кнопок нет`, () => {
      setup("group", role);
      expect(screen.queryAllByRole("button")).toHaveLength(0);
      expect(screen.getByRole("status").textContent).toBe("Группировка");
    });
  }

  for (const role of ["owner", "facilitator"] as const) {
    it(`REQ-004: ${role} видит кнопки всех фаз; текущая — aria-current=step и disabled`, () => {
      setup("vote", role);
      for (const phase of PHASES) {
        expect(screen.getByRole("button", { name: NAMES[phase] })).toBeTruthy();
      }
      const current = screen.getByRole("button", { name: "Голосование" }) as HTMLButtonElement;
      expect(current.getAttribute("aria-current")).toBe("step");
      expect(current.disabled).toBe(true);
      expect(
        screen.getByRole("button", { name: "Группировка" }).getAttribute("aria-current"),
      ).toBeNull();
    });
  }

  it("REQ-004 кр.3: переходы между group/vote/discuss/actions в любом порядке — сразу, без диалога", async () => {
    const seq: Phase[] = ["group", "vote", "discuss", "actions", "discuss", "vote", "group"];
    for (const from of seq) {
      for (const to of seq) {
        if (from === to) continue;
        const { onSetPhase } = setup(from, "owner");
        await userEvent.click(screen.getByRole("button", { name: NAMES[to] }));
        expect(onSetPhase).toHaveBeenCalledTimes(1);
        expect(onSetPhase).toHaveBeenCalledWith(to);
        expect(screen.queryByRole("alertdialog")).toBeNull();
        cleanup();
      }
    }
  });

  it("REQ-004 кр.2: «Сбор» disabled вне collect", () => {
    for (const phase of ["group", "vote", "discuss", "actions"] as Phase[]) {
      setup(phase, "facilitator");
      expect((screen.getByRole("button", { name: "Сбор" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      cleanup();
    }
  });

  it("REQ-004: клик по «Сбор» вне collect не вызывает onSetPhase", async () => {
    const { onSetPhase } = setup("vote", "owner");
    await userEvent.click(screen.getByRole("button", { name: "Сбор" }));
    expect(onSetPhase).not.toHaveBeenCalled();
  });

  it("REQ-004: уход из collect — диалог, onSetPhase не вызван до подтверждения", async () => {
    const { onSetPhase } = setup("collect", "owner");
    await userEvent.click(screen.getByRole("button", { name: "Группировка" }));
    expect(onSetPhase).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Раскрыть стикеры и их авторов? Это необратимо");
  });

  it("REQ-004: «Подтвердить» вызывает onSetPhase(выбранная) и закрывает диалог", async () => {
    const { onSetPhase } = setup("collect", "facilitator");
    await userEvent.click(screen.getByRole("button", { name: "Голосование" }));
    await userEvent.click(screen.getByRole("button", { name: "Подтвердить" }));
    expect(onSetPhase).toHaveBeenCalledTimes(1);
    expect(onSetPhase).toHaveBeenCalledWith("vote");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("REQ-004: «Отмена» закрывает диалог без вызова onSetPhase", async () => {
    const { onSetPhase } = setup("collect", "owner");
    await userEvent.click(screen.getByRole("button", { name: "Действия" }));
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onSetPhase).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("REQ-004: диалога нет, пока фаза не выбрана", () => {
    setup("collect", "owner");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
