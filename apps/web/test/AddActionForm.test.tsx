// @vitest-environment jsdom
// T-019 § 3 — AddActionForm. REQ-017 кр.1.

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddActionForm } from "../src/ui/AddActionForm.js";

afterEach(cleanup);

describe("AddActionForm", () => {
  it("REQ-017: ввод текста и «Добавить действие» вызывают onAdd(text), поле очищается", async () => {
    const onAdd = vi.fn();
    render(<AddActionForm onAdd={onAdd} />);
    const input = screen.getByLabelText("Новое действие") as HTMLTextAreaElement;
    await userEvent.type(input, "Позвонить клиенту");
    await userEvent.click(screen.getByRole("button", { name: "Добавить действие" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith("Позвонить клиенту");
    expect(input.value).toBe("");
  });

  it("REQ-017: пустое и пробельное значение — onAdd не вызывается, показан alert", async () => {
    const onAdd = vi.fn();
    render(<AddActionForm onAdd={onAdd} />);
    await userEvent.click(screen.getByRole("button", { name: "Добавить действие" }));
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();

    await userEvent.type(screen.getByLabelText("Новое действие"), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Добавить действие" }));
    expect(onAdd).not.toHaveBeenCalled();
  });
});
