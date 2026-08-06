import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBoard, BoardSnapshot } from "../board-types.ts";
import { notifyAgentAdded } from "../terminal-control.ts";
import type { BoardSocketOptions } from "../ws.ts";

const connectBoardSocket = vi.fn();
const closeMock = vi.fn();
const subscribeMdMock = vi.fn();
const unsubscribeMdMock = vi.fn();

vi.mock("../ws.ts", () => ({
  connectBoardSocket: (options: BoardSocketOptions) =>
    connectBoardSocket(options),
}));

// Issue #124 セルフレビュー指摘: TerminalPane はタブ一覧を独自の REST 1回読みで
// 確定しており Board の WS agent_update を購読していないため、Board 側から
// terminal-control.ts の疎結合レジストリ経由で通知する（notifyAgentAdded）。
// ここでは Board が agent_update のたびに正しく呼ぶことだけを検証し、
// TerminalPane 側の反映（タブ一覧への追加）は TerminalPane.test.tsx の責務とする。
vi.mock("../terminal-control.ts", () => ({
  notifyAgentAdded: vi.fn(),
  // セルフレビュー指摘（round2）: Board.tsx 自体は prefill を呼ばないが、
  // Board 配下の AgentColumn.tsx/CardDetailModal.tsx は同モジュールから
  // prefill を import している（AgentColumn.test.tsx の既存モックも同様に
  // prefill をモックしている）。モックが notifyAgentAdded だけだと、将来
  // Board.test.tsx にカード詳細の再開コマンド差し込み等 prefill 経路を通す
  // テストを足した時点で「No "prefill" export is defined on the mock」という
  // 原因の分かりにくいエラーで落ちる。registerTerminalController 等の残り3
  // export は Board 配下のどのコンポーネントからも import されていないため、
  // 現時点でモックに含める必要は無い（YAGNI。将来それらを使うテストを足す
  // 際に、必要な分だけこのモックへ追加する）。
  prefill: vi.fn(),
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
  subscribeMdMock.mockReset();
  unsubscribeMdMock.mockReset();
  vi.mocked(notifyAgentAdded).mockReset();
  connectBoardSocket.mockReturnValue({
    close: closeMock,
    subscribeMd: subscribeMdMock,
    unsubscribeMd: unsubscribeMdMock,
  });
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
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

  it("agent_update 受信のたびに terminal-control.notifyAgentAdded を呼ぶ（Issue #124: TerminalPane のタブ一覧への反映）", async () => {
    const { Board } = await import("./Board.tsx");
    render(<Board />);

    act(() => {
      latestOptions().onSnapshot(snapshot([agentBoard({ name: "medical" })]));
    });

    act(() => {
      latestOptions().onAgentUpdate(agentBoard({ name: "harness-guardian" }));
    });

    expect(notifyAgentAdded).toHaveBeenCalledWith("harness-guardian");
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

  it("PreviewPanel（左サイドパネル。#112 で右から移動）が組み込まれている（#64）", async () => {
    const { Board } = await import("./Board.tsx");
    render(<Board />);

    act(() => {
      latestOptions().onSnapshot(snapshot([agentBoard({ name: "medical" })]));
    });

    expect(
      screen.getByRole("button", { name: "プレビューパネルを開く" }),
    ).toBeInTheDocument();
    // #112: パネルはボードカラムより前（画面左側）に配置される。
    const mainRow = document.querySelector(".board-main-row");
    expect(mainRow?.firstElementChild).toBe(
      screen.getByTestId("preview-panel"),
    );
  });

  describe("「＋ エージェント追加」ボタン（Issue #123）", () => {
    it("ボタンが表示され、クリックでフォームが開く", async () => {
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(snapshot([agentBoard({ name: "medical" })]));
      });

      expect(screen.queryByTestId("add-agent-form")).not.toBeInTheDocument();

      act(() => {
        screen.getByRole("button", { name: "＋ エージェント追加" }).click();
      });

      expect(screen.getByTestId("add-agent-form")).toBeInTheDocument();
    });

    it("フォームの「閉じる」で閉じる", async () => {
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(snapshot([agentBoard({ name: "medical" })]));
      });

      act(() => {
        screen.getByRole("button", { name: "＋ エージェント追加" }).click();
      });

      act(() => {
        screen.getByRole("button", { name: "閉じる" }).click();
      });

      expect(screen.queryByTestId("add-agent-form")).not.toBeInTheDocument();
    });

    // Issue #124: 送信ハンドラは POST /api/fleet/agents を呼び出す実処理に
    // 置き換わった。新カラム出現は既存の agent_update → upsertAgent 経路で
    // 検証する（レスポンス body から直接 agents state を更新しないことの
    // 裏付けとして、agent_update が来るまではカラムが増えないことも確認する）。
    function stubFleetAgentsFetch(
      response: { ok: true } | { ok: false; status: number; error: string },
    ) {
      const fetchMock = vi.fn().mockResolvedValue(
        response.ok
          ? {
              ok: true,
              status: 201,
              json: () =>
                Promise.resolve({
                  agent: {
                    name: "harness-guardian",
                    path: "/agents/harness-guardian",
                  },
                }),
            }
          : {
              ok: false,
              status: response.status,
              json: () => Promise.resolve({ error: response.error }),
            },
      );
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    async function openFormAndFillName(name: string) {
      act(() => {
        screen.getByRole("button", { name: "＋ エージェント追加" }).click();
      });

      act(() => {
        fireEvent.change(
          screen.getByRole("textbox", { name: "エージェント名" }),
          { target: { value: name } },
        );
      });
    }

    it("有効な入力で送信すると、POST /api/fleet/agents が name/path 付きで呼ばれる", async () => {
      const fetchMock = stubFleetAgentsFetch({ ok: true });
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(
          snapshot([agentBoard({ name: "medical", path: "/agents/medical" })]),
        );
      });

      await openFormAndFillName("harness-guardian");

      await act(async () => {
        screen.getByRole("button", { name: "追加" }).click();
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/fleet/agents",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            name: "harness-guardian",
            path: "/agents/harness-guardian",
          }),
        }),
      );
    });

    it("201 応答時、フォームが閉じる（agents state はレスポンス body からは更新しない。agent_update 受信で初めてカラムが増える）", async () => {
      stubFleetAgentsFetch({ ok: true });
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(
          snapshot([agentBoard({ name: "medical", path: "/agents/medical" })]),
        );
      });

      await openFormAndFillName("harness-guardian");

      await act(async () => {
        screen.getByRole("button", { name: "追加" }).click();
        await Promise.resolve();
      });

      expect(screen.queryByTestId("add-agent-form")).not.toBeInTheDocument();
      // POST のレスポンス body だけでは新カラムは増えない（二重更新の防止）。
      expect(screen.queryByText("harness-guardian")).not.toBeInTheDocument();

      act(() => {
        latestOptions().onAgentUpdate(
          agentBoard({
            name: "harness-guardian",
            path: "/agents/harness-guardian",
          }),
        );
      });

      // agent_update 経由（既存の upsertAgent 経路）で初めてカラムが増える。
      expect(screen.getByText("harness-guardian")).toBeInTheDocument();
    });

    it("サーバー側バリデーションエラー（400）の場合、フォームは閉じずエラーメッセージが表示される", async () => {
      stubFleetAgentsFetch({
        ok: false,
        status: 400,
        error: 'name "harness-guardian" が既存 fleet と重複しています',
      });
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(
          snapshot([agentBoard({ name: "medical", path: "/agents/medical" })]),
        );
      });

      await openFormAndFillName("harness-guardian");

      await act(async () => {
        screen.getByRole("button", { name: "追加" }).click();
        await Promise.resolve();
      });

      expect(screen.getByTestId("add-agent-form")).toBeInTheDocument();
      expect(screen.getByTestId("add-agent-form-errors")).toHaveTextContent(
        'name "harness-guardian" が既存 fleet と重複しています',
      );
    });

    it("fetch 自体が失敗（通信エラー）した場合、フォームは閉じず通信エラーのメッセージが表示される", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("network error"));
      vi.stubGlobal("fetch", fetchMock);
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(
          snapshot([agentBoard({ name: "medical", path: "/agents/medical" })]),
        );
      });

      await openFormAndFillName("harness-guardian");

      await act(async () => {
        screen.getByRole("button", { name: "追加" }).click();
        await Promise.resolve();
      });

      expect(screen.getByTestId("add-agent-form")).toBeInTheDocument();
      expect(screen.getByTestId("add-agent-form-errors")).toHaveTextContent(
        "通信エラー",
      );
    });

    it("エラー応答のボディが JSON でない場合、status を含むフォールバックメッセージが表示される", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.reject(new Error("not json")),
      });
      vi.stubGlobal("fetch", fetchMock);
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(
          snapshot([agentBoard({ name: "medical", path: "/agents/medical" })]),
        );
      });

      await openFormAndFillName("harness-guardian");

      await act(async () => {
        screen.getByRole("button", { name: "追加" }).click();
        await Promise.resolve();
      });

      expect(screen.getByTestId("add-agent-form")).toBeInTheDocument();
      expect(screen.getByTestId("add-agent-form-errors")).toHaveTextContent(
        "status: 403",
      );
    });

    it("パス欄の初期値は既存エージェントの絶対パスの親ディレクトリになる", async () => {
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(
          snapshot([agentBoard({ name: "medical", path: "/agents/medical" })]),
        );
      });

      act(() => {
        screen.getByRole("button", { name: "＋ エージェント追加" }).click();
      });

      expect(screen.getByRole("textbox", { name: "パス" })).toHaveValue(
        "/agents",
      );
    });

    // セルフレビュー指摘: fleet.tsv は人間が手書きする設定ファイルで、読み込み
    // 時の正規化は trim のみのため、末尾に "/" が残ったパスがそのまま
    // AgentBoard.path に載りうる。末尾スラッシュを除去せずに親ディレクトリを
    // 算出すると、既存エージェント自身のディレクトリを親ディレクトリと誤認する
    // （既存エージェントの作業ツリー内に新規ディレクトリ・git init が作られる
    // 事故につながる）。
    it("既存エージェントのパスが末尾スラッシュ付きでも、そのエージェント自身のディレクトリではなく親ディレクトリが算出される", async () => {
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(
          snapshot([agentBoard({ name: "medical", path: "/agents/medical/" })]),
        );
      });

      act(() => {
        screen.getByRole("button", { name: "＋ エージェント追加" }).click();
      });

      expect(screen.getByRole("textbox", { name: "パス" })).toHaveValue(
        "/agents",
      );
    });
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

  describe("ライブ更新結線（Issue #70）", () => {
    // PreviewPanel 内部の「repo/path が一致する場合のみ処理する」判定ロジック
    // 自体は PreviewPanel.test.tsx の責務。ここでは Board.tsx が
    // connectBoardSocket から得た BoardSocket の subscribeMd/unsubscribeMd の
    // 転送（送信方向）に加え、connectBoardSocket に渡す
    // onMdFileChanged/onMdSubscribeError が実際に PreviewPanel まで届く
    // こと（受信方向の転送）も検証する。セルフレビュー指摘: 送信方向のみの
    // テストでは Board.tsx の onMdFileChanged/onMdSubscribeError 転送コードを
    // まるごと削除しても全テストが緑のままになってしまう空白があった。
    function stubTreeFetch() {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            repos: [{ name: "repo-a", files: ["docs/note.md"] }],
          }),
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    function stubTreeAndFileFetch() {
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/md/tree")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                repos: [{ name: "repo-a", files: ["docs/note.md"] }],
              }),
          });
        }
        if (url.startsWith("/api/md/file")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ content: "# Hello" }),
          });
        }
        throw new Error(`unexpected fetch url in test: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it("PreviewPanel でファイルを選択すると、Board 経由で socket.subscribeMd が repo/path 付きで呼ばれる", async () => {
      stubTreeFetch();
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(snapshot([agentBoard({ name: "medical" })]));
      });

      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      // #110: ツリーはネスト表示（ディレクトリは初期折りたたみ・ファイルは
      // ベース名のみ）のため、docs を展開してから note.md を選択する。
      const dirButton = await screen.findByRole("button", { name: "docs" });
      act(() => {
        dirButton.click();
      });
      const fileButton = await screen.findByRole("button", {
        name: "note.md",
      });
      act(() => {
        fileButton.click();
      });

      expect(subscribeMdMock).toHaveBeenCalledWith("repo-a", "docs/note.md");
    });

    it("PreviewPanel を閉じると、Board 経由で socket.unsubscribeMd が開いていたファイルの repo/path 付きで呼ばれる", async () => {
      stubTreeFetch();
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(snapshot([agentBoard({ name: "medical" })]));
      });

      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      // #110: ツリーはネスト表示（ディレクトリは初期折りたたみ・ファイルは
      // ベース名のみ）のため、docs を展開してから note.md を選択する。
      const dirButton = await screen.findByRole("button", { name: "docs" });
      act(() => {
        dirButton.click();
      });
      const fileButton = await screen.findByRole("button", {
        name: "note.md",
      });
      act(() => {
        fileButton.click();
      });

      act(() => {
        screen
          .getByRole("button", { name: "プレビューパネルを閉じる" })
          .click();
      });

      expect(unsubscribeMdMock).toHaveBeenCalledWith("repo-a", "docs/note.md");
    });

    it("connectBoardSocket の onMdFileChanged が呼ばれると、開いているファイルと一致する場合に PreviewPanel が再フェッチする（受信方向の転送）", async () => {
      const fetchMock = stubTreeAndFileFetch();
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(snapshot([agentBoard({ name: "medical" })]));
      });

      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      // #110: ツリーはネスト表示（ディレクトリは初期折りたたみ・ファイルは
      // ベース名のみ）のため、docs を展開してから note.md を選択する。
      const dirButton = await screen.findByRole("button", { name: "docs" });
      act(() => {
        dirButton.click();
      });
      const fileButton = await screen.findByRole("button", {
        name: "note.md",
      });
      act(() => {
        fileButton.click();
      });
      await screen.findByText("Hello");
      const callsAfterSelect = fetchMock.mock.calls.length;

      act(() => {
        latestOptions().onMdFileChanged?.({
          type: "md_file_changed",
          repo: "repo-a",
          path: "docs/note.md",
        });
      });

      await waitFor(() => {
        expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterSelect);
      });
    });

    it("connectBoardSocket の onMdSubscribeError が呼ばれると、PreviewPanel に「ライブ更新は無効」の注記が表示される（受信方向の転送）", async () => {
      stubTreeAndFileFetch();
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(snapshot([agentBoard({ name: "medical" })]));
      });

      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      // #110: ツリーはネスト表示（ディレクトリは初期折りたたみ・ファイルは
      // ベース名のみ）のため、docs を展開してから note.md を選択する。
      const dirButton = await screen.findByRole("button", { name: "docs" });
      act(() => {
        dirButton.click();
      });
      const fileButton = await screen.findByRole("button", {
        name: "note.md",
      });
      act(() => {
        fileButton.click();
      });
      await screen.findByText("Hello");

      act(() => {
        latestOptions().onMdSubscribeError?.({
          type: "md_subscribe_error",
          repo: "repo-a",
          path: "docs/note.md",
        });
      });

      expect(
        screen.getByTestId("preview-panel-live-update-disabled"),
      ).toBeInTheDocument();
    });

    it("セルフレビュー指摘: WS が（再）接続した（onStatusChange('open')）際、選択中のファイルを再度 socket.subscribeMd する", async () => {
      stubTreeFetch();
      const { Board } = await import("./Board.tsx");
      render(<Board />);

      act(() => {
        latestOptions().onSnapshot(snapshot([agentBoard({ name: "medical" })]));
      });

      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      // #110: ツリーはネスト表示（ディレクトリは初期折りたたみ・ファイルは
      // ベース名のみ）のため、docs を展開してから note.md を選択する。
      const dirButton = await screen.findByRole("button", { name: "docs" });
      act(() => {
        dirButton.click();
      });
      const fileButton = await screen.findByRole("button", {
        name: "note.md",
      });
      act(() => {
        fileButton.click();
      });

      const callsAfterSelect = subscribeMdMock.mock.calls.length;
      expect(callsAfterSelect).toBeGreaterThan(0);

      // 切断→自動再接続を模して onStatusChange("open") を発火させる
      // （ws.ts の実装では再接続のたびに呼ばれる。ws.test.ts の責務）。
      act(() => {
        latestOptions().onStatusChange?.("open");
      });

      expect(subscribeMdMock.mock.calls.length).toBeGreaterThan(
        callsAfterSelect,
      );
      expect(subscribeMdMock).toHaveBeenLastCalledWith(
        "repo-a",
        "docs/note.md",
      );
    });
  });
});
