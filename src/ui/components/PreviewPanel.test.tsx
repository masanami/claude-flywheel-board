import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import mermaid from "mermaid";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mdLiveChannelModule from "../md-live-channel.ts";
import type { MdLiveChannel } from "../md-live-channel.ts";
import { PreviewPanel } from "./PreviewPanel.tsx";

// mermaid は実際に diagram をレンダリングすると重く jsdom 依存の懸念もあるため、
// 「mermaid.render が呼ばれ、その戻り値（信頼済み SVG 文字列）が描画コンテナに
// 反映される」という結線だけをテストする（実際の図の見た目は mermaid 自体の
// 責務であり、ここでの検証対象ではない）。
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

// PreviewPanel: 開閉・幅ドラッグ（#64）・FileTree/リフレッシュボタンの結線
// （#68）・選択ファイルの取得＋react-markdown レンダリング（#69。下部の
// 「Markdownレンダリング」describe を参照）・ライブ更新の WS 結線
// （#70。下部の「ライブ更新」describe を参照）を検証する。FileTree 自体の
// 一覧表示・選択挙動の詳細は FileTree.test.tsx の責務のため、開閉・結線の
// テストでは「body 内に FileTree が組み込まれ、リフレッシュボタン押下で
// 再取得がトリガーされる」ことのみを確認する。

