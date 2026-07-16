import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FilterBar } from "./FilterBar.tsx";

describe("FilterBar", () => {
  it("「すべて」「🔔 承認待ち」の2チップを表示する", () => {
    render(<FilterBar value="all" onChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "すべて" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "🔔 承認待ち" }),
    ).toBeInTheDocument();
  });

  it("value と一致するチップを選択状態として視覚的にハイライトする", () => {
    render(<FilterBar value="needsHuman" onChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "🔔 承認待ち" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "すべて" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("「🔔 承認待ち」クリックで onChange('needsHuman') を呼ぶ", () => {
    const onChange = vi.fn();
    render(<FilterBar value="all" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "🔔 承認待ち" }));

    expect(onChange).toHaveBeenCalledWith("needsHuman");
  });

  it("「すべて」クリックで onChange('all') を呼ぶ", () => {
    const onChange = vi.fn();
    render(<FilterBar value="needsHuman" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "すべて" }));

    expect(onChange).toHaveBeenCalledWith("all");
  });
});
