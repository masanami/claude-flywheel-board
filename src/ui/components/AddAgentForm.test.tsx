import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AddAgentForm } from "./AddAgentForm.tsx";

// 既存エージェントの絶対パスから算出されたベースディレクトリのヒント
// （Board.tsx の computeBasePathHint 相当。実際の算出ロジックは
// Board.test.tsx 側で検証する）。本ファイルでは AddAgentForm が
// basePath prop をそのまま使うことだけを検証する。
const TEST_BASE_PATH = "/agents";

function resolvedSubmit() {
  return vi.fn().mockResolvedValue({ ok: true });
}

describe("AddAgentForm", () => {
  // モーダル開閉機構（ネイティブ dialog + showModal()）は CardDetailModal.tsx
  // と同じパターンを踏襲している（AddAgentForm.tsx 冒頭コメント参照）。
  // セルフレビュー指摘: 複製元の CardDetailModal.test.tsx に揃っている
  // 開閉経路のテスト（StrictMode 二重 effect ガード・ESC・オーバーレイ
  // クリック・内側クリックでは閉じない・ドラッグ誤爆防止）が本ファイルに
  // 無く、複製ミス（ガード欠落・判定漏れ）を検知できない状態だったため追加する。
  it("StrictMode（effect の setup → cleanup → setup 二重実行）でも InvalidStateError にならず開く", () => {
    expect(() =>
      render(
        <StrictMode>
          <AddAgentForm
            onClose={vi.fn()}
            onSubmit={resolvedSubmit()}
            basePath={TEST_BASE_PATH}
          />
        </StrictMode>,
      ),
    ).not.toThrow();
    expect(screen.getByTestId("add-agent-form")).toBeInTheDocument();
  });

  it("ESC キーで onClose が呼ばれる", () => {
    const onClose = vi.fn();
    render(
      <AddAgentForm
        onClose={onClose}
        onSubmit={resolvedSubmit()}
        basePath={TEST_BASE_PATH}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });

  it("オーバーレイクリックで onClose が呼ばれる", () => {
    const onClose = vi.fn();
    render(
      <AddAgentForm
        onClose={onClose}
        onSubmit={resolvedSubmit()}
        basePath={TEST_BASE_PATH}
      />,
    );

    // 実ブラウザでのクリックは mousedown → click の順でイベントが発火するため、
    // 実装側の「押下と確定が両方オーバーレイ上」判定に合わせて両方 fire する。
    const overlay = screen.getByTestId("add-agent-form");
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);

    expect(onClose).toHaveBeenCalled();
  });

  it("フォーム内クリックでは onClose が呼ばれない", () => {
    const onClose = vi.fn();
    render(
      <AddAgentForm
        onClose={onClose}
        onSubmit={resolvedSubmit()}
        basePath={TEST_BASE_PATH}
      />,
    );

    fireEvent.click(screen.getByTestId("add-agent-form-content"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("フォーム内で押下を開始しオーバーレイ上でクリックが確定しても onClose は呼ばれない（テキスト選択ドラッグの誤爆防止）", () => {
    const onClose = vi.fn();
    render(
      <AddAgentForm
        onClose={onClose}
        onSubmit={resolvedSubmit()}
        basePath={TEST_BASE_PATH}
      />,
    );

    fireEvent.mouseDown(screen.getByTestId("add-agent-form-content"));
    fireEvent.click(screen.getByTestId("add-agent-form"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("エージェント名・パスの入力欄を表示する", () => {
    render(
      <AddAgentForm
        onClose={vi.fn()}
        onSubmit={resolvedSubmit()}
        basePath={TEST_BASE_PATH}
      />,
    );

    expect(
      screen.getByRole("textbox", { name: "エージェント名" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "パス" })).toBeInTheDocument();
  });

  it("パス欄は basePath prop を初期値として表示する", () => {
    render(
      <AddAgentForm
        onClose={vi.fn()}
        onSubmit={resolvedSubmit()}
        basePath={TEST_BASE_PATH}
      />,
    );

    expect(screen.getByRole("textbox", { name: "パス" })).toHaveValue(
      TEST_BASE_PATH,
    );
  });

  it("basePath が空文字（既存エージェントが無い）の場合、パス欄は空で始まる", () => {
    render(
      <AddAgentForm
        onClose={vi.fn()}
        onSubmit={resolvedSubmit()}
        basePath=""
      />,
    );

    expect(screen.getByRole("textbox", { name: "パス" })).toHaveValue("");
  });

  it("basePath が空文字の場合、エージェント名を入力してもパス欄は空のまま（相対パスを既定値にしない）", () => {
    render(
      <AddAgentForm
        onClose={vi.fn()}
        onSubmit={resolvedSubmit()}
        basePath=""
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "エージェント名" }), {
      target: { value: "harness-guardian" },
    });

    expect(screen.getByRole("textbox", { name: "パス" })).toHaveValue("");
  });

  it('絶対パス（"/" 始まり）でないパスを入力して送信すると、エラーが表示され onSubmit は呼ばれない', () => {
    const onSubmit = resolvedSubmit();
    render(
      <AddAgentForm
        onClose={vi.fn()}
        onSubmit={onSubmit}
        basePath={TEST_BASE_PATH}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "エージェント名" }), {
      target: { value: "harness-guardian" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "パス" }), {
      target: { value: "relative/path" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(screen.getByTestId("add-agent-form-errors")).toHaveTextContent(
      "絶対パスで入力してください",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("エージェント名を入力すると、パス欄が basePath＋名前に自動更新される", () => {
    render(
      <AddAgentForm
        onClose={vi.fn()}
        onSubmit={resolvedSubmit()}
        basePath={TEST_BASE_PATH}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "エージェント名" }), {
      target: { value: "harness-guardian" },
    });

    expect(screen.getByRole("textbox", { name: "パス" })).toHaveValue(
      `${TEST_BASE_PATH}/harness-guardian`,
    );
  });

  it("パス欄を手動編集した後は、名前変更による自動補完で上書きされない", () => {
    render(
      <AddAgentForm
        onClose={vi.fn()}
        onSubmit={resolvedSubmit()}
        basePath={TEST_BASE_PATH}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "パス" }), {
      target: { value: "/custom/path" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "エージェント名" }), {
      target: { value: "harness-guardian" },
    });

    expect(screen.getByRole("textbox", { name: "パス" })).toHaveValue(
      "/custom/path",
    );
  });

  it("名前が空欄のまま送信すると、エラーが表示され onSubmit は呼ばれない", () => {
    const onSubmit = resolvedSubmit();
    render(
      <AddAgentForm
        onClose={vi.fn()}
        onSubmit={onSubmit}
        basePath={TEST_BASE_PATH}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(screen.getByTestId("add-agent-form-errors")).toHaveTextContent(
      "エージェント名を入力してください",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("パスが空欄のまま送信すると、エラーが表示され onSubmit は呼ばれない", () => {
    const onSubmit = resolvedSubmit();
    render(
      <AddAgentForm
        onClose={vi.fn()}
        onSubmit={onSubmit}
        basePath={TEST_BASE_PATH}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "エージェント名" }), {
      target: { value: "harness-guardian" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "パス" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(screen.getByTestId("add-agent-form-errors")).toHaveTextContent(
      "パスを入力してください",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('エージェント名が "-shell" で終わる場合、エラーが表示され onSubmit は呼ばれない', () => {
    const onSubmit = resolvedSubmit();
    render(
      <AddAgentForm
        onClose={vi.fn()}
        onSubmit={onSubmit}
        basePath={TEST_BASE_PATH}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "エージェント名" }), {
      target: { value: "foo-shell" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(screen.getByTestId("add-agent-form-errors")).toHaveTextContent(
      "-shell",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("有効な入力で送信すると、onSubmit がエージェント名・パスで呼ばれる（送信完了までフォームは閉じない）", async () => {
    let resolveSubmit: (result: { ok: true }) => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const onClose = vi.fn();
    render(
      <AddAgentForm
        onClose={onClose}
        onSubmit={onSubmit}
        basePath={TEST_BASE_PATH}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "エージェント名" }), {
      target: { value: "harness-guardian" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "harness-guardian",
      path: `${TEST_BASE_PATH}/harness-guardian`,
    });
    // onSubmit の Promise が解決するまではフォームを閉じない（サーバー側
    // バリデーションエラーの可能性があるため）。
    expect(onClose).not.toHaveBeenCalled();

    resolveSubmit({ ok: true });
    await screen.findByTestId("add-agent-form"); // 次のマイクロタスクを待つ
    expect(onClose).toHaveBeenCalled();
  });

  it("onSubmit が ok:true で解決すると、フォームが閉じる（onClose 発火）", async () => {
    const onSubmit = resolvedSubmit();
    const onClose = vi.fn();
    render(
      <AddAgentForm
        onClose={onClose}
        onSubmit={onSubmit}
        basePath={TEST_BASE_PATH}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "エージェント名" }), {
      target: { value: "harness-guardian" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("onSubmit が ok:false で解決すると、サーバー側エラーがフォームに表示され、フォームは閉じない", async () => {
    const onSubmit = vi.fn().mockResolvedValue({
      ok: false,
      error: 'name "foo" が既存と重複しています',
    });
    const onClose = vi.fn();
    render(
      <AddAgentForm
        onClose={onClose}
        onSubmit={onSubmit}
        basePath={TEST_BASE_PATH}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "エージェント名" }), {
      target: { value: "foo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    await waitFor(() => {
      expect(screen.getByTestId("add-agent-form-errors")).toHaveTextContent(
        'name "foo" が既存と重複しています',
      );
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("add-agent-form")).toBeInTheDocument();
  });

  it("送信中（onSubmit の Promise が未解決の間）は送信ボタンが無効化される", async () => {
    let resolveSubmit: (result: { ok: true }) => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    render(
      <AddAgentForm
        onClose={vi.fn()}
        onSubmit={onSubmit}
        basePath={TEST_BASE_PATH}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "エージェント名" }), {
      target: { value: "harness-guardian" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(screen.getByRole("button", { name: "追加" })).toBeDisabled();

    resolveSubmit({ ok: true });
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
  });

  it("「閉じる」ボタンをクリックすると onClose が呼ばれる", () => {
    const onClose = vi.fn();
    render(
      <AddAgentForm
        onClose={onClose}
        onSubmit={resolvedSubmit()}
        basePath={TEST_BASE_PATH}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));

    expect(onClose).toHaveBeenCalled();
  });

  it("開いた直後、エージェント名の入力欄にフォーカスが当たる", () => {
    render(
      <AddAgentForm
        onClose={vi.fn()}
        onSubmit={resolvedSubmit()}
        basePath={TEST_BASE_PATH}
      />,
    );

    expect(
      screen.getByRole("textbox", { name: "エージェント名" }),
    ).toHaveFocus();
  });

  it("エラー表示後に再入力すると、エラー表示が消える", () => {
    render(
      <AddAgentForm
        onClose={vi.fn()}
        onSubmit={resolvedSubmit()}
        basePath={TEST_BASE_PATH}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    expect(screen.getByTestId("add-agent-form-errors")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "エージェント名" }), {
      target: { value: "harness-guardian" },
    });

    expect(
      screen.queryByTestId("add-agent-form-errors"),
    ).not.toBeInTheDocument();
  });

  it("先頭・末尾に空白を含む名前を入力しても、自動補完されたパスに余分な空白が入らない", () => {
    render(
      <AddAgentForm
        onClose={vi.fn()}
        onSubmit={resolvedSubmit()}
        basePath={TEST_BASE_PATH}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "エージェント名" }), {
      target: { value: " harness-guardian " },
    });

    expect(screen.getByRole("textbox", { name: "パス" })).toHaveValue(
      `${TEST_BASE_PATH}/harness-guardian`,
    );
  });
});
