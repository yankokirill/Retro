// @vitest-environment jsdom
// T-015 § 5 — TrashPanel. REQ-009.

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrashPanel } from "../src/ui/TrashPanel.js";

afterEach(cleanup);

const items = [
  { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:1", text: ["Один"] },
  { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:2", text: ["Два", "Две версии"] },
];

describe("TrashPanel", () => {
  it("REQ-009: пустая корзина — «Корзина пуста»", () => {
    render(<TrashPanel items={[]} readOnly={false} onRestore={() => {}} />);
    const panel = screen.getByRole("complementary", { name: "Корзина" });
    expect(panel.textContent).toContain("Корзина пуста");
  });

  it("REQ-009: элементы с data-card-id и всеми вариантами текста", () => {
    const { container } = render(
      <TrashPanel items={items} readOnly={false} onRestore={() => {}} />,
    );
    const rows = container.querySelectorAll("li[data-card-id]");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("data-card-id")).toBe(items[0]?.id);
    expect(rows[1]?.textContent).toContain("Два");
    expect(rows[1]?.textContent).toContain("Две версии");
  });

  it("REQ-009: Восстановить вызывает onRestore(id)", async () => {
    const onRestore = vi.fn();
    render(<TrashPanel items={items} readOnly={false} onRestore={onRestore} />);
    const buttons = screen.getAllByRole("button", { name: "Восстановить" });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[1] as HTMLElement);
    expect(onRestore).toHaveBeenCalledWith(items[1]?.id);
  });

  it("REQ-009: readOnly — кнопок восстановления нет", () => {
    render(<TrashPanel items={items} readOnly={true} onRestore={() => {}} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("REQ-009: XSS — текст в корзине выводится как текст", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const { container } = render(
      <TrashPanel items={[{ id: "a:1", text: [payload] }]} readOnly={false} onRestore={() => {}} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(payload);
  });
});
