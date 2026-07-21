import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FilterBar } from "./FilterBar.tsx";

describe("FilterBar", () => {
  it("「すべて」「🔔 承認待ち」の2チップを表示する", () => {
    render(
      <FilterBar
        value="all"
        onChange={vi.fn()}
        showCompleted={false}
        onShowCompletedChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "すべて" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "🔔 承認待ち" }),
    ).toBeInTheDocument();
  });

  it("value と一致するチップを選択状態として視覚的にハイライトする", () => {
    render(
      <FilterBar
        value="needsHuman"
        onChange={vi.fn()}
        showCompleted={false}
        onShowCompletedChange={vi.fn()}
      />,
    );

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
    render(
      <FilterBar
        value="all"
        onChange={onChange}
        showCompleted={false}
        onShowCompletedChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "🔔 承認待ち" }));

    expect(onChange).toHaveBeenCalledWith("needsHuman");
  });

  it("「すべて」クリックで onChange('all') を呼ぶ", () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        value="needsHuman"
        onChange={onChange}
        showCompleted={false}
        onShowCompletedChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "すべて" }));

    expect(onChange).toHaveBeenCalledWith("all");
  });

  it("「完了を表示」トグルを表示し、showCompleted の値を aria-pressed に反映する", () => {
    render(
      <FilterBar
        value="all"
        onChange={vi.fn()}
        showCompleted={true}
        onShowCompletedChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "完了を表示" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("「完了を表示」クリックで onShowCompletedChange(!showCompleted) を呼ぶ", () => {
    const onShowCompletedChange = vi.fn();
    render(
      <FilterBar
        value="all"
        onChange={vi.fn()}
        showCompleted={false}
        onShowCompletedChange={onShowCompletedChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "完了を表示" }));

    expect(onShowCompletedChange).toHaveBeenCalledWith(true);
  });

  it("「🔔 承認待ち」選択中は「完了を表示」トグルを無効化する（完了は needsHuman にならず常に無効のため）", () => {
    render(
      <FilterBar
        value="needsHuman"
        onChange={vi.fn()}
        showCompleted={false}
        onShowCompletedChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "完了を表示" })).toBeDisabled();
  });

  it("「すべて」選択中は「完了を表示」トグルが有効", () => {
    render(
      <FilterBar
        value="all"
        onChange={vi.fn()}
        showCompleted={false}
        onShowCompletedChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "完了を表示" }),
    ).not.toBeDisabled();
  });
});
