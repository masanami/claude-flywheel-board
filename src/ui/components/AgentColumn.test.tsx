import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBoard, Challenge, ParseError } from "../board-types.ts";
import { AgentColumn } from "./AgentColumn.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

function challenge(
  overrides: Partial<Challenge> & Pick<Challenge, "id">,
): Challenge {
  return {
    title: `title-${overrides.id}`,
    status: "未分類",
    needsHuman: false,
    ...overrides,
  };
}

function agentBoard(overrides: Partial<AgentBoard> = {}): AgentBoard {
  return {
    name: "medical",
    path: "/agents/medical",
    challenges: [],
    parseErrors: [],
    ...overrides,
  };
}

describe("AgentColumn", () => {
  it("ヘッダにエージェント名のみを表示する（見出しレベル2）", () => {
    render(<AgentColumn agent={agentBoard({ name: "medical" })} />);

    expect(
      screen.getByRole("heading", { name: "medical", level: 2 }),
    ).toBeInTheDocument();
  });

  it("challenges を渡された順にカードとして描画する（再ソートしない）", () => {
    render(
      <AgentColumn
        agent={agentBoard({
          challenges: [
            challenge({ id: "C-002", title: "2番目" }),
            challenge({ id: "C-001", title: "1番目" }),
          ],
        })}
      />,
    );

    const titles = screen.getAllByText(/番目/).map((el) => el.textContent);
    expect(titles).toEqual(["2番目", "1番目"]);
  });

  it("needsHuman な課題の前に「🔔 承認待ち」の小見出し（見出しレベル3）を表示する", () => {
    render(
      <AgentColumn
        agent={agentBoard({
          challenges: [
            challenge({ id: "C-001", needsHuman: true }),
            challenge({ id: "C-002", needsHuman: false }),
          ],
        })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "🔔 承認待ち", level: 3 }),
    ).toBeInTheDocument();
  });

  it("needsHuman な課題が無い場合は小見出しを表示しない", () => {
    render(
      <AgentColumn
        agent={agentBoard({
          challenges: [challenge({ id: "C-001", needsHuman: false })],
        })}
      />,
    );

    expect(screen.queryByText("🔔 承認待ち")).not.toBeInTheDocument();
  });

  it("末尾に parseErrors を ErrorCard として描画する", () => {
    const parseErrors: ParseError[] = [
      {
        file: "challenge-ledger.md",
        line: 3,
        message: "壊れている",
        raw: "raw-line",
      },
    ];

    render(<AgentColumn agent={agentBoard({ challenges: [], parseErrors })} />);

    expect(
      screen.getByText("challenge-ledger.md:3 — 壊れている"),
    ).toBeInTheDocument();
    expect(screen.getByText("raw-line")).toBeInTheDocument();
  });

  it("カードをクリックすると対応するエージェント名で作業ログを取得する", async () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AgentColumn
        agent={agentBoard({
          name: "medical",
          challenges: [challenge({ id: "C-001", title: "対象タスク" })],
        })}
      />,
    );

    fireEvent.click(screen.getByText("対象タスク"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/log?agent=medical&challenge=C-001",
      );
    });
  });
});
