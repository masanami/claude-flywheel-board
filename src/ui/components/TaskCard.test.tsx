import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Challenge } from "../board-types.ts";
import { TaskCard } from "./TaskCard.tsx";

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
    render(<TaskCard challenge={challenge({ title: "テストタイトル" })} />);

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
      />,
    );

    expect(screen.getByText("C-042")).toBeInTheDocument();
    expect(screen.getByText("着手中")).toBeInTheDocument();
    expect(screen.getByText("medical")).toBeInTheDocument();
  });

  it("ポジション未設定の場合はポジション表示を省略する", () => {
    const { container } = render(
      <TaskCard challenge={challenge({ position: undefined })} />,
    );

    expect(
      container.querySelector("[data-testid='task-card-position']"),
    ).not.toBeInTheDocument();
  });

  it("ステータスに対応する色ドットを data-status 属性で出し分ける", () => {
    const { container } = render(
      <TaskCard challenge={challenge({ status: "完了" })} />,
    );

    const dot = container.querySelector(".status-dot");
    expect(dot).toHaveAttribute("data-status", "完了");
  });

  it("状態を変更するボタンを一切持たない（観測専用・NFR-01）", () => {
    render(<TaskCard challenge={challenge()} />);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
