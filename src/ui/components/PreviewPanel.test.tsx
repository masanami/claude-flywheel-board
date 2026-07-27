import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";
import { PreviewPanel } from "./PreviewPanel.tsx";

// PreviewPanel シェル（#64）: 開閉・幅ドラッグ・レイアウトのみを検証する。
// 中身（ファイルツリー・Markdownレンダリング・ライブ更新）は後続チケット
// （#68/#69/#70）のスコープのため、ここでは placeholder の存在のみ確認する。

describe("PreviewPanel", () => {
  it("初期状態では閉じており、開くボタンが表示される", () => {
    render(<PreviewPanel />);

    expect(
      screen.getByRole("button", { name: "プレビューパネルを開く" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("preview-panel-body")).not.toBeInTheDocument();
  });

  it("開くボタンをクリックするとパネルが開き、本文領域が表示される", () => {
    render(<PreviewPanel />);

    act(() => {
      screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
    });

    expect(screen.getByTestId("preview-panel-body")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "プレビューパネルを閉じる" }),
    ).toBeInTheDocument();
  });

  it("開いた状態で閉じるボタンをクリックすると本文領域が非表示になる", () => {
    render(<PreviewPanel />);

    act(() => {
      screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
    });
    act(() => {
      screen.getByRole("button", { name: "プレビューパネルを閉じる" }).click();
    });

    expect(screen.queryByTestId("preview-panel-body")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "プレビューパネルを開く" }),
    ).toBeInTheDocument();
  });

  it("開閉トグルボタンの aria-expanded が開閉状態を反映する", () => {
    render(<PreviewPanel />);

    const toggle = screen.getByRole("button", {
      name: "プレビューパネルを開く",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    act(() => {
      toggle.click();
    });

    expect(
      screen.getByRole("button", { name: "プレビューパネルを閉じる" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("パネルヘッダにリフレッシュボタンの placeholder が表示され、クリックしても状態が変化しない（no-op）", () => {
    render(<PreviewPanel />);

    act(() => {
      screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
    });

    const panel = screen.getByTestId("preview-panel");
    const refreshButton = screen.getByTestId("preview-panel-refresh-button");
    expect(refreshButton).toBeInTheDocument();
    const widthBefore = panel.style.width;

    act(() => {
      refreshButton.click();
    });

    // no-op であることを、クリック前後で状態（開閉・幅・本文表示）が
    // 一切変化しないことで確認する（例外を投げないことだけの検証は
    // no-op の証明にならないため、意味のあるアサーションに置き換えた
    // — セルフレビュー指摘）。
    expect(panel.style.width).toBe(widthBefore);
    expect(screen.getByTestId("preview-panel-body")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "プレビューパネルを閉じる" }),
    ).toBeInTheDocument();
  });

  it("閉じている間は幅調整ハンドルがDOMに存在しない", () => {
    render(<PreviewPanel />);

    expect(
      screen.queryByTestId("preview-panel-resize-handle"),
    ).not.toBeInTheDocument();
  });

  it("パネルを閉じてから再度開いても、直前に調整した幅を保持する", () => {
    render(<PreviewPanel />);

    act(() => {
      screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
    });

    const handle = screen.getByTestId("preview-panel-resize-handle");
    act(() => {
      fireEvent.keyDown(handle, { key: "ArrowLeft" });
    });

    const panel = screen.getByTestId("preview-panel");
    expect(panel.style.width).toBe("392px");

    act(() => {
      screen.getByRole("button", { name: "プレビューパネルを閉じる" }).click();
    });
    act(() => {
      screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
    });

    expect(screen.getByTestId("preview-panel").style.width).toBe("392px");
  });

  describe("幅調整（パネルを開いた状態）", () => {
    it("幅調整ハンドルが separator ロールと aria 属性を持つ", () => {
      render(<PreviewPanel />);
      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      const handle = screen.getByTestId("preview-panel-resize-handle");
      expect(handle).toHaveAttribute("role", "separator");
      expect(handle).toHaveAttribute("aria-orientation", "vertical");
      expect(handle).toHaveAttribute("aria-valuenow", "360");
      expect(handle).toHaveAttribute("aria-valuemin", "240");
      expect(handle).toHaveAttribute("aria-valuemax", "800");
      expect(handle).toHaveAttribute("tabIndex", "0");
    });

    it("ハンドルを左方向へドラッグするとパネル幅が増え、aria-valuenow も追随する", () => {
      render(<PreviewPanel />);
      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      const panel = screen.getByTestId("preview-panel");
      const handle = screen.getByTestId("preview-panel-resize-handle");
      const widthBefore = panel.style.width;

      act(() => {
        fireEvent.mouseDown(handle, { clientX: 500 });
        fireEvent.mouseMove(window, { clientX: 400 });
        fireEvent.mouseUp(window);
      });

      expect(panel.style.width).not.toBe(widthBefore);
      expect(panel.style.width).toBe("460px");
      expect(handle).toHaveAttribute("aria-valuenow", "460");
    });

    it("ハンドルを右方向へドラッグするとパネル幅が減る", () => {
      render(<PreviewPanel />);
      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      const panel = screen.getByTestId("preview-panel");
      const handle = screen.getByTestId("preview-panel-resize-handle");

      act(() => {
        fireEvent.mouseDown(handle, { clientX: 500 });
        fireEvent.mouseMove(window, { clientX: 560 });
        fireEvent.mouseUp(window);
      });

      expect(panel.style.width).toBe("300px");
    });

    it("マウスドラッグで下限（240px）を超えて右方向に動かしても下限で止まる", () => {
      render(<PreviewPanel />);
      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      const panel = screen.getByTestId("preview-panel");
      const handle = screen.getByTestId("preview-panel-resize-handle");

      act(() => {
        fireEvent.mouseDown(handle, { clientX: 500 });
        fireEvent.mouseMove(window, { clientX: 2000 });
        fireEvent.mouseUp(window);
      });

      expect(panel.style.width).toBe("240px");
    });

    it("マウスドラッグで上限（800px）を超えて左方向に動かしても上限で止まる", () => {
      render(<PreviewPanel />);
      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      const panel = screen.getByTestId("preview-panel");
      const handle = screen.getByTestId("preview-panel-resize-handle");

      act(() => {
        fireEvent.mouseDown(handle, { clientX: 500 });
        fireEvent.mouseMove(window, { clientX: -2000 });
        fireEvent.mouseUp(window);
      });

      expect(panel.style.width).toBe("800px");
    });

    it("ArrowRight キーで幅が32px減る（マウスの右ドラッグと同じ向き）", () => {
      render(<PreviewPanel />);
      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      const panel = screen.getByTestId("preview-panel");
      const handle = screen.getByTestId("preview-panel-resize-handle");

      act(() => {
        fireEvent.keyDown(handle, { key: "ArrowRight" });
      });

      expect(panel.style.width).toBe("328px");
    });

    it("ArrowLeft キーで幅が32px増える（マウスの左ドラッグと同じ向き）", () => {
      render(<PreviewPanel />);
      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      const panel = screen.getByTestId("preview-panel");
      const handle = screen.getByTestId("preview-panel-resize-handle");

      act(() => {
        fireEvent.keyDown(handle, { key: "ArrowLeft" });
      });

      expect(panel.style.width).toBe("392px");
    });

    it("下限（240px）到達後は ArrowRight を押しても下回らない", () => {
      render(<PreviewPanel />);
      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      const panel = screen.getByTestId("preview-panel");
      const handle = screen.getByTestId("preview-panel-resize-handle");

      act(() => {
        for (let i = 0; i < 20; i++) {
          fireEvent.keyDown(handle, { key: "ArrowRight" });
        }
      });

      expect(panel.style.width).toBe("240px");
    });

    it("上限（800px）到達後は ArrowLeft を押しても超えない", () => {
      render(<PreviewPanel />);
      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      const panel = screen.getByTestId("preview-panel");
      const handle = screen.getByTestId("preview-panel-resize-handle");

      act(() => {
        for (let i = 0; i < 20; i++) {
          fireEvent.keyDown(handle, { key: "ArrowLeft" });
        }
      });

      expect(panel.style.width).toBe("800px");
    });
  });
});
