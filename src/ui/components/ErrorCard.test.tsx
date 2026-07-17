import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ParseError } from "../board-types.ts";
import { ErrorCard } from "./ErrorCard.tsx";

function parseError(overrides: Partial<ParseError> = {}): ParseError {
  return {
    file: "challenge-ledger.md",
    line: 12,
    message: "ステータス フィールドが見つかりません",
    raw: "### [C-001] タイトル",
    ...overrides,
  };
}

describe("ErrorCard", () => {
  it("1行要約に file:line — message を表示する", () => {
    render(
      <ErrorCard
        error={parseError({
          file: "challenge-ledger.md",
          line: 12,
          message: "ステータス フィールドが見つかりません",
        })}
      />,
    );

    expect(
      screen.getByText(
        "challenge-ledger.md:12 — ステータス フィールドが見つかりません",
      ),
    ).toBeInTheDocument();
  });

  it("line が無い場合は ? を表示する", () => {
    render(
      <ErrorCard
        error={parseError({
          file: "journal.md",
          line: undefined,
          message: "壊れている",
        })}
      />,
    );

    expect(screen.getByText("journal.md:? — 壊れている")).toBeInTheDocument();
  });

  it("原文（raw）を表示する", () => {
    render(<ErrorCard error={parseError({ raw: "### [C-999] 壊れた行" })} />);

    expect(screen.getByText("### [C-999] 壊れた行")).toBeInTheDocument();
  });

  it("状態を変更するボタンを一切持たない（観測専用）", () => {
    render(<ErrorCard error={parseError()} />);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
