// @vitest-environment jsdom
// T-018 § 4 — TimerPanel. REQ-019 кр.2 (рекомендательный таймер обсуждения).

import type { Phase, Role } from "@retro/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimerPanel } from "../src/ui/TimerPanel.js";

afterEach(cleanup);

const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const endsIn = (ms: number) => ({ endsAt: new Date(NOW + ms).toISOString() });

function setup(over: {
  phase?: Phase;
  timer?: { endsAt: string } | null;
  role?: Role | null;
  now?: number;
}) {
  const onStart = vi.fn();
  const onStop = vi.fn();
  const view = render(
    <TimerPanel
      phase={over.phase ?? "discuss"}
      timer={over.timer ?? null}
      role={"role" in over ? (over.role as Role | null) : "owner"}
      now={over.now ?? NOW}
      onStart={onStart}
      onStop={onStop}
    />,
  );
  return { onStart, onStop, container: view.container };
}

describe("TimerPanel", () => {
  for (const phase of ["collect", "group", "vote", "actions"] as Phase[]) {
    it(`REQ-019: в фазе ${phase} ничего не рендерится`, () => {
      const { container } = setup({ phase, timer: endsIn(60_000) });
      expect(container.innerHTML).toBe("");
    });
  }

  it("REQ-019: в discuss с таймером — role=timer с остатком mm:ss", () => {
    setup({ timer: endsIn(65_000), role: "participant" });
    expect(screen.getByRole("timer").textContent).toContain("01:05");
  });

  it("REQ-019: остаток округляется вверх до секунды", () => {
    setup({ timer: endsIn(65_100), role: "participant" });
    expect(screen.getByRole("timer").textContent).toContain("01:06");
  });

  it("REQ-019: длинный остаток — 05:00 и 59:59", () => {
    setup({ timer: endsIn(300_000), role: "viewer" });
    expect(screen.getByRole("timer").textContent).toContain("05:00");
    cleanup();
    setup({ timer: endsIn(3_599_000), role: "viewer" });
    expect(screen.getByRole("timer").textContent).toContain("59:59");
  });

  it("REQ-019: время вышло — «Время вышло» в role=status, кнопок смены фазы нет", () => {
    setup({ timer: endsIn(-1_000), role: "participant" });
    expect(screen.getByRole("status").textContent).toContain("Время вышло");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("REQ-019: остаток ровно 0 — «Время вышло»", () => {
    setup({ timer: endsIn(0), role: "participant" });
    expect(screen.getByRole("status").textContent).toContain("Время вышло");
  });

  it("REQ-019: пока время не вышло, «Время вышло» нет", () => {
    setup({ timer: endsIn(5_000), role: "participant" });
    expect(screen.queryByText("Время вышло")).toBeNull();
  });

  it("REQ-019: без таймера — «Таймер не запущен»", () => {
    setup({ timer: null, role: "participant" });
    expect(screen.getByText("Таймер не запущен")).toBeTruthy();
    expect(screen.queryByRole("timer")).toBeNull();
  });

  for (const role of ["participant", "viewer", null] as const) {
    it(`REQ-019: роль ${role} — только показ, ни кнопок, ни поля минут`, () => {
      setup({ timer: endsIn(60_000), role });
      expect(screen.queryAllByRole("button")).toHaveLength(0);
      expect(screen.queryByLabelText("Минуты")).toBeNull();
    });
  }

  for (const role of ["owner", "facilitator"] as const) {
    it(`REQ-019: ${role} — поле минут (по умолчанию 5) и «Запустить таймер» → onStart(300)`, async () => {
      const { onStart } = setup({ role });
      const input = screen.getByLabelText("Минуты") as HTMLInputElement;
      expect(input.type).toBe("number");
      expect(input.value).toBe("5");
      await userEvent.click(screen.getByRole("button", { name: "Запустить таймер" }));
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onStart).toHaveBeenCalledWith(300);
    });
  }

  it("REQ-019: минуты переводятся в секунды (10 мин → 600)", async () => {
    const { onStart } = setup({ role: "owner" });
    fireEvent.change(screen.getByLabelText("Минуты"), { target: { value: "10" } });
    await userEvent.click(screen.getByRole("button", { name: "Запустить таймер" }));
    expect(onStart).toHaveBeenCalledWith(600);
  });

  it("REQ-019: без таймера кнопки «Остановить таймер» нет", () => {
    setup({ role: "owner", timer: null });
    expect(screen.queryByRole("button", { name: "Остановить таймер" })).toBeNull();
  });

  it("REQ-019: при идущем таймере «Остановить таймер» → onStop()", async () => {
    const { onStop, onStart } = setup({ role: "facilitator", timer: endsIn(60_000) });
    await userEvent.click(screen.getByRole("button", { name: "Остановить таймер" }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("REQ-019: при истёкшем таймере «Остановить таймер» доступна, смены фазы нет", async () => {
    const { onStop } = setup({ role: "owner", timer: endsIn(-5_000) });
    expect(screen.getByRole("status").textContent).toContain("Время вышло");
    await userEvent.click(screen.getByRole("button", { name: "Остановить таймер" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
