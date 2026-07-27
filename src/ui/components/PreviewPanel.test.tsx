import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewPanel } from "./PreviewPanel.tsx";

// PreviewPanel: 開閉・幅ドラッグ（#64）・FileTree/リフレッシュボタンの結線
// （#68）を検証する。FileTree 自体の一覧表示・選択挙動の詳細は
// FileTree.test.tsx の責務のため、ここでは「body 内に FileTree が組み込まれ、
// リフレッシュボタン押下で再取得がトリガーされる」ことのみを確認する。
// Markdownレンダリング・ライブ更新は後続チケット（#69/#70）のスコープ。

// パネルを開くと FileTree がマウントされ GET /api/md/tree を叩くため、
// 個別の挙動を検証しないテストでは解決しない Promise で最小限のスタブを
// 当てる（CardDetailModal.test.tsx と同じ流儀）。
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("パネルを開くと本文領域内に FileTree が組み込まれる", () => {
    render(<PreviewPanel />);

    act(() => {
      screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
    });

    const body = screen.getByTestId("preview-panel-body");
    expect(body).toContainElement(screen.getByText(/読み込み中/));
  });

  it("パネルヘッダのリフレッシュボタン押下で FileTree のツリー再取得（fetch）がトリガーされる（#68 結線）", () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<PreviewPanel />);

    act(() => {
      screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
    });

    // パネルオープン時（FileTree のマウント）で1回目の取得が起きている。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/md/tree");

    const refreshButton = screen.getByTestId("preview-panel-refresh-button");
    act(() => {
      refreshButton.click();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // クリック前後で開閉・幅などパネル自体の状態には影響しないことも
    // あわせて確認する（リフレッシュはツリー再取得のみをトリガーする）。
    expect(
      screen.getByRole("button", { name: "プレビューパネルを閉じる" }),
    ).toBeInTheDocument();
  });

  it("パネルを閉じてから再度開くと、ツリーが再取得される（オープン時取得。#68 完了条件）", () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<PreviewPanel />);

    act(() => {
      screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      screen.getByRole("button", { name: "プレビューパネルを閉じる" }).click();
    });
    act(() => {
      screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
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
