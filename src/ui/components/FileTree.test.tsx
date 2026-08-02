import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTree } from "./FileTree.tsx";

// FileTree（#68）: GET /api/md/tree を呼び出して repo ごとの .md 一覧を表示する。
// 取得タイミングはマウント時（＝パネルオープン時）と refreshToken の変化
// （＝リフレッシュボタン押下）のみで、ポーリングは一切しない（親要件 #61）。
// ファイル選択の内容取得・レンダリングは #69 のスコープのため、ここでは
// クリック時に onSelectFile が呼ばれることのみを検証する。
// #110: フラットなパス一覧を IDE 風のネストツリーとして表示する。repo
// （エージェント）が最上段の開閉ノード（初期: 展開）、ディレクトリも開閉
// ノード（初期: 折りたたみ）で、ファイルはベース名のみ表示する。API の
// 応答形（repo ごとのフラットな相対パス一覧）は変えない。

afterEach(() => {
  vi.unstubAllGlobals();
  // fake timers を使うテストがアサーション途中で失敗しても、以降のテストへ
  // fake timers が漏れないようにする（セルフレビュー指摘）。
  vi.useRealTimers();
});

describe("FileTree", () => {
  it("取得中は読み込み中を表示する", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    render(<FileTree refreshToken={0} onSelectFile={vi.fn()} />);

    expect(screen.getByText(/読み込み中/)).toBeInTheDocument();
  });

  it("取得成功後、repo ごとに直下の .md ファイルとディレクトリを表示する（ディレクトリは初期折りたたみ）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            repos: [
              { name: "repo-a", files: ["README.md", "docs/nested.md"] },
              { name: "repo-b", files: ["notes.md"] },
            ],
          }),
      }),
    );

    render(<FileTree refreshToken={0} onSelectFile={vi.fn()} />);

    expect(await screen.findByText("repo-a")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("repo-b")).toBeInTheDocument();
    expect(screen.getByText("notes.md")).toBeInTheDocument();
    // ディレクトリはノード名のみ表示し、初期状態では中身を表示しない。
    expect(screen.getByText("docs")).toBeInTheDocument();
    expect(screen.queryByText("nested.md")).not.toBeInTheDocument();
  });

  it("ディレクトリをクリックすると展開され、再クリックで折りたたまれる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            repos: [
              { name: "repo-a", files: ["docs/sub/deep.md", "docs/nested.md"] },
            ],
          }),
      }),
    );

    render(<FileTree refreshToken={0} onSelectFile={vi.fn()} />);

    const dirButton = await screen.findByText("docs");
    fireEvent.click(dirButton);

    expect(screen.getByText("nested.md")).toBeInTheDocument();
    // 孫ディレクトリはノードとして現れるが、中身はまだ折りたたまれている。
    expect(screen.getByText("sub")).toBeInTheDocument();
    expect(screen.queryByText("deep.md")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("sub"));
    expect(screen.getByText("deep.md")).toBeInTheDocument();

    fireEvent.click(dirButton);
    expect(screen.queryByText("nested.md")).not.toBeInTheDocument();
    expect(screen.queryByText("deep.md")).not.toBeInTheDocument();
  });

  it("repo 見出しをクリックすると repo 全体が折りたたまれ、再クリックで展開される", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            repos: [
              { name: "repo-a", files: ["a.md"] },
              { name: "repo-b", files: ["b.md"] },
            ],
          }),
      }),
    );

    render(<FileTree refreshToken={0} onSelectFile={vi.fn()} />);

    const repoButton = await screen.findByText("repo-a");
    expect(screen.getByText("a.md")).toBeInTheDocument();

    fireEvent.click(repoButton);
    expect(screen.queryByText("a.md")).not.toBeInTheDocument();
    // 他 repo は影響を受けない。
    expect(screen.getByText("b.md")).toBeInTheDocument();

    fireEvent.click(repoButton);
    expect(screen.getByText("a.md")).toBeInTheDocument();
  });

  it("ファイルをクリックすると onSelectFile が repo 名と repo 相対パスで呼ばれる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            repos: [{ name: "repo-a", files: ["docs/nested.md"] }],
          }),
      }),
    );
    const onSelectFile = vi.fn();

    render(<FileTree refreshToken={0} onSelectFile={onSelectFile} />);

    fireEvent.click(await screen.findByText("docs"));
    fireEvent.click(screen.getByText("nested.md"));

    // 表示はベース名のみだが、onSelectFile には repo 相対パスを渡す
    // （PreviewPanel の GET /api/md/file の契約は変えない）。
    expect(onSelectFile).toHaveBeenCalledWith("repo-a", "docs/nested.md");
  });

  it("リフレッシュ後もディレクトリの展開状態を保持する", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            repos: [{ name: "repo-a", files: ["docs/nested.md"] }],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            // new.md の出現を「2回目の取得が完了した」ことの目印として使う。
            repos: [{ name: "repo-a", files: ["docs/nested.md", "new.md"] }],
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <FileTree refreshToken={0} onSelectFile={vi.fn()} />,
    );
    fireEvent.click(await screen.findByText("docs"));
    expect(screen.getByText("nested.md")).toBeInTheDocument();

    rerender(<FileTree refreshToken={1} onSelectFile={vi.fn()} />);
    await screen.findByText("new.md");

    expect(screen.getByText("nested.md")).toBeInTheDocument();
  });

  it("リフレッシュ後も repo の折りたたみ状態を保持する", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            repos: [{ name: "repo-a", files: ["a.md"] }],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            // repo-b の出現を「2回目の取得が完了した」ことの目印として使う
            // （repo-a は折りたたみ済みのため、子ファイルの出現では目印に
            // できない）。
            repos: [
              { name: "repo-a", files: ["a.md"] },
              { name: "repo-b", files: ["marker.md"] },
            ],
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <FileTree refreshToken={0} onSelectFile={vi.fn()} />,
    );
    const repoButton = await screen.findByText("repo-a");
    fireEvent.click(repoButton);
    expect(screen.queryByText("a.md")).not.toBeInTheDocument();

    rerender(<FileTree refreshToken={1} onSelectFile={vi.fn()} />);
    await screen.findByText("marker.md");

    expect(screen.queryByText("a.md")).not.toBeInTheDocument();
  });

  it("マウント時に一度だけ /api/md/tree を取得する", () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<FileTree refreshToken={0} onSelectFile={vi.fn()} />);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/md/tree");
  });

  it("refreshToken が変化すると再取得する", () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <FileTree refreshToken={0} onSelectFile={vi.fn()} />,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender(<FileTree refreshToken={1} onSelectFile={vi.fn()} />);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshToken が変化しない限り、時間が経過しても再取得しない（ポーリングしない）", () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<FileTree refreshToken={0} onSelectFile={vi.fn()} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("取得失敗時にエラー表示をする", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    render(<FileTree refreshToken={0} onSelectFile={vi.fn()} />);

    expect(
      await screen.findByText("ファイルツリーの取得に失敗しました"),
    ).toBeInTheDocument();
  });

  it("応答が ok でない場合もエラー表示をする", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    render(<FileTree refreshToken={0} onSelectFile={vi.fn()} />);

    expect(
      await screen.findByText("ファイルツリーの取得に失敗しました"),
    ).toBeInTheDocument();
  });

  it("選択中のファイルボタンに aria-current が付与される", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            repos: [{ name: "repo-a", files: ["a.md", "b.md"] }],
          }),
      }),
    );

    render(<FileTree refreshToken={0} onSelectFile={vi.fn()} />);

    const buttonA = await screen.findByRole("button", { name: "a.md" });
    const buttonB = screen.getByRole("button", { name: "b.md" });
    expect(buttonA).not.toHaveAttribute("aria-current");

    fireEvent.click(buttonA);

    expect(buttonA).toHaveAttribute("aria-current", "true");
    expect(buttonB).not.toHaveAttribute("aria-current");
  });

  it("全 repo で .md が0件の場合、空状態メッセージを表示する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            repos: [
              { name: "repo-a", files: [] },
              { name: "repo-b", files: [] },
            ],
          }),
      }),
    );

    render(<FileTree refreshToken={0} onSelectFile={vi.fn()} />);

    expect(
      await screen.findByText(".md ファイルが見つかりません"),
    ).toBeInTheDocument();
  });

  it("リフレッシュ中も直前の取得結果を表示したまま、更新中であることを示す（ちらつき防止）", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ repos: [{ name: "repo-a", files: ["a.md"] }] }),
      })
      .mockReturnValueOnce(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <FileTree refreshToken={0} onSelectFile={vi.fn()} />,
    );
    expect(await screen.findByText("a.md")).toBeInTheDocument();

    rerender(<FileTree refreshToken={1} onSelectFile={vi.fn()} />);

    // 再取得が完了していなくても、直前の一覧は消えない。
    expect(screen.getByText("a.md")).toBeInTheDocument();
    expect(screen.getByText(/更新中/)).toBeInTheDocument();
  });

  it("リフレッシュの取得が失敗しても、直前の取得結果は消えずエラーの注記が表示される", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ repos: [{ name: "repo-a", files: ["a.md"] }] }),
      })
      .mockRejectedValueOnce(new Error("network error"));
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <FileTree refreshToken={0} onSelectFile={vi.fn()} />,
    );
    expect(await screen.findByText("a.md")).toBeInTheDocument();

    rerender(<FileTree refreshToken={1} onSelectFile={vi.fn()} />);

    expect(
      await screen.findByText("最新の更新に失敗しました"),
    ).toBeInTheDocument();
    // 直前の取得結果は消えない。
    expect(screen.getByText("a.md")).toBeInTheDocument();
  });

  it("再取得後も選択中のファイルが一覧に残っていれば選択状態を保持する（リフレッシュで表示状態を失わない）", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ repos: [{ name: "repo-a", files: ["a.md"] }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            // c.md の出現を「2回目の取得が完了した」ことの目印として使う。
            repos: [{ name: "repo-a", files: ["a.md", "c.md"] }],
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <FileTree refreshToken={0} onSelectFile={vi.fn()} />,
    );
    const buttonA = await screen.findByRole("button", { name: "a.md" });
    fireEvent.click(buttonA);
    expect(buttonA).toHaveAttribute("aria-current", "true");

    rerender(<FileTree refreshToken={1} onSelectFile={vi.fn()} />);
    await screen.findByText("c.md");

    expect(screen.getByRole("button", { name: "a.md" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("再取得後の一覧から選択中のファイルが無くなった場合、ハイライトは自然に外れる", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ repos: [{ name: "repo-a", files: ["a.md"] }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ repos: [{ name: "repo-a", files: ["b.md"] }] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <FileTree refreshToken={0} onSelectFile={vi.fn()} />,
    );
    const buttonA = await screen.findByRole("button", { name: "a.md" });
    fireEvent.click(buttonA);
    expect(buttonA).toHaveAttribute("aria-current", "true");

    rerender(<FileTree refreshToken={1} onSelectFile={vi.fn()} />);

    const buttonB = await screen.findByRole("button", { name: "b.md" });
    expect(screen.queryByText("a.md")).not.toBeInTheDocument();
    expect(buttonB).not.toHaveAttribute("aria-current");
  });

  // キーボード操作（#114）: 矢印キーで表示中ノードのフォーカス移動・開閉を
  // 行う。フォーカス移動だけではファイル選択（onSelectFile）を発火させない
  // （Enter/Space はブラウザ標準の button 動作で click になり、そこで確定）。
  describe("キーボード操作（#114）", () => {
    // 描画順（ディレクトリ→ファイル）: repo-a / docs / top.md / repo-b / b.md
    function stubTreeFetch() {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              repos: [
                {
                  name: "repo-a",
                  files: ["top.md", "docs/nested.md", "docs/sub/deep.md"],
                },
                { name: "repo-b", files: ["b.md"] },
              ],
            }),
        }),
      );
    }

    it("ArrowDown / ArrowUp で表示中のノード間をフォーカス移動する", async () => {
      stubTreeFetch();
      render(<FileTree refreshToken={0} onSelectFile={vi.fn()} />);

      const repoA = await screen.findByRole("button", { name: "repo-a" });
      const docs = screen.getByRole("button", { name: "docs" });
      const topFile = screen.getByRole("button", { name: "top.md" });

      repoA.focus();
      fireEvent.keyDown(repoA, { key: "ArrowDown" });
      expect(docs).toHaveFocus();

      fireEvent.keyDown(docs, { key: "ArrowDown" });
      expect(topFile).toHaveFocus();

      fireEvent.keyDown(topFile, { key: "ArrowUp" });
      expect(docs).toHaveFocus();
    });

    it("先頭で ArrowUp・末尾で ArrowDown を押してもフォーカスは動かない", async () => {
      stubTreeFetch();
      render(<FileTree refreshToken={0} onSelectFile={vi.fn()} />);

      const repoA = await screen.findByRole("button", { name: "repo-a" });
      const fileB = screen.getByRole("button", { name: "b.md" });

      repoA.focus();
      fireEvent.keyDown(repoA, { key: "ArrowUp" });
      expect(repoA).toHaveFocus();

      fileB.focus();
      fireEvent.keyDown(fileB, { key: "ArrowDown" });
      expect(fileB).toHaveFocus();
    });

    it("ArrowRight で折りたたみ中のディレクトリを展開する（フォーカスは維持）", async () => {
      stubTreeFetch();
      render(<FileTree refreshToken={0} onSelectFile={vi.fn()} />);

      const docs = await screen.findByRole("button", { name: "docs" });
      docs.focus();

      fireEvent.keyDown(docs, { key: "ArrowRight" });

      expect(screen.getByText("nested.md")).toBeInTheDocument();
      expect(docs).toHaveFocus();
    });

    it("ArrowRight で展開済みノードの最初の子へフォーカス移動する（ディレクトリが先）", async () => {
      stubTreeFetch();
      render(<FileTree refreshToken={0} onSelectFile={vi.fn()} />);

      const docs = await screen.findByRole("button", { name: "docs" });
      docs.focus();
      fireEvent.keyDown(docs, { key: "ArrowRight" });

      fireEvent.keyDown(docs, { key: "ArrowRight" });

      // docs の子はディレクトリ sub → ファイル nested.md の順で描画される。
      expect(screen.getByRole("button", { name: "sub" })).toHaveFocus();
    });

    it("ArrowLeft で展開中のノードを折りたたむ（フォーカスは維持）", async () => {
      stubTreeFetch();
      render(<FileTree refreshToken={0} onSelectFile={vi.fn()} />);

      const docs = await screen.findByRole("button", { name: "docs" });
      docs.focus();
      fireEvent.keyDown(docs, { key: "ArrowRight" });
      expect(screen.getByText("nested.md")).toBeInTheDocument();

      fireEvent.keyDown(docs, { key: "ArrowLeft" });

      expect(screen.queryByText("nested.md")).not.toBeInTheDocument();
      expect(docs).toHaveFocus();
    });

    it("ArrowLeft で非展開ノードから親ノードへフォーカス移動する", async () => {
      stubTreeFetch();
      render(<FileTree refreshToken={0} onSelectFile={vi.fn()} />);

      const repoA = await screen.findByRole("button", { name: "repo-a" });
      const docs = screen.getByRole("button", { name: "docs" });
      const topFile = screen.getByRole("button", { name: "top.md" });

      // ファイル → 親（repo 見出し）
      topFile.focus();
      fireEvent.keyDown(topFile, { key: "ArrowLeft" });
      expect(repoA).toHaveFocus();

      // 折りたたみ中のディレクトリ → 親（repo 見出し）
      docs.focus();
      fireEvent.keyDown(docs, { key: "ArrowLeft" });
      expect(repoA).toHaveFocus();

      // ネストしたファイル → 親ディレクトリ
      fireEvent.keyDown(docs, { key: "ArrowRight" });
      const nested = screen.getByRole("button", { name: "nested.md" });
      nested.focus();
      fireEvent.keyDown(nested, { key: "ArrowLeft" });
      expect(docs).toHaveFocus();
    });

    it("矢印キーのフォーカス移動・開閉では onSelectFile が発火しない", async () => {
      stubTreeFetch();
      const onSelectFile = vi.fn();
      render(<FileTree refreshToken={0} onSelectFile={onSelectFile} />);

      const repoA = await screen.findByRole("button", { name: "repo-a" });
      repoA.focus();
      fireEvent.keyDown(repoA, { key: "ArrowDown" }); // → docs
      fireEvent.keyDown(
        screen.getByRole("button", { name: "docs" }),
        { key: "ArrowRight" }, // docs 展開
      );
      fireEvent.keyDown(
        screen.getByRole("button", { name: "docs" }),
        { key: "ArrowDown" }, // → sub
      );
      fireEvent.keyDown(
        screen.getByRole("button", { name: "sub" }),
        { key: "ArrowDown" }, // → nested.md（ファイル上のフォーカス移動）
      );
      fireEvent.keyDown(
        screen.getByRole("button", { name: "nested.md" }),
        { key: "ArrowRight" }, // ファイルでは何もしない
      );

      expect(onSelectFile).not.toHaveBeenCalled();
      // ファイル上の ArrowRight はフォーカスも動かさない。
      expect(screen.getByRole("button", { name: "nested.md" })).toHaveFocus();
    });
  });
});
