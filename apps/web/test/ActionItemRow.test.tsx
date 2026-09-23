// @vitest-environment jsdom
// T-019 § 3 — ActionItemRow. REQ-017 (кр. 2), REQ-018, REQ-019 (кр. 1).

import type { ActionView } from "@retro/crdt";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionItemRow } from "../src/ui/ActionItemRow.js";

afterEach(cleanup);

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:1";
const MEMBERS = [
  { guestId: "g-a", displayName: "Аня" },
  { guestId: "g-b", displayName: "Боря" },
];

const action = (over: Partial<ActionView> = {}): ActionView => ({
  id: ID,
  text: ["Позвонить клиенту"],
  conflict: false,
  assignee: null,
  done: false,
  ...over,
});

function setup(over: Partial<ActionView> = {}, readOnly = false, members = MEMBERS) {
  const handlers = {
    onEditText: vi.fn(),
    onAssign: vi.fn(),
    onSetDone: vi.fn(),
    onDelete: vi.fn(),
  };
  const view = render(
    <ActionItemRow action={action(over)} members={members} readOnly={readOnly} {...handlers} />,
  );
  return { ...handlers, container: view.container };
}

describe("ActionItemRow", () => {
  it("REQ-017: корень li несёт data-action-id, текст — p[data-variant]", () => {
    const { container } = setup();
    expect(container.querySelector("li")?.getAttribute("data-action-id")).toBe(ID);
    expect(container.querySelectorAll("p[data-variant]")).toHaveLength(1);
    expect(screen.getByText("Позвонить клиенту")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("REQ-017: XSS — текст с HTML рендерится как текст", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const { container } = setup({ text: [payload] });
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(payload)).toBeTruthy();
  });

  it("REQ-018: XSS — имя участника с HTML рендерится как текст (в select и в readOnly)", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const members = [{ guestId: "g-x", displayName: payload }];
    const first = setup({ assignee: "g-x" }, false, members);
    expect(first.container.querySelector("img")).toBeNull();
    expect(screen.getByRole("option", { name: payload })).toBeTruthy();
    cleanup();
    const second = setup({ assignee: "g-x" }, true, members);
    expect(second.container.querySelector("img")).toBeNull();
    expect(screen.getByText(`Ответственный: ${payload}`)).toBeTruthy();
  });

  it("REQ-018 кр.3: чекбокс «Выполнено» отражает done и вызывает onSetDone(новое значение)", async () => {
    const { onSetDone } = setup({ done: false });
    const box = screen.getByRole("checkbox", { name: "Выполнено" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    await userEvent.click(box);
    expect(onSetDone).toHaveBeenCalledWith(true);
  });

  it("REQ-018 кр.3: выполненный — чекбокс отмечен, снятие вызывает onSetDone(false)", async () => {
    const { onSetDone } = setup({ done: true });
    const box = screen.getByRole("checkbox", { name: "Выполнено" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await userEvent.click(box);
    expect(onSetDone).toHaveBeenCalledWith(false);
  });

  it("REQ-018 кр.1: select «Ответственный» — «Не назначен» и участники, выбранный — текущий", async () => {
    const { onAssign } = setup({ assignee: "g-a" });
    const select = screen.getByRole("combobox", { name: "Ответственный" }) as HTMLSelectElement;
    expect(screen.getByRole("option", { name: "Не назначен" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Аня" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Боря" })).toBeTruthy();
    expect(select.value).toBe("g-a");
    await userEvent.selectOptions(select, "g-b");
    expect(onAssign).toHaveBeenCalledWith("g-b");
  });

  it("REQ-018: выбор «Не назначен» вызывает onAssign(null)", async () => {
    const { onAssign } = setup({ assignee: "g-a" });
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Ответственный" }),
      screen.getByRole("option", { name: "Не назначен" }),
    );
    expect(onAssign).toHaveBeenCalledWith(null);
  });

  it("REQ-017 кр.2: «Редактировать» открывает поле с первым вариантом; «Сохранить» вызывает onEditText и закрывает", async () => {
    const { onEditText } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Редактировать" }));
    const input = screen.getByLabelText("Текст действия") as HTMLTextAreaElement;
    expect(input.value).toBe("Позвонить клиенту");
    await userEvent.clear(input);
    await userEvent.type(input, "Написать клиенту");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onEditText).toHaveBeenCalledWith("Написать клиенту");
    expect(screen.queryByLabelText("Текст действия")).toBeNull();
  });

  it("REQ-017: «Отмена» закрывает поле без onEditText", async () => {
    const { onEditText } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Редактировать" }));
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onEditText).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Текст действия")).toBeNull();
  });

  it("REQ-019 кр.1: «Удалить» вызывает onDelete", async () => {
    const { onDelete } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("REQ-017 кр.2: конфликт — alert «Конфликт правок», оба варианта, «Оставить этот вариант» → onEditText(вариант)", async () => {
    const { container, onEditText } = setup({ text: ["B", "C"], conflict: true });
    expect(screen.getByRole("alert").textContent).toContain("Конфликт правок");
    expect(container.querySelectorAll("p[data-variant]")).toHaveLength(2);
    const keep = screen.getAllByRole("button", { name: "Оставить этот вариант" });
    expect(keep).toHaveLength(2);
    await userEvent.click(keep[1] as HTMLElement);
    expect(onEditText).toHaveBeenCalledWith("C");
  });

  it("REQ-018: readOnly — ответственный текстом «Ответственный: {имя}», без select", () => {
    setup({ assignee: "g-a" }, true);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Ответственный: Аня")).toBeTruthy();
  });

  it("REQ-018: readOnly без ответственного — «Ответственный: не назначен»", () => {
    setup({ assignee: null }, true);
    expect(screen.getByText("Ответственный: не назначен")).toBeTruthy();
  });

  it("REQ-018: readOnly, guestId не из members — «Ответственный: неизвестный участник»", () => {
    setup({ assignee: "g-ghost" }, true);
    expect(screen.getByText("Ответственный: неизвестный участник")).toBeTruthy();
  });

  it("REQ-018 кр.3: readOnly — чекбокс виден и отражает done, но disabled", () => {
    setup({ done: true }, true);
    const box = screen.getByRole("checkbox", { name: "Выполнено" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
  });

  it("REQ-017: readOnly — ни кнопок, ни полей ввода; конфликт всё равно виден", () => {
    setup({ text: ["B", "C"], conflict: true }, true);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByLabelText("Текст действия")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Конфликт правок");
  });
});
