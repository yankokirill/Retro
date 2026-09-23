// @vitest-environment jsdom
// T-015 § 5 — CardItem. REQ-005/007/009/010.

import type { CardView } from "@retro/crdt";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardItem } from "../src/ui/CardItem.js";

afterEach(cleanup);

const card = (over: Partial<CardView> = {}): CardView => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:1",
  text: ["Привет"],
  conflict: false,
  color: "green",
  votes: 0,
  ...over,
});

function setup(over: Partial<CardView> = {}, readOnly = false) {
  const handlers = { onEditText: vi.fn(), onSetColor: vi.fn(), onDelete: vi.fn() };
  const view = render(<CardItem card={card(over)} readOnly={readOnly} {...handlers} />);
  return { ...handlers, container: view.container };
}

describe("CardItem", () => {
  it("REQ-005: корень article несёт data-card-id и data-color, текст показан", () => {
    const { container } = setup();
    const root = container.querySelector("article");
    expect(root?.getAttribute("data-card-id")).toBe(card().id);
    expect(root?.getAttribute("data-color")).toBe("green");
    expect(container.querySelectorAll("p[data-variant]")).toHaveLength(1);
    expect(screen.getByText("Привет")).toBeTruthy();
  });

  it("REQ-005: XSS — текст с HTML рендерится как текст, элементов не создаёт", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const { container } = setup({ text: [payload] });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("p[data-variant]")?.textContent).toBe(payload);
  });

  it("REQ-007: без конфликта нет role=alert", () => {
    setup();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("REQ-007: конфликт — оба варианта, предупреждение и кнопки 'Оставить этот вариант'", async () => {
    const { container, onEditText } = setup({ text: ["B", "C"], conflict: true });
    expect(container.querySelectorAll("p[data-variant]")).toHaveLength(2);
    expect(within(screen.getByRole("alert")).getByText(/Конфликт правок/)).toBeTruthy();
    const keep = screen.getAllByRole("button", { name: "Оставить этот вариант" });
    expect(keep).toHaveLength(2);
    await userEvent.click(keep[1] as HTMLElement);
    expect(onEditText).toHaveBeenCalledWith("C");
  });

  it("REQ-007: редактирование — Редактировать → textarea с текстом → Сохранить вызывает onEditText и закрывает редактор", async () => {
    const { onEditText } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Редактировать" }));
    const box = screen.getByLabelText("Текст стикера") as HTMLTextAreaElement;
    expect(box.value).toBe("Привет");
    await userEvent.clear(box);
    await userEvent.type(box, "Новый");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onEditText).toHaveBeenCalledWith("Новый");
    expect(screen.queryByLabelText("Текст стикера")).toBeNull();
  });

  it("REQ-007: Отмена закрывает редактор без вызова onEditText", async () => {
    const { onEditText } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Редактировать" }));
    await userEvent.type(screen.getByLabelText("Текст стикера"), "мусор");
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onEditText).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Текст стикера")).toBeNull();
  });

  it("REQ-007: при конфликте редактор открывается с первым вариантом", async () => {
    setup({ text: ["B", "C"], conflict: true });
    await userEvent.click(screen.getByRole("button", { name: "Редактировать" }));
    expect((screen.getByLabelText("Текст стикера") as HTMLTextAreaElement).value).toBe("B");
  });

  it("REQ-009: кнопка Удалить вызывает onDelete", async () => {
    const { onDelete } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("REQ-010: пять кнопок цвета, клик вызывает onSetColor", async () => {
    const { onSetColor } = setup();
    for (const c of ["yellow", "green", "blue", "pink", "purple"]) {
      expect(screen.getByRole("button", { name: `Цвет: ${c}` })).toBeTruthy();
    }
    await userEvent.click(screen.getByRole("button", { name: "Цвет: pink" }));
    expect(onSetColor).toHaveBeenCalledWith("pink");
  });

  it("REQ-005: readOnly — ни одной кнопки, текст виден", () => {
    setup({}, true);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("Привет")).toBeTruthy();
  });

  it("REQ-007: readOnly с конфликтом — оба варианта видны, кнопок нет", () => {
    const { container } = setup({ text: ["B", "C"], conflict: true }, true);
    expect(container.querySelectorAll("p[data-variant]")).toHaveLength(2);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