// パネルを開くと FileTree がマウントされ GET /api/md/tree を叩くため、
// 個別の挙動を検証しないテストでは解決しない Promise で最小限のスタブを
// 当てる（CardDetailModal.test.tsx と同じ流儀）。
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(mermaid.render).mockReset();
  vi.mocked(mermaid.initialize).mockReset();
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

  describe("Markdownレンダリング（#69: file API 結線）", () => {
    // ツリー取得（/api/md/tree）と file 取得（/api/md/file）の両方を単一の
    // fetch モックで切り替える。実際の repo/path は "repo-a" /
    // "docs/note.md" 固定（エンコードが必要な `/` を含む点を意図的に選ぶ）。
    function stubFetch(
      fileResponse: () => {
        ok: boolean;
        status: number;
        json: () => Promise<unknown>;
      },
    ) {
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
          return Promise.resolve(fileResponse());
        }
        throw new Error(`unexpected fetch url in test: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    async function openPanelAndSelectFile() {
      const utils = render(<PreviewPanel />);
      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });
      const fileButton = await screen.findByRole("button", {
        name: "docs/note.md",
      });
      act(() => {
        fileButton.click();
      });
      return utils;
    }

    it("ファイル選択時に repo/path を指定して GET /api/md/file を fetch する", async () => {
      const fetchMock = stubFetch(() => ({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: "# Hello" }),
      }));

      await openPanelAndSelectFile();

      await screen.findByText("Hello");

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/md/file?repo=repo-a&path=docs%2Fnote.md",
      );
    });

    it("GFM テーブルが描画される", async () => {
      stubFetch(() => ({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            content: "| a | b |\n| - | - |\n| 1 | 2 |\n",
          }),
      }));

      await openPanelAndSelectFile();

      const table = await screen.findByRole("table");
      expect(table).toBeInTheDocument();
      expect(screen.getByText("1")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
    });

    it("GFM チェックボックス（タスクリスト）が描画される", async () => {
      stubFetch(() => ({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            content: "- [ ] 未完了タスク\n- [x] 完了タスク\n",
          }),
      }));

      await openPanelAndSelectFile();

      const checkboxes = await screen.findAllByRole("checkbox");
      expect(checkboxes).toHaveLength(2);
      expect(checkboxes[0]).not.toBeChecked();
      expect(checkboxes[1]).toBeChecked();
    });

    it("コードブロックにシンタックスハイライト用のクラスが付与される", async () => {
      stubFetch(() => ({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            content: "```js\nconst x = 1;\n```\n",
          }),
      }));

      const { container } = await openPanelAndSelectFile();

      await waitFor(() => {
        expect(container.querySelector("code.hljs")).not.toBeNull();
      });
    });

    it("生 HTML・script タグが実行されずテキストとして表示される（rehype-raw 不使用）", async () => {
      stubFetch(() => ({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            content: "before <script>alert(1)</script> after",
          }),
      }));

      const { container } = await openPanelAndSelectFile();

      await waitFor(() => {
        expect(container.textContent).toContain(
          "before <script>alert(1)</script> after",
        );
      });
      expect(container.querySelectorAll("script")).toHaveLength(0);
    });

    it("mermaid コードブロックが securityLevel: strict で mermaid.render に渡され、結果が描画される", async () => {
      vi.mocked(mermaid.render).mockResolvedValue({
        svg: '<svg data-testid="mock-mermaid-svg"></svg>',
        // biome-ignore lint/suspicious/noExplicitAny: mermaid の RenderResult 型に合わせた最小スタブ
      } as any);

      stubFetch(() => ({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            content: "```mermaid\ngraph TD; A-->B;\n```\n",
          }),
      }));

      await openPanelAndSelectFile();

      await screen.findByTestId("mock-mermaid-svg");

      expect(mermaid.initialize).toHaveBeenCalledWith(
        expect.objectContaining({ securityLevel: "strict" }),
      );
      expect(mermaid.render).toHaveBeenCalledWith(
        expect.any(String),
        "graph TD; A-->B;",
        expect.anything(),
      );
    });

    it("mermaid.render が失敗した場合、専用のエラーメッセージを表示する", async () => {
      vi.mocked(mermaid.render).mockRejectedValue(new Error("parse error"));

      stubFetch(() => ({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            content: "```mermaid\nnot a valid diagram\n```\n",
          }),
      }));

      await openPanelAndSelectFile();

      expect(
        await screen.findByText("mermaid 図の描画に失敗しました"),
      ).toBeInTheDocument();
    });

    it("同じファイルを再度クリックしても表示中の内容は消えない（ちらつき防止。セルフレビュー指摘）", async () => {
      const fetchMock = stubFetch(() => ({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: "# Hello" }),
      }));

      await openPanelAndSelectFile();
      await screen.findByText("Hello");
      const callsAfterFirstSelect = fetchMock.mock.calls.length;

      const fileButton = screen.getByRole("button", { name: "docs/note.md" });
      act(() => {
        fileButton.click();
      });

      // 同一ファイルの再選択では state が更新されないため、再取得も
      // loading への遷移も起きず、表示中の内容がそのまま残る。
      expect(screen.getByText("Hello")).toBeInTheDocument();
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirstSelect);
    });

    it("複数の mermaid ブロックがあっても mermaid.render は直列に呼ばれる（先行呼び出しの解決前に後続を開始しない。セルフレビュー指摘）", async () => {
      const renderCalls: unknown[][] = [];
      let resolveFirst!: (value: {
        svg: string;
        bindFunctions?: (element: Element) => void;
      }) => void;
      const firstRenderPromise = new Promise<{
        svg: string;
        bindFunctions?: (element: Element) => void;
      }>((resolve) => {
        resolveFirst = resolve;
      });

      vi.mocked(mermaid.render).mockImplementation((...args) => {
        renderCalls.push(args);
        return renderCalls.length === 1
          ? firstRenderPromise
          : // biome-ignore lint/suspicious/noExplicitAny: mermaid の RenderResult 型に合わせた最小スタブ
            (Promise.resolve({ svg: "<svg></svg>" }) as any);
      });

      stubFetch(() => ({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            content:
              "```mermaid\ngraph TD; A-->B;\n```\n\n```mermaid\ngraph TD; C-->D;\n```\n",
          }),
      }));

      await openPanelAndSelectFile();

      // 1つ目の render() が呼ばれるまで待つ。
      await waitFor(() => {
        expect(renderCalls.length).toBeGreaterThanOrEqual(1);
      });

      // 1つ目が未解決の間は、マイクロタスクをさらに消化させても2つ目の
      // render() は呼ばれない（直列化キューで待たされている）。
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(renderCalls).toHaveLength(1);

      resolveFirst({ svg: "<svg></svg>" });

      await waitFor(() => {
        expect(renderCalls).toHaveLength(2);
      });
    });

    it("取得中はローディング表示になる", async () => {
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
        // /api/md/file は意図的に解決しない Promise を返し、loading 状態を
        // 観測できるようにする。
        return new Promise(() => {});
      });
      vi.stubGlobal("fetch", fetchMock);

      await openPanelAndSelectFile();

      expect(
        screen.getByText("ファイルを読み込んでいます..."),
      ).toBeInTheDocument();
    });

    it("別のファイルを選択すると、直前の内容が新しい内容に置き換わる", async () => {
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/md/tree")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                repos: [{ name: "repo-a", files: ["a.md", "b.md"] }],
              }),
          });
        }
        if (url.includes("path=a.md")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ content: "# ファイルA" }),
          });
        }
        if (url.includes("path=b.md")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ content: "# ファイルB" }),
          });
        }
        throw new Error(`unexpected fetch url in test: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<PreviewPanel />);
      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      const fileAButton = await screen.findByRole("button", { name: "a.md" });
      act(() => {
        fileAButton.click();
      });
      await screen.findByText("ファイルA");

      const fileBButton = screen.getByRole("button", { name: "b.md" });
      act(() => {
        fileBButton.click();
      });

      await screen.findByText("ファイルB");
      expect(screen.queryByText("ファイルA")).not.toBeInTheDocument();
    });

    it("パネルを閉じてから再度開くと、前回選択していたファイルの内容は残らない（プレースホルダに戻る）", async () => {
      stubFetch(() => ({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: "# Kept?" }),
      }));

      await openPanelAndSelectFile();
      await screen.findByText("Kept?");

      act(() => {
        screen
          .getByRole("button", { name: "プレビューパネルを閉じる" })
          .click();
      });
      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      expect(
        screen.getByText("ファイルツリーからファイルを選択してください"),
      ).toBeInTheDocument();
      expect(screen.queryByText("Kept?")).not.toBeInTheDocument();
    });

    it("413 応答時に専用エラーメッセージ「サイズが大きすぎるため表示できません」を表示する", async () => {
      stubFetch(() => ({
        ok: false,
        status: 413,
        json: () => Promise.reject(new Error("not called")),
      }));

      await openPanelAndSelectFile();

      expect(
        await screen.findByText("サイズが大きすぎるため表示できません"),
      ).toBeInTheDocument();
    });

    it("404 応答時にエラーメッセージを表示する", async () => {
      stubFetch(() => ({
        ok: false,
        status: 404,
        json: () => Promise.reject(new Error("not called")),
      }));

      await openPanelAndSelectFile();

      expect(
        await screen.findByText("ファイルの取得に失敗しました"),
      ).toBeInTheDocument();
    });

    it("取得失敗（ネットワークエラー）時にエラーメッセージを表示する", async () => {
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
        return Promise.reject(new Error("network error"));
      });
      vi.stubGlobal("fetch", fetchMock);

      await openPanelAndSelectFile();

      expect(
        await screen.findByText("ファイルの取得に失敗しました"),
      ).toBeInTheDocument();
    });

    it("ファイル未選択時はプレースホルダを表示する", () => {
      const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
      vi.stubGlobal("fetch", fetchMock);

      render(<PreviewPanel />);
      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      expect(
        screen.getByText("ファイルツリーからファイルを選択してください"),
      ).toBeInTheDocument();
    });
  });

  describe("ライブ更新（#70: WS 結線）", () => {
    // mdLive は Board.tsx が唯一の WS 接続を橋渡しするための最小限の受け口
    // （../md-live-channel.ts）。ここでは PreviewPanel が mdLive.subscribe /
    // unsubscribe を正しいタイミングで呼び、mdLive.handlers 経由で届く
    // md_file_changed / md_subscribe_error を「現在開いているファイルと
    // 一致する場合のみ」処理することを検証する。WS 自体の送受信ロジック
    // （JSON シリアライズ・readyState ガード等）は ws.test.ts の責務。
    function createFakeMdLive(): MdLiveChannel {
      return {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        handlers: {},
      };
    }

    function stubFetch() {
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/md/tree")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                repos: [{ name: "repo-a", files: ["docs/note.md", "b.md"] }],
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

    async function openPanelAndSelectFile(mdLive: MdLiveChannel) {
      render(<PreviewPanel mdLive={mdLive} />);
      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });
      const fileButton = await screen.findByRole("button", {
        name: "docs/note.md",
      });
      act(() => {
        fileButton.click();
      });
      await screen.findByText("Hello");
    }

    it("ファイルを開いたとき mdLive.subscribe を repo/path 付きで呼ぶ", async () => {
      const mdLive = createFakeMdLive();
      stubFetch();

      await openPanelAndSelectFile(mdLive);

      expect(mdLive.subscribe).toHaveBeenCalledWith("repo-a", "docs/note.md");
    });

    it("md_file_changed 受信時、開いているファイルと repo/path が一致する場合のみ GET /api/md/file を再フェッチする", async () => {
      const mdLive = createFakeMdLive();
      const fetchMock = stubFetch();

      await openPanelAndSelectFile(mdLive);
      const callsAfterSelect = fetchMock.mock.calls.length;

      act(() => {
        mdLive.handlers.onFileChanged?.({
          type: "md_file_changed",
          repo: "repo-a",
          path: "docs/note.md",
        });
      });

      await waitFor(() => {
        expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterSelect);
      });
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/md/file?repo=repo-a&path=docs%2Fnote.md",
      );
    });

    it("md_file_changed によるサイレントリフレッシュ中はローディング表示にならず、直前の内容とスクロール位置を保持する（blocker修正: 保存のたびに先頭へジャンプする不具合の回帰防止）", async () => {
      const mdLive = createFakeMdLive();
      let fileFetchCount = 0;
      let resolveSecondFetch!: (value: {
        ok: boolean;
        status: number;
        json: () => Promise<unknown>;
      }) => void;
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
          fileFetchCount++;
          if (fileFetchCount === 1) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ content: "# Hello" }),
            });
          }
          // 2回目以降（md_file_changed によるサイレントリフレッシュ）は
          // 解決タイミングを手動制御し、pending 中の表示状態を検証する。
          return new Promise((resolve) => {
            resolveSecondFetch = resolve;
          });
        }
        throw new Error(`unexpected fetch url in test: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      await openPanelAndSelectFile(mdLive);

      const markdownContainer = screen.getByTestId("preview-panel-markdown");
      // 保存前にユーザーがスクロールしていた状態を模す。
      markdownContainer.scrollTop = 120;

      act(() => {
        mdLive.handlers.onFileChanged?.({
          type: "md_file_changed",
          repo: "repo-a",
          path: "docs/note.md",
        });
      });

      await waitFor(() => {
        expect(fileFetchCount).toBe(2);
      });

      // 再フェッチが完了する前でも loading 表示に落ちず、直前の内容と
      // スクロール位置（同一 DOM ノードが維持されていること）が保持される。
      expect(
        screen.queryByText("ファイルを読み込んでいます..."),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Hello")).toBeInTheDocument();
      expect(screen.getByTestId("preview-panel-markdown").scrollTop).toBe(120);

      act(() => {
        resolveSecondFetch({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ content: "# Updated" }),
        });
      });

      await screen.findByText("Updated");
      expect(screen.queryByText("Hello")).not.toBeInTheDocument();
    });

    it("md_file_changed によるサイレントリフレッシュが失敗した場合はエラーメッセージへ遷移する（成功時と非対称に握りつぶさない）", async () => {
      const mdLive = createFakeMdLive();
      let fileFetchCount = 0;
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
          fileFetchCount++;
          if (fileFetchCount === 1) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ content: "# Hello" }),
            });
          }
          return Promise.reject(new Error("network error"));
        }
        throw new Error(`unexpected fetch url in test: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      await openPanelAndSelectFile(mdLive);

      act(() => {
        mdLive.handlers.onFileChanged?.({
          type: "md_file_changed",
          repo: "repo-a",
          path: "docs/note.md",
        });
      });

      expect(
        await screen.findByText("ファイルの取得に失敗しました"),
      ).toBeInTheDocument();
    });

    it("WS 再接続時（onReconnected）、選択中のファイルを再フェッチする（切断中に発生した変更の取りこぼし防止。blocker修正）", async () => {
      const mdLive = createFakeMdLive();
      const fetchMock = stubFetch();

      await openPanelAndSelectFile(mdLive);
      const callsAfterSelect = fetchMock.mock.calls.length;

      act(() => {
        mdLive.handlers.onReconnected?.();
      });

      await waitFor(() => {
        expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterSelect);
      });
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/md/file?repo=repo-a&path=docs%2Fnote.md",
      );
    });

    it("md_file_changed の repo/path が開いているファイルと一致しない場合は再フェッチしない", async () => {
      const mdLive = createFakeMdLive();
      const fetchMock = stubFetch();

      await openPanelAndSelectFile(mdLive);
      const callsAfterSelect = fetchMock.mock.calls.length;

      act(() => {
        mdLive.handlers.onFileChanged?.({
          type: "md_file_changed",
          repo: "repo-a",
          path: "other.md",
        });
      });

      // 再フェッチが起きないことを、非同期処理が発生しないまま確認する。
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock.mock.calls.length).toBe(callsAfterSelect);
    });

    it("パネルを閉じる操作時、開いていたファイルの repo/path 付きで mdLive.unsubscribe を呼ぶ", async () => {
      const mdLive = createFakeMdLive();
      stubFetch();

      await openPanelAndSelectFile(mdLive);

      act(() => {
        screen
          .getByRole("button", { name: "プレビューパネルを閉じる" })
          .click();
      });

      expect(mdLive.unsubscribe).toHaveBeenCalledWith("repo-a", "docs/note.md");
    });

    it("別ファイルへの切替時は mdLive.unsubscribe を呼ばない（サーバの自動切替に委ねる）", async () => {
      const mdLive = createFakeMdLive();
      stubFetch();

      await openPanelAndSelectFile(mdLive);

      const fileBButton = screen.getByRole("button", { name: "b.md" });
      act(() => {
        fileBButton.click();
      });

      expect(mdLive.subscribe).toHaveBeenCalledWith("repo-a", "docs/note.md");
      expect(mdLive.subscribe).toHaveBeenCalledWith("repo-a", "b.md");
      expect(mdLive.unsubscribe).not.toHaveBeenCalled();
    });

    it("セルフレビュー指摘: WS 再接続時（mdLive.handlers.onReconnected 呼び出し）、選択中のファイルを再度 mdLive.subscribe する", async () => {
      const mdLive = createFakeMdLive();
      stubFetch();

      await openPanelAndSelectFile(mdLive);
      const subscribeCallsAfterSelect = (
        mdLive.subscribe as ReturnType<typeof vi.fn>
      ).mock.calls.length;

      act(() => {
        mdLive.handlers.onReconnected?.();
      });

      expect(
        (mdLive.subscribe as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThan(subscribeCallsAfterSelect);
      expect(mdLive.subscribe).toHaveBeenLastCalledWith(
        "repo-a",
        "docs/note.md",
      );
    });

    it("セルフレビュー指摘: ファイル未選択の状態で mdLive.handlers.onReconnected が呼ばれても例外を投げず、subscribe も呼ばない", () => {
      const mdLive = createFakeMdLive();
      stubFetch();

      render(<PreviewPanel mdLive={mdLive} />);
      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      expect(() => {
        act(() => {
          mdLive.handlers.onReconnected?.();
        });
      }).not.toThrow();
      expect(mdLive.subscribe).not.toHaveBeenCalled();
    });

    it("セルフレビュー指摘（2周目）: md_subscribe_error で注記が出た後に onReconnected が呼ばれると、注記もリセットされる（表示残骸を残さない）", async () => {
      const mdLive = createFakeMdLive();
      stubFetch();

      await openPanelAndSelectFile(mdLive);

      act(() => {
        mdLive.handlers.onSubscribeError?.({
          type: "md_subscribe_error",
          repo: "repo-a",
          path: "docs/note.md",
        });
      });
      expect(
        screen.getByTestId("preview-panel-live-update-disabled"),
      ).toBeInTheDocument();

      act(() => {
        mdLive.handlers.onReconnected?.();
      });

      expect(
        screen.queryByTestId("preview-panel-live-update-disabled"),
      ).not.toBeInTheDocument();
    });

    it("md_subscribe_error 受信時に「ライブ更新は無効」の注記を表示する", async () => {
      const mdLive = createFakeMdLive();
      stubFetch();

      await openPanelAndSelectFile(mdLive);

      act(() => {
        mdLive.handlers.onSubscribeError?.({
          type: "md_subscribe_error",
          repo: "repo-a",
          path: "docs/note.md",
        });
      });

      expect(
        screen.getByTestId("preview-panel-live-update-disabled"),
      ).toHaveTextContent("ライブ更新は無効");
    });

    it("セルフレビュー指摘: パネルを閉じると「ライブ更新は無効」の注記もリセットされ、再度開いても表示残骸として残らない", async () => {
      const mdLive = createFakeMdLive();
      stubFetch();

      await openPanelAndSelectFile(mdLive);

      act(() => {
        mdLive.handlers.onSubscribeError?.({
          type: "md_subscribe_error",
          repo: "repo-a",
          path: "docs/note.md",
        });
      });
      expect(
        screen.getByTestId("preview-panel-live-update-disabled"),
      ).toBeInTheDocument();

      act(() => {
        screen
          .getByRole("button", { name: "プレビューパネルを閉じる" })
          .click();
      });
      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      expect(
        screen.queryByTestId("preview-panel-live-update-disabled"),
      ).not.toBeInTheDocument();
    });

    it("md_subscribe_error の repo/path が開いているファイルと一致しない場合は注記を表示しない", async () => {
      const mdLive = createFakeMdLive();
      stubFetch();

      await openPanelAndSelectFile(mdLive);

      act(() => {
        mdLive.handlers.onSubscribeError?.({
          type: "md_subscribe_error",
          repo: "repo-a",
          path: "other.md",
        });
      });

      expect(
        screen.queryByTestId("preview-panel-live-update-disabled"),
      ).not.toBeInTheDocument();
    });

    it("mdLive を渡さずにレンダリングしても例外を投げない（Board.tsx を介さない既存テスト向けの既定値）", () => {
      expect(() => {
        render(<PreviewPanel />);
        act(() => {
          screen
            .getByRole("button", { name: "プレビューパネルを開く" })
            .click();
        });
      }).not.toThrow();
    });

    it("セルフレビュー指摘: mdLive 未指定時の既定チャネルは、再レンダーのたびに再生成されない（安定した参照を保つ）", () => {
      const spy = vi.spyOn(mdLiveChannelModule, "createNoopMdLiveChannel");

      render(<PreviewPanel />);
      const callsAfterMount = spy.mock.calls.length;
      expect(callsAfterMount).toBeGreaterThan(0);

      // 開閉ボタンのクリックで PreviewPanel は再レンダーされる。デフォルト
      // チャネルが毎レンダー再生成される実装だと、ここで呼び出し回数が
      // 増えてしまう（[selectedFile, mdLive] 依存の effect が意図せず
      // 再実行され続けることの間接的な証拠）。
      act(() => {
        screen.getByRole("button", { name: "プレビューパネルを開く" }).click();
      });

      expect(spy.mock.calls.length).toBe(callsAfterMount);
      spy.mockRestore();
    });
  });
});
