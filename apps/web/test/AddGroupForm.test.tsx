// @vitest-environment jsdom
// T-016 § 3 — AddGroupForm. REQ-012.

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddGroupForm } from "../src/ui/AddGroupForm.js";

afterEach(cleanup);

describe("AddGroupForm", () => {
  it("REQ-012: ввод названия и «Создать группу» вызывают onAdd(title), поле очищается", async () => {
    const onAdd = vi.fn();
    render(<AddGroupForm onAdd={onAdd} />);
    const input = screen.getByLabelText("Новая группа") as HTMLInputElement;
    await userEvent.type(input, "Процессы");
    await userEvent.click(screen.getByRole("button", { name: "Создать группу" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith("Процессы");
    expect(input.value).toBe("");
  });

  it("REQ-012: пустое и пробельное название — onAdd не вызывается, показан alert", async () => {
    const onAdd = vi.fn();
    render(<AddGroupForm onAdd={onAdd} />);
    await userEvent.click(screen.getByRole("button", { name: "Создать группу" }));
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();

    await userEvent.type(screen.getByLabelText("Новая группа"), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Создать группу" }));
    expect(onAdd).not.toHaveBeenCalled();
  });
});
