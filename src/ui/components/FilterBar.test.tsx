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
        archiveMode={false}
        onArchiveModeChange={vi.fn()}
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
        archiveMode={false}
        onArchiveModeChange={vi.fn()}
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
        archiveMode={false}
        onArchiveModeChange={vi.fn()}
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
        archiveMode={false}
        onArchiveModeChange={vi.fn()}
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
        archiveMode={false}
        onArchiveModeChange={vi.fn()}
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
        archiveMode={false}
        onArchiveModeChange={vi.fn()}
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
        archiveMode={false}
        onArchiveModeChange={vi.fn()}
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
        archiveMode={false}
        onArchiveModeChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "完了を表示" }),
    ).not.toBeDisabled();
  });

  describe("アーカイブ表示トグル（Issue #50 ①）", () => {
    it("アーカイブ表示トグルを表示し、archiveMode の値を aria-pressed に反映する", () => {
      render(
        <FilterBar
          value="all"
          onChange={vi.fn()}
          showCompleted={false}
          onShowCompletedChange={vi.fn()}
          archiveMode={true}
          onArchiveModeChange={vi.fn()}
        />,
      );

      expect(
        screen.getByRole("button", { name: /アーカイブ表示/ }),
      ).toHaveAttribute("aria-pressed", "true");
    });

    it("アーカイブ表示トグルのクリックで onArchiveModeChange(!archiveMode) を呼ぶ", () => {
      const onArchiveModeChange = vi.fn();
      render(
        <FilterBar
          value="all"
          onChange={vi.fn()}
          showCompleted={false}
          onShowCompletedChange={vi.fn()}
          archiveMode={false}
          onArchiveModeChange={onArchiveModeChange}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /アーカイブ表示/ }));

      expect(onArchiveModeChange).toHaveBeenCalledWith(true);
    });

    it("アーカイブ表示中は「すべて」「🔔 承認待ち」「完了を表示」がすべて無効化される（ライブ用フィルタとの相互作用を無効化）", () => {
      render(
        <FilterBar
          value="all"
          onChange={vi.fn()}
          showCompleted={false}
          onShowCompletedChange={vi.fn()}
          archiveMode={true}
          onArchiveModeChange={vi.fn()}
        />,
      );

      expect(screen.getByRole("button", { name: "すべて" })).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "🔔 承認待ち" }),
      ).toBeDisabled();
      expect(screen.getByRole("button", { name: "完了を表示" })).toBeDisabled();
    });

    it("アーカイブ表示中でなければ「すべて」「🔔 承認待ち」は有効", () => {
      render(
        <FilterBar
          value="all"
          onChange={vi.fn()}
          showCompleted={false}
          onShowCompletedChange={vi.fn()}
          archiveMode={false}
          onArchiveModeChange={vi.fn()}
        />,
      );

      expect(screen.getByRole("button", { name: "すべて" })).not.toBeDisabled();
      expect(
        screen.getByRole("button", { name: "🔔 承認待ち" }),
      ).not.toBeDisabled();
    });
  });
});
