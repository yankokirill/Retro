// @vitest-environment jsdom
// T-016 § 3 — GroupSelect. REQ-011.

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupSelect } from "../src/ui/GroupSelect.js";

afterEach(cleanup);

const groups = [
  { id: "g:1", title: "Процессы" },
  { id: "g:2", title: "Люди" },
];

describe("GroupSelect", () => {
  it("REQ-011: первая опция «Без группы», далее по одной на группу", () => {
    render(<GroupSelect groups={groups} current={null} onChange={vi.fn()} />);
    const select = screen.getByLabelText("Группа") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Без группы",
      "Процессы",
      "Люди",
    ]);
    expect(select.value).toBe("");
  });

  it("REQ-011: выбранное значение — current", () => {
    render(<GroupSelect groups={groups} current="g:2" onChange={vi.fn()} />);
    expect((screen.getByLabelText("Группа") as HTMLSelectElement).value).toBe("g:2");
  });

  it("REQ-011: выбор группы вызывает onChange(id), «Без группы» — onChange(null)", async () => {
    const onChange = vi.fn();
    render(<GroupSelect groups={groups} current="g:1" onChange={onChange} />);
    const select = screen.getByLabelText("Группа");
    await userEvent.selectOptions(select, "g:2");
    expect(onChange).toHaveBeenLastCalledWith("g:2");
    await userEvent.selectOptions(select, "");
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("REQ-011: XSS — название группы с HTML рендерится как текст", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const { container } = render(
      <GroupSelect groups={[{ id: "g:1", title: payload }]} current={null} onChange={vi.fn()} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(payload)).toBeTruthy();
  });
});
