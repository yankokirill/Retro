// @vitest-environment jsdom
// T-015 § 5 — AddStickerForm. REQ-005.

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddStickerForm } from "../src/ui/AddStickerForm.js";

afterEach(cleanup);

describe("AddStickerForm", () => {
  it("REQ-005: ввод текста и Добавить вызывают onAdd(text, color), поле очищается", async () => {
    const onAdd = vi.fn();
    render(<AddStickerForm onAdd={onAdd} />);
    const box = screen.getByLabelText("Новый стикер") as HTMLTextAreaElement;
    await userEvent.type(box, "Идея");
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0]?.[0]).toBe("Идея");
    expect(typeof onAdd.mock.calls[0]?.[1]).toBe("string");
    expect(box.value).toBe("");
  });

  it("REQ-005: выбранный цвет передаётся в onAdd", async () => {
    const onAdd = vi.fn();
    render(<AddStickerForm onAdd={onAdd} />);
    await userEvent.click(screen.getByRole("button", { name: "Цвет: blue" }));
    await userEvent.type(screen.getByLabelText("Новый стикер"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    expect(onAdd).toHaveBeenCalledWith("x", "blue");
  });

  it("REQ-005: пять кнопок цвета", () => {
    render(<AddStickerForm onAdd={() => {}} />);
    for (const c of ["yellow", "green", "blue", "pink", "purple"]) {
      expect(screen.getByRole("button", { name: `Цвет: ${c}` })).toBeTruthy();
    }
  });

  it("REQ-005: пустой и пробельный текст — onAdd не вызывается, показан role=alert", async () => {
    const onAdd = vi.fn();
    render(<AddStickerForm onAdd={onAdd} />);
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent?.trim().length).toBeGreaterThan(0);
    await userEvent.type(screen.getByLabelText("Новый стикер"), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    expect(onAdd).not.toHaveBeenCalled();
  });
});
