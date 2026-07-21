import { render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBoard, BoardSnapshot } from "../board-types.ts";
import type { BoardSocketOptions } from "../ws.ts";

const connectBoardSocket = vi.fn();
const closeMock = vi.fn();

vi.mock("../ws.ts", () => ({
  connectBoardSocket: (options: BoardSocketOptions) =>
    connectBoardSocket(options),
}));

function agentBoard(overrides: Partial<AgentBoard> = {}): AgentBoard {
  return {
    name: "medical",
    path: "/agents/medical",
    challenges: [],
    parseErrors: [],
    cycleStatus: "idle",
    runningRuns: [],
    archivedChallenges: [],
    ...overrides,
  };
}

function snapshot(agents: AgentBoard[]): BoardSnapshot {
  return { agents };
}

function latestOptions(): BoardSocketOptions {
  const call = connectBoardSocket.mock.calls.at(-1);
  if (!call) {
    throw new Error("connectBoardSocket was not called");
  }
  return call[0] as BoardSocketOptions;
}

beforeEach(() => {
  connectBoardSocket.mockReset();
  closeMock.mockReset();
  connectBoardSocket.mockReturnValue({ close: closeMock });
});

afterEach(() => {
  vi.resetModules();
});

describe("Board", () => {
  it("初回スナップショット受信までは読み込み中を表示する", async () => {
    const { Board } = await import("./Board.tsx");
    render(<Board />);

    expect(screen.getByText(/読み込み中/)).toBeInTheDocument();
  });

  it("スナップショット受信後、エージェント名がカラムとして表示される", async () => {
    const { Board } = await import("./Board.tsx");
    render(<Board />);

    act(() => {
      latestOptions().onSnapshot(
        snapshot([agentBoard({ name: "medical" }), agentBoard({ name: "bi" })]),
      );
    });

    expect(screen.getByText("medical")).toBeInTheDocument();
    expect(screen.getByText("bi")).toBeInTheDocument();
    expect(screen.queryByText(/読み込み中/)).not.toBeInTheDocument();
  });

  it("agent_update 受信で該当エージェントのみ置換する", async () => {
    const { Board } = await import("./Board.tsx");
    render(<Board />);

    act(() => {
      latestOptions().onSnapshot(
        snapshot([
          agentBoard({
            name: "medical",
            challenges: [
              {
                id: "C-001",
                title: "旧タイトル",
                status: "未分類",
                needsHuman: false,
              },
            ],
          }),
          agentBoard({ name: "bi" }),
        ]),
      );
    });

    act(() => {
      latestOptions().onAgentUpdate(
        agentBoard({
          name: "medical",
          challenges: [
            {
              id: "C-001",
              title: "新タイトル",
              status: "着手中",
              needsHuman: false,
            },
          ],
        }),
      );
    });

    expect(screen.getByText("新タイトル")).toBeInTheDocument();
    expect(screen.queryByText("旧タイトル")).not.toBeInTheDocument();
    expect(screen.getByText("bi")).toBeInTheDocument();
  });

  it("承認待ちフィルタ選択時、needsHuman な課題のみカラムに表示される", async () => {
    const { Board } = await import("./Board.tsx");
    render(<Board />);

    act(() => {
      latestOptions().onSnapshot(
        snapshot([
          agentBoard({
            name: "medical",
            challenges: [
              {
                id: "C-001",
                title: "承認待ちタスク",
                status: "計画承認待ち",
                needsHuman: true,
              },
              {
                id: "C-002",
                title: "通常タスク",
                status: "着手中",
                needsHuman: false,
              },
            ],
          }),
        ]),
      );
    });

    expect(screen.getByText("通常タスク")).toBeInTheDocument();

    act(() => {
      screen.getByRole("button", { name: "🔔 承認待ち" }).click();
    });

    expect(screen.getByText("承認待ちタスク")).toBeInTheDocument();
    expect(screen.queryByText("通常タスク")).not.toBeInTheDocument();
  });

  it("承認待ちフィルタ時も parseErrors は常に表示する", async () => {
    const { Board } = await import("./Board.tsx");
    render(<Board />);

    act(() => {
      latestOptions().onSnapshot(
        snapshot([
          agentBoard({
            name: "medical",
            challenges: [],
            parseErrors: [
              {
                file: "challenge-ledger.md",
                line: 1,
                message: "壊れている",
                raw: "raw",
              },
            ],
          }),
        ]),
      );
    });

    act(() => {
      screen.getByRole("button", { name: "🔔 承認待ち" }).click();
    });

    expect(
      screen.getByText("challenge-ledger.md:1 — 壊れている"),
    ).toBeInTheDocument();
  });

  it("承認待ちフィルタ選択時、実行中セクションも隠れる（runningRuns が空配列として渡される）", async () => {
    const { Board } = await import("./Board.tsx");
    render(<Board />);

    act(() => {
      latestOptions().onSnapshot(
        snapshot([
          agentBoard({
            name: "medical",
            challenges: [],
            runningRuns: [
              {
                kind: "adhoc",
                key: "adhoc-1",
                title: "実行中タスク",
                startedAt: "2026-07-16T09:00:00.000Z",
                stale: false,
              },
            ],
          }),
        ]),
      );
    });

    expect(
      screen.getByRole("heading", { name: "⚡ 実行中", level: 3 }),
    ).toBeInTheDocument();

    act(() => {
      screen.getByRole("button", { name: "🔔 承認待ち" }).click();
    });

    expect(
      screen.queryByRole("heading", { name: "⚡ 実行中", level: 3 }),
    ).not.toBeInTheDocument();
  });

  it("アンマウント時に close() を呼ぶ", async () => {
    const { Board } = await import("./Board.tsx");
    const { unmount } = render(<Board />);

    unmount();

    expect(closeMock).toHaveBeenCalled();
  });

  it("初期表示では完了ステータスのエントリを表示しない（Issue #50 ②）", async () => {
    const { Board } = await import("./Board.tsx");
    render(<Board />);

    act(() => {
      latestOptions().onSnapshot(
        snapshot([
          agentBoard({
            name: "medical",
            challenges: [
              {
                id: "C-001",
                title: "完了タスク",
                status: "完了",
                needsHuman: false,
              },
              {
                id: "C-002",
                title: "着手中タスク",
                status: "着手中",
                needsHuman: false,
              },
            ],
          }),
        ]),
      );
    });

    expect(screen.getByText("着手中タスク")).toBeInTheDocument();
    expect(screen.queryByText("完了タスク")).not.toBeInTheDocument();
  });

  it("「完了を表示」トグルをクリックすると完了ステータスのエントリが表示される", async () => {
    const { Board } = await import("./Board.tsx");
    render(<Board />);

    act(() => {
      latestOptions().onSnapshot(
        snapshot([
          agentBoard({
            name: "medical",
            challenges: [
              {
                id: "C-001",
                title: "完了タスク",
                status: "完了",
                needsHuman: false,
              },
            ],
          }),
        ]),
      );
    });

    expect(screen.queryByText("完了タスク")).not.toBeInTheDocument();

    act(() => {
      screen.getByRole("button", { name: "完了を表示" }).click();
    });

    expect(screen.getByText("完了タスク")).toBeInTheDocument();
  });

  it("「完了確認待ち」は完了トグルOFFでも常に表示される", async () => {
    const { Board } = await import("./Board.tsx");
    render(<Board />);

    act(() => {
      latestOptions().onSnapshot(
        snapshot([
          agentBoard({
            name: "medical",
            challenges: [
              {
                id: "C-001",
                title: "完了確認待ちタスク",
                status: "完了確認待ち",
                needsHuman: true,
              },
            ],
          }),
        ]),
      );
    });

    expect(screen.getByText("完了確認待ちタスク")).toBeInTheDocument();
  });

  it("承認待ちフィルタ選択中は「完了を表示」トグルが無効化され、完了は表示されないまま", async () => {
    const { Board } = await import("./Board.tsx");
    render(<Board />);

    act(() => {
      latestOptions().onSnapshot(
        snapshot([
          agentBoard({
            name: "medical",
            challenges: [
              {
                id: "C-001",
                title: "承認待ちタスク",
                status: "計画承認待ち",
                needsHuman: true,
              },
              {
                id: "C-002",
                title: "完了タスク",
                status: "完了",
                needsHuman: false,
              },
            ],
          }),
        ]),
      );
    });

    act(() => {
      screen.getByRole("button", { name: "🔔 承認待ち" }).click();
    });

    expect(screen.getByText("承認待ちタスク")).toBeInTheDocument();
    expect(screen.queryByText("完了タスク")).not.toBeInTheDocument();

    // needsHuman 選択中は 完了(needsHuman=false) が元々除外されトグルは no-op に
    // なるため、UX 上の誤解を避けてトグル自体を無効化する。ここではその無効化を
    // 直接検証する（disabled 要素のクリックは no-op のため、クリック結果の
    // アサーションでは相互作用を検証できない）。
    const toggle = screen.getByRole("button", { name: "完了を表示" });
    expect(toggle).toBeDisabled();
    expect(screen.getByText("承認待ちタスク")).toBeInTheDocument();
    expect(screen.queryByText("完了タスク")).not.toBeInTheDocument();
  });

  describe("アーカイブ表示（Issue #50 ①）", () => {
    it("アーカイブ表示トグルをONにすると、challenges ではなく archivedChallenges が表示される", async () => {
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(
          snapshot([
            agentBoard({
              name: "medical",
              challenges: [
                {
                  id: "C-001",
                  title: "現行タスク",
                  status: "着手中",
                  needsHuman: false,
                },
              ],
              archivedChallenges: [
                {
                  id: "C-900",
                  title: "アーカイブ済みタスク",
                  status: "完了",
                  needsHuman: false,
                },
              ],
            }),
          ]),
        );
      });

      expect(screen.getByText("現行タスク")).toBeInTheDocument();
      expect(
        screen.queryByText("アーカイブ済みタスク"),
      ).not.toBeInTheDocument();

      act(() => {
        screen.getByRole("button", { name: /アーカイブ表示/ }).click();
      });

      expect(screen.getByText("アーカイブ済みタスク")).toBeInTheDocument();
      expect(screen.queryByText("現行タスク")).not.toBeInTheDocument();
    });

    it("アーカイブが空のエージェントでもクラッシュせず空表示になる", async () => {
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(
          snapshot([agentBoard({ name: "medical", archivedChallenges: [] })]),
        );
      });

      act(() => {
        screen.getByRole("button", { name: /アーカイブ表示/ }).click();
      });

      expect(screen.getByText("medical")).toBeInTheDocument();
    });

    it("アーカイブ表示中は実行中セクションも隠れる", async () => {
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(
          snapshot([
            agentBoard({
              name: "medical",
              runningRuns: [
                {
                  kind: "adhoc",
                  key: "adhoc-1",
                  title: "実行中タスク",
                  startedAt: "2026-07-16T09:00:00.000Z",
                  stale: false,
                },
              ],
            }),
          ]),
        );
      });

      expect(
        screen.getByRole("heading", { name: "⚡ 実行中", level: 3 }),
      ).toBeInTheDocument();

      act(() => {
        screen.getByRole("button", { name: /アーカイブ表示/ }).click();
      });

      expect(
        screen.queryByRole("heading", { name: "⚡ 実行中", level: 3 }),
      ).not.toBeInTheDocument();
    });

    it("アーカイブ表示中はライブ用フィルタ（すべて/承認待ち/完了を表示）が無効化される", async () => {
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(snapshot([agentBoard({ name: "medical" })]));
      });

      act(() => {
        screen.getByRole("button", { name: /アーカイブ表示/ }).click();
      });

      expect(screen.getByRole("button", { name: "すべて" })).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "🔔 承認待ち" }),
      ).toBeDisabled();
      expect(screen.getByRole("button", { name: "完了を表示" })).toBeDisabled();
    });

    it("アーカイブ表示トグルをOFFに戻すとライブ表示に戻る", async () => {
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(
          snapshot([
            agentBoard({
              name: "medical",
              challenges: [
                {
                  id: "C-001",
                  title: "現行タスク",
                  status: "着手中",
                  needsHuman: false,
                },
              ],
              archivedChallenges: [
                {
                  id: "C-900",
                  title: "アーカイブ済みタスク",
                  status: "完了",
                  needsHuman: false,
                },
              ],
            }),
          ]),
        );
      });

      const toggle = screen.getByRole("button", { name: /アーカイブ表示/ });
      act(() => {
        toggle.click();
      });
      act(() => {
        toggle.click();
      });

      expect(screen.getByText("現行タスク")).toBeInTheDocument();
      expect(
        screen.queryByText("アーカイブ済みタスク"),
      ).not.toBeInTheDocument();
    });
  });
});
