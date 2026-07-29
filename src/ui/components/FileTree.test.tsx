import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTree } from "./FileTree.tsx";

// FileTree（#68）: GET /api/md/tree を呼び出して repo ごとの .md 一覧を表示する。
// 取得タイミングはマウント時（＝パネルオープン時）と refreshToken の変化
// （＝リフレッシュボタン押下）のみで、ポーリングは一切しない（親要件 #61）。
// ファイル選択の内容取得・レンダリングは #69 のスコープのため、ここでは
// クリック時に onSelectFile が呼ばれることのみを検証する。

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

  it("取得成功後、repo ごとに .md ファイルパスの一覧を表示する", async () => {
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
    expect(screen.getByText("docs/nested.md")).toBeInTheDocument();
    expect(screen.getByText("repo-b")).toBeInTheDocument();
    expect(screen.getByText("notes.md")).toBeInTheDocument();
  });

  it("ファイルをクリックすると onSelectFile が repo 名とファイルパスで呼ばれる", async () => {
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

    const fileButton = await screen.findByText("docs/nested.md");
    fireEvent.click(fileButton);

    expect(onSelectFile).toHaveBeenCalledWith("repo-a", "docs/nested.md");
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

    const buttonA = await screen.findByText("a.md");
    const buttonB = screen.getByText("b.md");
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
    const buttonA = await screen.findByText("a.md");
    fireEvent.click(buttonA);
    expect(buttonA).toHaveAttribute("aria-current", "true");

    rerender(<FileTree refreshToken={1} onSelectFile={vi.fn()} />);
    await screen.findByText("c.md");

    expect(screen.getByText("a.md")).toHaveAttribute("aria-current", "true");
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
    const buttonA = await screen.findByText("a.md");
    fireEvent.click(buttonA);
    expect(buttonA).toHaveAttribute("aria-current", "true");

    rerender(<FileTree refreshToken={1} onSelectFile={vi.fn()} />);

    const buttonB = await screen.findByText("b.md");
    expect(screen.queryByText("a.md")).not.toBeInTheDocument();
    expect(buttonB).not.toHaveAttribute("aria-current");
  });
});
