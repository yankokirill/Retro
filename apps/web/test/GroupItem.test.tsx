// @vitest-environment jsdom
// T-016 § 3 — GroupItem. REQ-011, REQ-012, REQ-013.

import type { GroupView } from "@retro/crdt";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupItem } from "../src/ui/GroupItem.js";

afterEach(cleanup);

const group = (over: Partial<GroupView> = {}): GroupView => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:1",
  title: ["Процессы"],
  conflict: false,
  cards: [],
  votes: 0,
  ...over,
});

function setup(over: Partial<GroupView> = {}, readOnly = false, children?: React.ReactNode) {
  const onRename = vi.fn();
  const onDelete = vi.fn();
  const view = render(
    <GroupItem group={group(over)} readOnly={readOnly} onRename={onRename} onDelete={onDelete}>
      {children}
    </GroupItem>,
  );
  return { onRename, onDelete, container: view.container };
}

describe("GroupItem", () => {
  it("REQ-012: корень section несёт data-group-id, название — h3[data-variant]", () => {
    const { container } = setup();
    const root = container.querySelector("section");
    expect(root?.getAttribute("data-group-id")).toBe(group().id);
    expect(container.querySelectorAll("h3[data-variant]")).toHaveLength(1);
    expect(screen.getByText("Процессы")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("REQ-012: XSS — название с HTML рендерится как текст", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const { container } = setup({ title: [payload] });
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(payload)).toBeTruthy();
  });

  it("REQ-011: children (стикеры группы) рендерятся внутри секции", () => {
    const { container } = setup({}, false, <p data-testid="inner">стикер</p>);
    expect(container.querySelector("section [data-testid=inner]")).not.toBeNull();
  });

  it("REQ-012: «Переименовать» открывает поле с первым вариантом; «Сохранить» вызывает onRename и закрывает", async () => {
    const { onRename } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Переименовать" }));
    const input = screen.getByLabelText("Название группы") as HTMLInputElement;
    expect(input.value).toBe("Процессы");
    await userEvent.clear(input);
    await userEvent.type(input, "Люди");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onRename).toHaveBeenCalledWith("Люди");
    expect(screen.queryByLabelText("Название группы")).toBeNull();
  });

  it("REQ-012: «Отмена» закрывает поле без onRename", async () => {
    const { onRename } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Переименовать" }));
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Название группы")).toBeNull();
  });

  it("REQ-013: «Удалить группу» вызывает onDelete", async () => {
    const { onDelete } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Удалить группу" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("REQ-012 кр.2: конфликт — alert «Конфликт названий», оба варианта, «Оставить это название» → onRename(вариант)", async () => {
    const { container, onRename } = setup({ title: ["B", "C"], conflict: true });
    expect(screen.getByRole("alert").textContent).toContain("Конфликт названий");
    expect(container.querySelectorAll("h3[data-variant]")).toHaveLength(2);
    const keep = screen.getAllByRole("button", { name: "Оставить это название" });
    expect(keep).toHaveLength(2);
    await userEvent.click(keep[1] as HTMLElement);
    expect(onRename).toHaveBeenCalledWith("C");
  });

  it("REQ-012: readOnly — ни кнопок, ни поля, конфликт всё равно виден", () => {
    setup({ title: ["B", "C"], conflict: true }, true);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByLabelText("Название группы")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Конфликт названий");
  });
});
