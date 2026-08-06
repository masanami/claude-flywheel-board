import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AddAgentForm } from "./AddAgentForm.tsx";

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
          <AddAgentForm onClose={vi.fn()} onSubmit={vi.fn()} />
        </StrictMode>,
      ),
    ).not.toThrow();
    expect(screen.getByTestId("add-agent-form")).toBeInTheDocument();
  });

  it("ESC キーで onClose が呼ばれる", () => {
    const onClose = vi.fn();
    render(<AddAgentForm onClose={onClose} onSubmit={vi.fn()} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });

  it("オーバーレイクリックで onClose が呼ばれる", () => {
    const onClose = vi.fn();
    render(<AddAgentForm onClose={onClose} onSubmit={vi.fn()} />);

    // 実ブラウザでのクリックは mousedown → click の順でイベントが発火するため、
    // 実装側の「押下と確定が両方オーバーレイ上」判定に合わせて両方 fire する。
    const overlay = screen.getByTestId("add-agent-form");
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);

    expect(onClose).toHaveBeenCalled();
  });

  it("フォーム内クリックでは onClose が呼ばれない", () => {
    const onClose = vi.fn();
    render(<AddAgentForm onClose={onClose} onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByTestId("add-agent-form-content"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("フォーム内で押下を開始しオーバーレイ上でクリックが確定しても onClose は呼ばれない（テキスト選択ドラッグの誤爆防止）", () => {
    const onClose = vi.fn();
    render(<AddAgentForm onClose={onClose} onSubmit={vi.fn()} />);

    fireEvent.mouseDown(screen.getByTestId("add-agent-form-content"));
    fireEvent.click(screen.getByTestId("add-agent-form"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("エージェント名・パスの入力欄を表示する", () => {
    render(<AddAgentForm onClose={vi.fn()} onSubmit={vi.fn()} />);

    expect(
      screen.getByRole("textbox", { name: "エージェント名" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "パス" })).toBeInTheDocument();
  });

  it("パス欄はベースディレクトリを初期値として表示する", () => {
    render(<AddAgentForm onClose={vi.fn()} onSubmit={vi.fn()} />);

    expect(screen.getByRole("textbox", { name: "パス" })).toHaveValue(
      "~/agents",
    );
  });

  it("エージェント名を入力すると、パス欄がベースディレクトリ＋名前に自動更新される", () => {
    render(<AddAgentForm onClose={vi.fn()} onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByRole("textbox", { name: "エージェント名" }), {
      target: { value: "harness-guardian" },
    });

    expect(screen.getByRole("textbox", { name: "パス" })).toHaveValue(
      "~/agents/harness-guardian",
    );
  });

  it("パス欄を手動編集した後は、名前変更による自動補完で上書きされない", () => {
    render(<AddAgentForm onClose={vi.fn()} onSubmit={vi.fn()} />);

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
    const onSubmit = vi.fn();
    render(<AddAgentForm onClose={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(screen.getByTestId("add-agent-form-errors")).toHaveTextContent(
      "エージェント名を入力してください",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("パスが空欄のまま送信すると、エラーが表示され onSubmit は呼ばれない", () => {
    const onSubmit = vi.fn();
    render(<AddAgentForm onClose={vi.fn()} onSubmit={onSubmit} />);

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
    const onSubmit = vi.fn();
    render(<AddAgentForm onClose={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByRole("textbox", { name: "エージェント名" }), {
      target: { value: "foo-shell" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(screen.getByTestId("add-agent-form-errors")).toHaveTextContent(
      "-shell",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("有効な入力で送信すると、onSubmit がエージェント名・パスで呼ばれ、フォームが閉じる（onClose 発火）", () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(<AddAgentForm onClose={onClose} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByRole("textbox", { name: "エージェント名" }), {
      target: { value: "harness-guardian" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "harness-guardian",
      path: "~/agents/harness-guardian",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("「閉じる」ボタンをクリックすると onClose が呼ばれる", () => {
    const onClose = vi.fn();
    render(<AddAgentForm onClose={onClose} onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));

    expect(onClose).toHaveBeenCalled();
  });

  it("開いた直後、エージェント名の入力欄にフォーカスが当たる", () => {
    render(<AddAgentForm onClose={vi.fn()} onSubmit={vi.fn()} />);

    expect(
      screen.getByRole("textbox", { name: "エージェント名" }),
    ).toHaveFocus();
  });

  it("エラー表示後に再入力すると、エラー表示が消える", () => {
    render(<AddAgentForm onClose={vi.fn()} onSubmit={vi.fn()} />);

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
    render(<AddAgentForm onClose={vi.fn()} onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByRole("textbox", { name: "エージェント名" }), {
      target: { value: " harness-guardian " },
    });

    expect(screen.getByRole("textbox", { name: "パス" })).toHaveValue(
      "~/agents/harness-guardian",
    );
  });
});
