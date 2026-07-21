import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBoard, Challenge, ParseError, Run } from "../board-types.ts";
import { prefill } from "../terminal-control.ts";
import { AgentColumn } from "./AgentColumn.tsx";

vi.mock("../terminal-control.ts", () => ({
  prefill: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(prefill).mockClear();
});

// jsdom は DataTransfer を完全実装していないため、テストごとに簡易モックを渡す。
// setData でセットした値を getData で読み返せるようにする。
function makeDataTransfer(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    setData: vi.fn((type: string, value: string) => store.set(type, value)),
    getData: vi.fn((type: string) => store.get(type) ?? ""),
    effectAllowed: "",
    dropEffect: "",
  };
}

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
    cycleStatus: "idle",
    runningRuns: [],
    archivedChallenges: [],
    ...overrides,
  };
}

function run(overrides: Partial<Run> & Pick<Run, "kind" | "key">): Run {
  return {
    startedAt: "2026-07-16T09:00:00.000Z",
    stale: false,
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

  describe("＋差し込み（ゴーストカード）", () => {
    it("「＋ 差し込み」をクリックするとゴーストカード（内容入力欄とヒント）が表示される", () => {
      render(<AgentColumn agent={agentBoard({ challenges: [] })} />);

      expect(
        screen.queryByPlaceholderText("課題の内容"),
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));

      expect(screen.getByPlaceholderText("課題の内容")).toBeInTheDocument();
      expect(
        screen.getByText("ドラッグで位置＝優先度を指定"),
      ).toBeInTheDocument();
    });

    it("「＋ 差し込み」をクリックした直後、内容入力欄へ自動的にフォーカスする（誤入力がターミナルへ流れる #27 対応）", () => {
      render(<AgentColumn agent={agentBoard({ challenges: [] })} />);

      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));

      expect(screen.getByPlaceholderText("課題の内容")).toHaveFocus();
    });

    it("内容入力欄への入力が反映される", () => {
      render(<AgentColumn agent={agentBoard({ challenges: [] })} />);
      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));

      const input = screen.getByPlaceholderText(
        "課題の内容",
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "新しい課題" } });

      expect(input.value).toBe("新しい課題");
    });

    // ゴーストの D&D は実ブラウザ同様、dragStart で GHOST_DRAG_MIME を積んだ
    // DataTransfer を、そのまま drop まで使い回す（同一ドラッグ操作内では
    // ブラウザは同じ DataTransfer インスタンスを維持するため）。
    function dragStartFromGhost() {
      const dataTransfer = makeDataTransfer();
      const ghostRow = screen.getByTestId("agent-column-ghost-row");
      fireEvent.dragStart(ghostRow, { dataTransfer });
      return dataTransfer;
    }

    it("既存カードが無い状態でゴーストをドロップすると、隣接カードなしとして prefill が呼ばれゴーストが消える", () => {
      render(<AgentColumn agent={agentBoard({ challenges: [] })} />);
      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));
      fireEvent.change(screen.getByPlaceholderText("課題の内容"), {
        target: { value: "新しい課題" },
      });

      const dataTransfer = dragStartFromGhost();
      const ghostRow = screen.getByTestId("agent-column-ghost-row");
      fireEvent.drop(ghostRow, { dataTransfer });

      expect(prefill).toHaveBeenCalledWith(
        "medical",
        "差し込み: 「新しい課題」を課題台帳に追加してください。優先度は最上位でお願いします",
      );
      expect(
        screen.queryByPlaceholderText("課題の内容"),
      ).not.toBeInTheDocument();
    });

    it("既存カードの行にゴーストをドロップすると、その課題を隣接として prefill が呼ばれる", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            challenges: [
              challenge({ id: "C-044", priority: "P1", title: "先頭タスク" }),
            ],
          })}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));
      fireEvent.change(screen.getByPlaceholderText("課題の内容"), {
        target: { value: "新しい課題" },
      });

      const dataTransfer = dragStartFromGhost();
      const row = screen.getByTestId("agent-column-row-C-044");
      fireEvent.drop(row, { dataTransfer });

      expect(prefill).toHaveBeenCalledWith(
        "medical",
        "差し込み: 「新しい課題」を課題台帳に追加してください。優先度は C-044 より上（P1 相当）でお願いします",
      );
    });

    it("ゴーストのドロップ確定後も challenges の並びは変化しない（楽観更新禁止）", () => {
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
      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));
      fireEvent.change(screen.getByPlaceholderText("課題の内容"), {
        target: { value: "新しい課題" },
      });

      const dataTransfer = dragStartFromGhost();
      fireEvent.drop(screen.getByTestId("agent-column-row-C-002"), {
        dataTransfer,
      });

      const titles = screen.getAllByText(/番目/).map((el) => el.textContent);
      expect(titles).toEqual(["2番目", "1番目"]);
    });

    it("ゴースト由来ではない（GHOST_DRAG_MIME を伴わない）ドロップでは、ゴーストが開いていても prefill されない（無関係な外部テキスト/ファイルのドロップ誤爆防止）", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            challenges: [challenge({ id: "C-044", title: "先頭タスク" })],
          })}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));
      fireEvent.change(screen.getByPlaceholderText("課題の内容"), {
        target: { value: "新しい課題" },
      });

      // dragStart を経由せず、外部テキストのドラッグを模した DataTransfer を
      // 直接 drop する（GHOST_DRAG_MIME は積まれていない）。
      const externalDataTransfer = makeDataTransfer({
        "text/plain": "何か無関係なテキスト",
      });
      fireEvent.drop(screen.getByTestId("agent-column-row-C-044"), {
        dataTransfer: externalDataTransfer,
      });

      expect(prefill).not.toHaveBeenCalled();
      // ゴーストは維持されたまま（誤って閉じられない）。
      expect(screen.getByPlaceholderText("課題の内容")).toBeInTheDocument();
    });

    it("内容が空（trim 後に空文字）の状態でゴーストをドロップしても、prefill されずゴーストは維持される", () => {
      render(<AgentColumn agent={agentBoard({ challenges: [] })} />);
      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));
      // 内容入力欄には何も入力しない（初期値は空文字）。

      const dataTransfer = dragStartFromGhost();
      const ghostRow = screen.getByTestId("agent-column-ghost-row");
      fireEvent.drop(ghostRow, { dataTransfer });

      expect(prefill).not.toHaveBeenCalled();
      expect(screen.getByPlaceholderText("課題の内容")).toBeInTheDocument();
    });

    it("内容が空白文字のみの状態でゴーストをドロップしても、prefill されずゴーストは維持される", () => {
      render(<AgentColumn agent={agentBoard({ challenges: [] })} />);
      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));
      fireEvent.change(screen.getByPlaceholderText("課題の内容"), {
        target: { value: "   " },
      });

      const dataTransfer = dragStartFromGhost();
      const ghostRow = screen.getByTestId("agent-column-ghost-row");
      fireEvent.drop(ghostRow, { dataTransfer });

      expect(prefill).not.toHaveBeenCalled();
      expect(screen.getByPlaceholderText("課題の内容")).toBeInTheDocument();
    });

    it("最下位ドロップゾーンにゴーストをドロップすると、最下位カードより下（最低優先度）への追加として prefill が呼ばれる", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            challenges: [
              challenge({ id: "C-002", title: "2番目" }),
              challenge({ id: "C-001", title: "1番目（最下位）" }),
            ],
          })}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));
      fireEvent.change(screen.getByPlaceholderText("課題の内容"), {
        target: { value: "新しい課題" },
      });

      const dataTransfer = dragStartFromGhost();
      const bottomZone = screen.getByTestId("agent-column-bottom-drop-zone");
      fireEvent.drop(bottomZone, { dataTransfer });

      expect(prefill).toHaveBeenCalledWith(
        "medical",
        "差し込み: 「新しい課題」を課題台帳に追加してください。優先度は C-001 より下（最低優先度）でお願いします",
      );
    });
  });

  describe("既存カードの D&D 並べ替え", () => {
    it("カードをドラッグして別カードの行にドロップすると、優先度変更の指示で prefill が呼ばれる", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            challenges: [
              challenge({ id: "C-047", title: "移動対象" }),
              challenge({ id: "C-044", priority: "P1", title: "移動先隣接" }),
            ],
          })}
        />,
      );

      const dataTransfer = makeDataTransfer();
      const draggedCard = screen.getByText("移動対象").closest(".task-card");
      if (!draggedCard) throw new Error("task-card が見つかりません");
      fireEvent.dragStart(draggedCard, { dataTransfer });
      fireEvent.drop(screen.getByTestId("agent-column-row-C-044"), {
        dataTransfer,
      });

      expect(prefill).toHaveBeenCalledWith(
        "medical",
        "課題 C-047 の優先度を C-044 より上（P1 以上）に変更してください",
      );
    });

    it("並べ替え後も challenges 配列自体の並びは変化しない（楽観更新禁止・fs-watch 反映待ち）", () => {
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

      const dataTransfer = makeDataTransfer();
      const draggedCard = screen.getByText("1番目").closest(".task-card");
      if (!draggedCard) throw new Error("task-card が見つかりません");
      fireEvent.dragStart(draggedCard, { dataTransfer });
      fireEvent.drop(screen.getByTestId("agent-column-row-C-002"), {
        dataTransfer,
      });

      const titles = screen.getAllByText(/番目/).map((el) => el.textContent);
      expect(titles).toEqual(["2番目", "1番目"]);
    });

    it("自分自身の行にドロップした場合は prefill を呼ばない（no-op）", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            challenges: [challenge({ id: "C-001", title: "対象" })],
          })}
        />,
      );

      const dataTransfer = makeDataTransfer();
      const draggedCard = screen.getByText("対象").closest(".task-card");
      if (!draggedCard) throw new Error("task-card が見つかりません");
      fireEvent.dragStart(draggedCard, { dataTransfer });
      fireEvent.drop(screen.getByTestId("agent-column-row-C-001"), {
        dataTransfer,
      });

      expect(prefill).not.toHaveBeenCalled();
    });

    it("別カラム（別エージェント）のカードがドロップされても prefill を呼ばない（カラム跨ぎの誤操作防止）", () => {
      const { unmount: unmountA } = render(
        <AgentColumn
          agent={agentBoard({
            name: "medical",
            challenges: [challenge({ id: "C-001", title: "medical のタスク" })],
          })}
        />,
      );
      const dataTransfer = makeDataTransfer();
      const draggedCard = screen
        .getByText("medical のタスク")
        .closest(".task-card");
      if (!draggedCard) throw new Error("task-card が見つかりません");
      fireEvent.dragStart(draggedCard, { dataTransfer });
      unmountA();

      render(
        <AgentColumn
          agent={agentBoard({
            name: "bi",
            challenges: [challenge({ id: "C-999", title: "bi のタスク" })],
          })}
        />,
      );
      fireEvent.drop(screen.getByTestId("agent-column-row-C-999"), {
        dataTransfer,
      });

      expect(prefill).not.toHaveBeenCalled();
    });

    it("ドラッグオーバー中は対象行にドロップインジケータを表示し、dragLeave で消える", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            challenges: [
              challenge({ id: "C-047", title: "移動対象" }),
              challenge({ id: "C-044", title: "移動先隣接" }),
            ],
          })}
        />,
      );

      const targetRow = screen.getByTestId("agent-column-row-C-044");
      fireEvent.dragOver(targetRow, { dataTransfer: makeDataTransfer() });

      expect(targetRow).toHaveAttribute("data-drop-target", "true");

      fireEvent.dragLeave(targetRow);

      expect(targetRow).not.toHaveAttribute("data-drop-target");
    });

    it("最下位ドロップゾーンにカードをドロップすると、現在の最下位カードより下（最低優先度）への変更として prefill が呼ばれる", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            challenges: [
              challenge({ id: "C-047", title: "移動対象" }),
              challenge({ id: "C-044", title: "移動先隣接" }),
              challenge({ id: "C-100", title: "現在の最下位" }),
            ],
          })}
        />,
      );

      const dataTransfer = makeDataTransfer();
      const draggedCard = screen.getByText("移動対象").closest(".task-card");
      if (!draggedCard) throw new Error("task-card が見つかりません");
      fireEvent.dragStart(draggedCard, { dataTransfer });
      fireEvent.drop(screen.getByTestId("agent-column-bottom-drop-zone"), {
        dataTransfer,
      });

      expect(prefill).toHaveBeenCalledWith(
        "medical",
        "課題 C-047 の優先度を C-100 より下（最低優先度）に変更してください",
      );
    });

    it("最下位ドロップゾーンでもドロップインジケータを表示し、dragLeave で消える", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            challenges: [challenge({ id: "C-047", title: "移動対象" })],
          })}
        />,
      );

      const bottomZone = screen.getByTestId("agent-column-bottom-drop-zone");
      fireEvent.dragOver(bottomZone, { dataTransfer: makeDataTransfer() });

      expect(bottomZone).toHaveAttribute("data-drop-target", "true");

      fireEvent.dragLeave(bottomZone);

      expect(bottomZone).not.toHaveAttribute("data-drop-target");
    });
  });

  describe("承認待ちカードの操作ボタン回帰確認（FR-20）", () => {
    it("承認待ちカードがあっても、カード1件につき1つの実ボタン（詳細を開く）以外に操作ボタンは増えない", () => {
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

      // 「＋ 差し込み」（カラム単位の1操作）+ カード数分の詳細ボタンのみであること。
      expect(screen.getAllByRole("button")).toHaveLength(3);
      expect(
        screen.getByRole("button", { name: "＋ 差し込み" }),
      ).toBeInTheDocument();
    });

    it("実行中の delegate Run があっても操作ボタンは増えない（resume ボタン等は #31 の担当）", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            challenges: [challenge({ id: "C-001" })],
            runningRuns: [
              run({
                kind: "delegate",
                key: "session-1",
                challenge: "C-002",
                repo: "some/repo",
              }),
            ],
          })}
        />,
      );

      expect(screen.getAllByRole("button")).toHaveLength(2);
    });
  });

  describe("カラムヘッダのサイクル状態（P3-2）", () => {
    it('cycleStatus が running のとき「サイクル実行中」を data-cycle-status="running" で表示する', () => {
      render(<AgentColumn agent={agentBoard({ cycleStatus: "running" })} />);

      const status = screen.getByText("サイクル実行中");
      expect(status).toBeInTheDocument();
      expect(status.closest("[data-cycle-status]")).toHaveAttribute(
        "data-cycle-status",
        "running",
      );
    });

    it('cycleStatus が idle のとき「idle」を data-cycle-status="idle" で表示する', () => {
      render(<AgentColumn agent={agentBoard({ cycleStatus: "idle" })} />);

      const status = screen.getByText("idle");
      expect(status).toBeInTheDocument();
      expect(status.closest("[data-cycle-status]")).toHaveAttribute(
        "data-cycle-status",
        "idle",
      );
    });

    it("cycleStatus が未定義のとき idle 扱いで表示する", () => {
      render(<AgentColumn agent={agentBoard({ cycleStatus: undefined })} />);

      expect(screen.getByText("idle")).toBeInTheDocument();
    });

    it('cycleStatus が stale のとき「⚠ 応答なし」を data-cycle-status="stale" で表示する', () => {
      render(<AgentColumn agent={agentBoard({ cycleStatus: "stale" })} />);

      const status = screen.getByText("⚠ 応答なし");
      expect(status).toBeInTheDocument();
      expect(status.closest("[data-cycle-status]")).toHaveAttribute(
        "data-cycle-status",
        "stale",
      );
    });
  });

  describe("実行中セクション（P3-2）", () => {
    beforeEach(() => {
      vi.setSystemTime(new Date("2026-07-16T09:40:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("runningRuns が空のとき「⚡ 実行中」見出しごと表示しない", () => {
      render(<AgentColumn agent={agentBoard({ runningRuns: [] })} />);

      expect(screen.queryByText("⚡ 実行中")).not.toBeInTheDocument();
    });

    it("runningRuns があるとき「⚡ 実行中」見出しを表示する", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            runningRuns: [
              run({
                kind: "adhoc",
                key: "adhoc-1",
                title: "差し込み対応",
                startedAt: "2026-07-16T09:00:00.000Z",
              }),
            ],
          })}
        />,
      );

      expect(
        screen.getByRole("heading", { name: "⚡ 実行中", level: 3 }),
      ).toBeInTheDocument();
    });

    it("delegate の実行中 Run を課題ID・委譲先repo・経過時間で表示する", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            runningRuns: [
              run({
                kind: "delegate",
                key: "session-1",
                challenge: "C-042",
                repo: "org/service-a",
                startedAt: "2026-07-16T09:00:00.000Z",
              }),
            ],
          })}
        />,
      );

      expect(screen.getByText("C-042")).toBeInTheDocument();
      expect(screen.getByText(/org\/service-a/)).toBeInTheDocument();
      expect(screen.getByText("40分")).toBeInTheDocument();
    });

    it("adhoc の実行中 Run を title で表示する", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            runningRuns: [
              run({
                kind: "adhoc",
                key: "adhoc-1",
                title: "緊急バグ調査",
                startedAt: "2026-07-16T09:00:00.000Z",
              }),
            ],
          })}
        />,
      );

      expect(screen.getByText("緊急バグ調査")).toBeInTheDocument();
      expect(screen.getByText("40分")).toBeInTheDocument();
    });

    it("stale な Run は「応答なし（要確認）」で強調表示する", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            runningRuns: [
              run({
                kind: "adhoc",
                key: "adhoc-1",
                title: "放置タスク",
                startedAt: "2026-07-16T09:00:00.000Z",
                stale: true,
              }),
            ],
          })}
        />,
      );

      expect(screen.getByText(/応答なし（要確認）/)).toBeInTheDocument();
    });

    it("stale ではない Run には「応答なし」の警告が表示されない", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            runningRuns: [
              run({
                kind: "adhoc",
                key: "adhoc-1",
                title: "通常タスク",
                startedAt: "2026-07-16T09:00:00.000Z",
                stale: false,
              }),
            ],
          })}
        />,
      );

      expect(screen.queryByText(/応答なし/)).not.toBeInTheDocument();
    });
  });

  describe("再開コマンドの prefill 連携（#31・FR-12）", () => {
    beforeEach(() => {
      vi.setSystemTime(new Date("2026-07-16T09:40:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("stale な delegate Run には「再開コマンドを挿入」ボタンを表示する", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            name: "medical",
            runningRuns: [
              run({
                kind: "delegate",
                key: "session-1",
                challenge: "C-042",
                repo: "org/service-a",
                stale: true,
              }),
            ],
          })}
        />,
      );

      expect(
        screen.getByRole("button", { name: "再開コマンドを挿入" }),
      ).toBeInTheDocument();
    });

    it("stale ではない delegate Run にはボタンを表示しない", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            name: "medical",
            runningRuns: [
              run({
                kind: "delegate",
                key: "session-1",
                challenge: "C-042",
                repo: "org/service-a",
                stale: false,
              }),
            ],
          })}
        />,
      );

      expect(
        screen.queryByRole("button", { name: "再開コマンドを挿入" }),
      ).not.toBeInTheDocument();
    });

    it("stale な adhoc（kind !== delegate）Run にはボタンを表示しない", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            name: "medical",
            runningRuns: [
              run({
                kind: "adhoc",
                key: "adhoc-1",
                title: "放置タスク",
                stale: true,
              }),
            ],
          })}
        />,
      );

      expect(
        screen.queryByRole("button", { name: "再開コマンドを挿入" }),
      ).not.toBeInTheDocument();
    });

    it("stale な delegate Run でも repo が欠落している場合はボタンを表示しない", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            name: "medical",
            runningRuns: [
              run({
                kind: "delegate",
                key: "session-1",
                challenge: "C-042",
                repo: undefined,
                stale: true,
              }),
            ],
          })}
        />,
      );

      expect(
        screen.queryByRole("button", { name: "再開コマンドを挿入" }),
      ).not.toBeInTheDocument();
    });

    it("ボタンをクリックすると agent 名と resume コマンド文字列で prefill が呼ばれる", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            name: "medical",
            runningRuns: [
              run({
                kind: "delegate",
                key: "session-abc123",
                challenge: "C-042",
                repo: "org/service-a",
                stale: true,
              }),
            ],
          })}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: "再開コマンドを挿入" }),
      );

      expect(prefill).toHaveBeenCalledWith(
        "medical",
        "cd .flywheel/repos/org/service-a && claude -p --resume session-abc123",
      );
    });
  });

  describe("キーボードでの並べ替え（#25）", () => {
    function focusCard(title: string): HTMLElement {
      const card = screen.getByText(title).closest(".task-card");
      if (!card) throw new Error("task-card が見つかりません");
      // fireEvent.focus は合成イベントを発火するのみで document.activeElement
      // を実際には更新しない。Escape 後のフォーカス復帰確認（toHaveFocus）に
      // 実フォーカス状態が必要なため、element.focus() で実際にフォーカスする。
      (card as HTMLElement).focus();
      return card as HTMLElement;
    }

    function threeChallenges() {
      return [
        challenge({ id: "C-001", title: "1番目" }),
        challenge({ id: "C-002", title: "2番目" }),
        challenge({ id: "C-003", title: "3番目" }),
      ];
    }

    it("Alt+ArrowUp で並べ替えモードが開始し、直上行に data-drop-target が付き aria-live に「最上位」が読み上げられる", () => {
      render(
        <AgentColumn agent={agentBoard({ challenges: threeChallenges() })} />,
      );

      const card = focusCard("2番目");
      fireEvent.keyDown(card, { key: "ArrowUp", altKey: true });

      expect(screen.getByTestId("agent-column-row-C-001")).toHaveAttribute(
        "data-drop-target",
        "true",
      );
      expect(screen.getByTestId("agent-column-live-region")).toHaveTextContent(
        "並べ替え: 最上位",
      );
    });

    it("Alt+ArrowDown で並べ替えモードが開始し、最下位ドロップゾーンに data-drop-target が付き aria-live に「最下位」が読み上げられる", () => {
      render(
        <AgentColumn agent={agentBoard({ challenges: threeChallenges() })} />,
      );

      const card = focusCard("2番目");
      fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });

      expect(
        screen.getByTestId("agent-column-bottom-drop-zone"),
      ).toHaveAttribute("data-drop-target", "true");
      expect(screen.getByTestId("agent-column-live-region")).toHaveTextContent(
        "並べ替え: 最下位",
      );
    });

    it("自分自身の位置に戻る（no-op）スロットは自動的にスキップする（先頭カードの Alt+ArrowDown は隣接カードを飛び越える）", () => {
      render(
        <AgentColumn agent={agentBoard({ challenges: threeChallenges() })} />,
      );

      const card = focusCard("1番目");
      fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });

      // C-001 を C-002 の直前に置く（=no-op）はスキップされ、C-003 の直前に置く
      // スロットに止まる。
      expect(screen.getByTestId("agent-column-row-C-003")).toHaveAttribute(
        "data-drop-target",
        "true",
      );
      expect(screen.getByTestId("agent-column-live-region")).toHaveTextContent(
        "並べ替え: 移動先はC-003の上",
      );
    });

    it("同じカードで並べ替えモード中に続けて矢印キーを押すと移動先スロットが動く", () => {
      render(
        <AgentColumn agent={agentBoard({ challenges: threeChallenges() })} />,
      );

      const card = focusCard("1番目");
      fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
      expect(screen.getByTestId("agent-column-row-C-003")).toHaveAttribute(
        "data-drop-target",
        "true",
      );

      fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
      expect(
        screen.getByTestId("agent-column-bottom-drop-zone"),
      ).toHaveAttribute("data-drop-target", "true");
      expect(screen.getByTestId("agent-column-live-region")).toHaveTextContent(
        "並べ替え: 最下位",
      );
    });

    it("並べ替えモード中に Enter を押すと、移動先スロットに応じた優先度変更の指示で prefill が呼ばれモードが終了する", () => {
      render(
        <AgentColumn agent={agentBoard({ challenges: threeChallenges() })} />,
      );

      const card = focusCard("2番目");
      fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
      fireEvent.keyDown(card, { key: "Enter" });

      expect(prefill).toHaveBeenCalledWith(
        "medical",
        "課題 C-002 の優先度を C-003 より下（最低優先度）に変更してください",
      );
      expect(
        screen.getByTestId("agent-column-bottom-drop-zone"),
      ).not.toHaveAttribute("data-drop-target");
      // prefill はターミナルへの入力（未実行）に留まる（NFR-01）。実行済みと
      // 誤解させないよう、確定＝移動完了ではなく「指示を入力した」ことのみを
      // 伝える文言にする（CodeRabbit Major指摘 #2）。
      expect(screen.getByTestId("agent-column-live-region")).toHaveTextContent(
        "並べ替え指示をターミナルに入力しました（Enter で実行）",
      );
    });

    it("並べ替えモード中の Enter はカードの詳細モーダルを開かない", () => {
      render(
        <AgentColumn agent={agentBoard({ challenges: threeChallenges() })} />,
      );

      const card = focusCard("2番目");
      fireEvent.keyDown(card, { key: "ArrowUp", altKey: true });
      fireEvent.keyDown(card, { key: "Enter" });

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("並べ替えモード中に Escape を押すと、prefill されずモードが終了しフォーカスはカードに残る", () => {
      render(
        <AgentColumn agent={agentBoard({ challenges: threeChallenges() })} />,
      );

      const card = focusCard("2番目");
      fireEvent.keyDown(card, { key: "ArrowUp", altKey: true });
      fireEvent.keyDown(card, { key: "Escape" });

      expect(prefill).not.toHaveBeenCalled();
      expect(screen.getByTestId("agent-column-row-C-001")).not.toHaveAttribute(
        "data-drop-target",
      );
      expect(card).toHaveFocus();
      expect(screen.getByTestId("agent-column-live-region")).toHaveTextContent(
        "並べ替えをキャンセルしました",
      );
    });

    it("確定（Enter）後は素の Enter で詳細モーダルが開く挙動に戻る", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
      render(
        <AgentColumn agent={agentBoard({ challenges: threeChallenges() })} />,
      );

      const card = focusCard("2番目");
      fireEvent.keyDown(card, { key: "ArrowUp", altKey: true });
      fireEvent.keyDown(card, { key: "Enter" });
      vi.mocked(prefill).mockClear();

      fireEvent.keyDown(card, { key: "Enter" });

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("キャンセル（Escape）後は素の Enter で詳細モーダルが開く挙動に戻る", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
      render(
        <AgentColumn agent={agentBoard({ challenges: threeChallenges() })} />,
      );

      const card = focusCard("2番目");
      fireEvent.keyDown(card, { key: "ArrowUp", altKey: true });
      fireEvent.keyDown(card, { key: "Escape" });

      fireEvent.keyDown(card, { key: "Enter" });

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("並べ替えモード中に Enter を押すと、最上位（スロット0）確定でも正しい指示文で prefill される", () => {
      render(
        <AgentColumn agent={agentBoard({ challenges: threeChallenges() })} />,
      );

      // C-003（末尾）から2回 Alt+ArrowUp すると、C-002 を飛び越えて
      // スロット0（最上位・C-001の前）に到達する。
      const card = focusCard("3番目");
      fireEvent.keyDown(card, { key: "ArrowUp", altKey: true });
      fireEvent.keyDown(card, { key: "ArrowUp", altKey: true });
      expect(screen.getByTestId("agent-column-live-region")).toHaveTextContent(
        "並べ替え: 最上位",
      );

      fireEvent.keyDown(card, { key: "Enter" });

      // スロット0の隣接カードは現在の先頭 C-001 であり、buildReorderInstruction
      // の「隣接カードなし＝最上位」の特別なテキストは（自分自身以外に必ず
      // 隣接カードが存在するため）並べ替えでは使われず、C-001 との相対指示になる。
      expect(prefill).toHaveBeenCalledWith(
        "medical",
        "課題 C-003 の優先度を C-001 より上（適切な優先度で）に変更してください",
      );
    });

    it("並べ替えモード中に Enter を押すと、中間スロット確定時は隣接カードの優先度を反映した指示文で prefill される", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            challenges: [
              challenge({ id: "C-001", title: "1番目" }),
              challenge({ id: "C-002", title: "2番目" }),
              challenge({ id: "C-003", priority: "P2", title: "3番目" }),
            ],
          })}
        />,
      );

      const card = focusCard("1番目");
      fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
      expect(screen.getByTestId("agent-column-live-region")).toHaveTextContent(
        "並べ替え: 移動先はC-003の上",
      );

      fireEvent.keyDown(card, { key: "Enter" });

      expect(prefill).toHaveBeenCalledWith(
        "medical",
        "課題 C-001 の優先度を C-003 より上（P2 以上）に変更してください",
      );
    });

    it("並べ替えモード中に agent.challenges が変化（fs-watch 反映等）してスロットが無効になった場合、モードは静かに終了する（古いスロットで誤って prefill しない）", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
      const { rerender } = render(
        <AgentColumn agent={agentBoard({ challenges: threeChallenges() })} />,
      );

      const card = focusCard("2番目");
      // C-002 を末尾（スロット3）へ移動しようとしている最中とする。
      fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
      expect(
        screen.getByTestId("agent-column-bottom-drop-zone"),
      ).toHaveAttribute("data-drop-target", "true");

      // その間に台帳側の更新が反映され、C-003 が無くなった（配列が縮んだ）。
      rerender(
        <AgentColumn
          agent={agentBoard({
            challenges: [
              challenge({ id: "C-001", title: "1番目" }),
              challenge({ id: "C-002", title: "2番目" }),
            ],
          })}
        />,
      );

      expect(
        screen.queryByTestId("agent-column-bottom-drop-zone"),
      ).not.toHaveAttribute("data-drop-target");

      // 並べ替えモードは終了しているため、Enter は素の詳細モーダルを開く
      // 挙動に戻っているはず。
      const refreshedCard = screen.getByText("2番目").closest(".task-card");
      if (!refreshedCard) throw new Error("task-card が見つかりません");
      fireEvent.keyDown(refreshedCard, { key: "Enter" });

      expect(prefill).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("並べ替えモード中に配列の並びが変わり、保持中のスロットが結果的に no-op（隣接カードが自分自身相当）になった場合はモードを終了し prefill しない", () => {
      const { rerender } = render(
        <AgentColumn agent={agentBoard({ challenges: threeChallenges() })} />,
      );

      const card = focusCard("1番目");
      // C-001（先頭）を1段下げる → スロット2（C-003 の前）へ。
      fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
      expect(screen.getByTestId("agent-column-row-C-003")).toHaveAttribute(
        "data-drop-target",
        "true",
      );

      // 外部要因で配列の並びが変わり、C-001 の直後が C-003 になった
      // （= 保持中のスロット2は C-001 にとって no-op に変化）。
      rerender(
        <AgentColumn
          agent={agentBoard({
            challenges: [
              challenge({ id: "C-002", title: "2番目" }),
              challenge({ id: "C-001", title: "1番目" }),
              challenge({ id: "C-003", title: "3番目" }),
            ],
          })}
        />,
      );

      expect(
        screen.queryByTestId("agent-column-row-C-003"),
      ).not.toHaveAttribute("data-drop-target");

      const refreshedCard = screen.getByText("1番目").closest(".task-card");
      if (!refreshedCard) throw new Error("task-card が見つかりません");
      fireEvent.keyDown(refreshedCard, { key: "Enter" });

      expect(prefill).not.toHaveBeenCalled();
    });

    it("並べ替えモード中に challenges が差し替わり、保持中のスロットが有効なまま指す隣接課題だけが別課題にすり替わった場合、確定してもprefillされずキャンセル通知される（CodeRabbit Major指摘 #1）", () => {
      const { rerender } = render(
        <AgentColumn agent={agentBoard({ challenges: threeChallenges() })} />,
      );

      const card = focusCard("1番目");
      // C-001（先頭）を1段下げる → スロット2（元々は C-003 の前＝読み上げは
      // 「移動先はC-003の上」）へ。
      fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
      expect(screen.getByTestId("agent-column-live-region")).toHaveTextContent(
        "並べ替え: 移動先はC-003の上",
      );

      // 監視更新（fs-watch/WS）により、C-001 自身の位置は変わらないまま
      // スロット2の直前に別の課題（D-999）が挿入された。isNoOpSlot による
      // 範囲・no-op 判定だけでは検知できない（selfIndex・slot自体は依然
      // 有効なまま）が、スロット2が指す隣接課題は C-003 から D-999 に
      // すり替わっている。
      rerender(
        <AgentColumn
          agent={agentBoard({
            challenges: [
              challenge({ id: "C-001", title: "1番目" }),
              challenge({ id: "C-002", title: "2番目" }),
              challenge({ id: "D-999", title: "差し込まれた課題" }),
              challenge({ id: "C-003", title: "3番目" }),
            ],
          })}
        />,
      );

      const refreshedCard = screen.getByText("1番目").closest(".task-card");
      if (!refreshedCard) throw new Error("task-card が見つかりません");
      fireEvent.keyDown(refreshedCard, { key: "Enter" });

      // 読み上げた基準（C-003）と異なる課題（D-999）を基準にした指示文が
      // 誤って prefill されてはならない。
      expect(prefill).not.toHaveBeenCalled();
      expect(screen.getByTestId("agent-column-live-region")).toHaveTextContent(
        "カードの並びが変わったため並べ替えをキャンセルしました",
      );
    });

    it("要素が1件のみのカラムでは移動先が無いため並べ替えモードが実質開始しない（インジケータが付かない）", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            challenges: [challenge({ id: "C-001", title: "唯一のタスク" })],
          })}
        />,
      );

      const card = focusCard("唯一のタスク");
      fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
      fireEvent.keyDown(card, { key: "ArrowUp", altKey: true });

      expect(screen.getByTestId("agent-column-row-C-001")).not.toHaveAttribute(
        "data-drop-target",
      );
      expect(
        screen.getByTestId("agent-column-bottom-drop-zone"),
      ).not.toHaveAttribute("data-drop-target");
    });
  });

  describe("差し込みゴーストのキーボード確定（#25）", () => {
    it("内容入力欄で Enter を押すと、先頭位置（adjacentChallengeAt(0)）で prefill が呼ばれゴーストが閉じる", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            challenges: [
              challenge({ id: "C-044", priority: "P1", title: "先頭タスク" }),
            ],
          })}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));
      const input = screen.getByPlaceholderText("課題の内容");
      fireEvent.change(input, { target: { value: "新しい課題" } });

      fireEvent.keyDown(input, { key: "Enter" });

      expect(prefill).toHaveBeenCalledWith(
        "medical",
        "差し込み: 「新しい課題」を課題台帳に追加してください。優先度は C-044 より上（P1 相当）でお願いします",
      );
      expect(
        screen.queryByPlaceholderText("課題の内容"),
      ).not.toBeInTheDocument();
    });

    it("内容が空（trim 後に空文字）の状態で Enter を押しても prefill されずゴーストは維持される", () => {
      render(<AgentColumn agent={agentBoard({ challenges: [] })} />);
      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));
      const input = screen.getByPlaceholderText("課題の内容");

      fireEvent.keyDown(input, { key: "Enter" });

      expect(prefill).not.toHaveBeenCalled();
      expect(screen.getByPlaceholderText("課題の内容")).toBeInTheDocument();
    });

    it("内容が空白文字のみの状態で Enter を押しても prefill されずゴーストは維持される", () => {
      render(<AgentColumn agent={agentBoard({ challenges: [] })} />);
      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));
      const input = screen.getByPlaceholderText("課題の内容");
      fireEvent.change(input, { target: { value: "   " } });

      fireEvent.keyDown(input, { key: "Enter" });

      expect(prefill).not.toHaveBeenCalled();
      expect(screen.getByPlaceholderText("課題の内容")).toBeInTheDocument();
    });

    it("内容入力欄で Escape を押すとゴーストが破棄される（prefill されない）", () => {
      render(<AgentColumn agent={agentBoard({ challenges: [] })} />);
      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));
      const input = screen.getByPlaceholderText("課題の内容");
      fireEvent.change(input, { target: { value: "新しい課題" } });

      fireEvent.keyDown(input, { key: "Escape" });

      expect(prefill).not.toHaveBeenCalled();
      expect(
        screen.queryByPlaceholderText("課題の内容"),
      ).not.toBeInTheDocument();
    });

    // IME変換中のガード（CodeRabbit Major指摘 #3）: 変換確定のためだけに
    // 押した Enter が、ゴースト確定（prefill）に化けてはならない。同様に
    // 変換候補を打ち消す Escape がゴースト破棄に化けてもならない。
    it("IME変換確定中（isComposing）の Enter では prefill されずゴーストが維持される", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            challenges: [
              challenge({ id: "C-044", priority: "P1", title: "先頭タスク" }),
            ],
          })}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));
      const input = screen.getByPlaceholderText("課題の内容");
      fireEvent.change(input, { target: { value: "新しい課題" } });

      fireEvent.keyDown(input, { key: "Enter", isComposing: true });

      expect(prefill).not.toHaveBeenCalled();
      expect(screen.getByPlaceholderText("課題の内容")).toBeInTheDocument();
    });

    it("IME変換中（isComposing）の Escape ではゴーストが破棄されない", () => {
      render(<AgentColumn agent={agentBoard({ challenges: [] })} />);
      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));
      const input = screen.getByPlaceholderText("課題の内容");
      fireEvent.change(input, { target: { value: "新しい課題" } });

      fireEvent.keyDown(input, { key: "Escape", isComposing: true });

      expect(prefill).not.toHaveBeenCalled();
      expect(screen.getByPlaceholderText("課題の内容")).toBeInTheDocument();
    });
  });

  describe("ゴースト破棄後のフォーカス復帰（CodeRabbit Major指摘 #4）", () => {
    it("Escapeでゴーストを破棄すると「＋ 差し込み」ボタンにフォーカスが戻る", () => {
      render(<AgentColumn agent={agentBoard({ challenges: [] })} />);
      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));
      const input = screen.getByPlaceholderText("課題の内容");

      fireEvent.keyDown(input, { key: "Escape" });

      expect(screen.getByRole("button", { name: "＋ 差し込み" })).toHaveFocus();
    });

    it("Enterでゴーストを確定した後も「＋ 差し込み」ボタンにフォーカスが戻る", () => {
      render(
        <AgentColumn
          agent={agentBoard({
            challenges: [
              challenge({ id: "C-044", priority: "P1", title: "先頭タスク" }),
            ],
          })}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "＋ 差し込み" }));
      const input = screen.getByPlaceholderText("課題の内容");
      fireEvent.change(input, { target: { value: "新しい課題" } });

      fireEvent.keyDown(input, { key: "Enter" });

      expect(screen.getByRole("button", { name: "＋ 差し込み" })).toHaveFocus();
    });
  });

  describe("archiveMode（Issue #50 ①）", () => {
    it("archivedChallenges をミニマル表示する（id/title/status）", () => {
      render(
        <AgentColumn
          archiveMode
          agent={agentBoard({
            archivedChallenges: [
              challenge({
                id: "C-900",
                title: "アーカイブ済みタスク",
                status: "完了",
              }),
            ],
          })}
        />,
      );

      expect(screen.getByText("アーカイブ済みタスク")).toBeInTheDocument();
      expect(screen.getByText("C-900")).toBeInTheDocument();
      expect(screen.getByText("完了")).toBeInTheDocument();
    });

    it("archivedChallenges が空でもクラッシュせず空表示になる", () => {
      render(
        <AgentColumn
          archiveMode
          agent={agentBoard({ archivedChallenges: [] })}
        />,
      );

      expect(screen.getByText("medical")).toBeInTheDocument();
    });

    it("archiveMode 中は実行中セクション・＋差し込みボタンを表示しない", () => {
      render(
        <AgentColumn
          archiveMode
          agent={agentBoard({
            runningRuns: [
              run({
                kind: "adhoc",
                key: "adhoc-1",
                title: "実行中タスク",
              }),
            ],
          })}
        />,
      );

      expect(
        screen.queryByRole("heading", { name: "⚡ 実行中", level: 3 }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "＋ 差し込み" }),
      ).not.toBeInTheDocument();
    });

    it("archiveMode 中は live challenges ではなく archivedChallenges のみを表示する", () => {
      render(
        <AgentColumn
          archiveMode
          agent={agentBoard({
            challenges: [challenge({ id: "C-001", title: "現行タスク" })],
            archivedChallenges: [
              challenge({
                id: "C-900",
                title: "アーカイブ済みタスク",
                status: "完了",
              }),
            ],
          })}
        />,
      );

      expect(screen.getByText("アーカイブ済みタスク")).toBeInTheDocument();
      expect(screen.queryByText("現行タスク")).not.toBeInTheDocument();
    });
  });
});
