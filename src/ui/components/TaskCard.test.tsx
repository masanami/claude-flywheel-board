import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Challenge } from "../board-types.ts";
import { CHALLENGE_DRAG_MIME, TaskCard } from "./TaskCard.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    id: "C-001",
    title: "課題タイトル",
    status: "未分類",
    needsHuman: false,
    ...overrides,
  };
}

describe("TaskCard", () => {
  it("タイトルを表示する", () => {
    render(
      <TaskCard
        challenge={challenge({ title: "テストタイトル" })}
        agentName="medical"
      />,
    );

    expect(screen.getByText("テストタイトル")).toBeInTheDocument();
  });

  it("メタ行に ID・ステータステキスト・ポジションを表示する", () => {
    render(
      <TaskCard
        challenge={challenge({
          id: "C-042",
          status: "着手中",
          position: "medical",
        })}
        agentName="medical"
      />,
    );

    expect(screen.getByText("C-042")).toBeInTheDocument();
    expect(screen.getByText("着手中")).toBeInTheDocument();
    expect(screen.getByText("medical")).toBeInTheDocument();
  });

  it("ポジション未設定の場合はポジション表示を省略する", () => {
    const { container } = render(
      <TaskCard
        challenge={challenge({ position: undefined })}
        agentName="medical"
      />,
    );

    expect(
      container.querySelector("[data-testid='task-card-position']"),
    ).not.toBeInTheDocument();
  });

  it("ステータスに対応する色ドットを data-status 属性で出し分ける", () => {
    const { container } = render(
      <TaskCard
        challenge={challenge({ status: "完了" })}
        agentName="medical"
      />,
    );

    const dot = container.querySelector(".status-dot");
    expect(dot).toHaveAttribute("data-status", "完了");
  });

  it("状態を変更する実ボタン（承認・実行等）を一切持たない（観測専用・NFR-01）", () => {
    // カード自体は読み取り専用の詳細モーダルを開くための単一の実ボタンとして
    // 実装される（アクセシビリティ上、キーボード操作可能な要素は <button> が適切）。
    // 承認・却下・実行など状態を変更する追加のボタンが増えていないことを確認する。
    render(<TaskCard challenge={challenge()} agentName="medical" />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
  });

  describe("D&D 並べ替え（#16）", () => {
    it("draggable 属性を持つ", () => {
      render(<TaskCard challenge={challenge()} agentName="medical" />);

      const card = screen.getByText("課題タイトル").closest(".task-card");
      expect(card).toHaveAttribute("draggable", "true");
    });

    it("dragstart で dataTransfer に課題IDをセットする", () => {
      render(
        <TaskCard challenge={challenge({ id: "C-042" })} agentName="medical" />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card");
      if (!card) throw new Error("task-card が見つかりません");

      const setData = vi.fn();
      fireEvent.dragStart(card, {
        dataTransfer: { setData, effectAllowed: "" },
      });

      expect(setData).toHaveBeenCalledWith(CHALLENGE_DRAG_MIME, "C-042");
    });
  });

  describe("ホバー・フォーカスによるツールチップ", () => {
    it("ホバーで summary をツールチップとして表示する", () => {
      render(
        <TaskCard
          challenge={challenge({ summary: "直近の作業要約" })}
          agentName="medical"
        />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card");
      if (!card) throw new Error("task-card が見つかりません");

      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

      fireEvent.mouseEnter(card);

      expect(screen.getByRole("tooltip")).toHaveTextContent("直近の作業要約");

      fireEvent.mouseLeave(card);

      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    it("キーボードフォーカスで summary をツールチップとして表示する", () => {
      render(
        <TaskCard
          challenge={challenge({ summary: "直近の作業要約" })}
          agentName="medical"
        />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card");
      if (!card) throw new Error("task-card が見つかりません");

      fireEvent.focus(card);

      expect(screen.getByRole("tooltip")).toHaveTextContent("直近の作業要約");

      fireEvent.blur(card);

      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    it("summary が無い場合はホバーしてもツールチップを表示しない", () => {
      render(
        <TaskCard
          challenge={challenge({ summary: undefined })}
          agentName="medical"
        />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card");
      if (!card) throw new Error("task-card が見つかりません");

      fireEvent.mouseEnter(card);

      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    it("ツールチップの id をカードの aria-describedby で参照する", () => {
      render(
        <TaskCard
          challenge={challenge({ summary: "直近の作業要約" })}
          agentName="medical"
        />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card");
      if (!card) throw new Error("task-card が見つかりません");

      expect(card).not.toHaveAttribute("aria-describedby");

      fireEvent.mouseEnter(card);

      const tooltip = screen.getByRole("tooltip");
      expect(tooltip.id).not.toBe("");
      expect(card).toHaveAttribute("aria-describedby", tooltip.id);

      fireEvent.mouseLeave(card);

      expect(card).not.toHaveAttribute("aria-describedby");
    });
  });

  describe("詳細モーダルを開く操作", () => {
    it("クリックで詳細モーダルが開く", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(<TaskCard challenge={challenge()} agentName="medical" />);

      fireEvent.click(screen.getByText("課題タイトル"));

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("Enter キー押下で詳細モーダルが開く", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(<TaskCard challenge={challenge()} agentName="medical" />);

      const card = screen.getByText("課題タイトル").closest(".task-card");
      if (!card) throw new Error("task-card が見つかりません");

      fireEvent.keyDown(card, { key: "Enter" });

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("モーダルの閉じるボタンをクリックすると閉じる", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(<TaskCard challenge={challenge()} agentName="medical" />);

      fireEvent.click(screen.getByText("課題タイトル"));
      fireEvent.click(screen.getByRole("button", { name: "閉じる" }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("閉じるボタンでモーダルを閉じるとトリガーのカードへフォーカスが戻る", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(<TaskCard challenge={challenge()} agentName="medical" />);

      const card = screen.getByText("課題タイトル").closest(".task-card");
      if (!card) throw new Error("task-card が見つかりません");

      fireEvent.click(card);
      fireEvent.click(screen.getByRole("button", { name: "閉じる" }));

      expect(card).toHaveFocus();
    });

    it("ESC キーでモーダルを閉じるとトリガーのカードへフォーカスが戻る", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(<TaskCard challenge={challenge()} agentName="medical" />);

      const card = screen.getByText("課題タイトル").closest(".task-card");
      if (!card) throw new Error("task-card が見つかりません");

      fireEvent.click(card);
      fireEvent.keyDown(document, { key: "Escape" });

      expect(card).toHaveFocus();
    });

    it("バックドロップクリックでモーダルを閉じるとトリガーのカードへフォーカスが戻る", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(<TaskCard challenge={challenge()} agentName="medical" />);

      const card = screen.getByText("課題タイトル").closest(".task-card");
      if (!card) throw new Error("task-card が見つかりません");

      fireEvent.click(card);

      const overlay = screen.getByTestId("modal-overlay");
      fireEvent.mouseDown(overlay);
      fireEvent.click(overlay);

      expect(card).toHaveFocus();
    });
  });
});
