import { EventEmitter } from "node:events";
import type { FSWatcher } from "chokidar";
import { watch } from "chokidar";
import type { MockedFunction } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateMdPath } from "./path-validation.ts";
import type { MdWatchRegistry } from "./watch.ts";
import { createMdWatchRegistry, handleMdClientMessage } from "./watch.ts";

// Issue #67: watcher.chokidar.test.ts と同じパターンで chokidar 自体をモックし、
// change イベントを同期的に発火させて refcount 等のロジックを決定的に検証する。
vi.mock("chokidar", () => ({ watch: vi.fn() }));

// path-validation.ts はファイルシステムに実際に触れるため、watch.ts のロジック
// （refcount・1クライアント1購読・自動切替）だけを切り出して検証するために
// モックする（fs 検証自体は path-validation.test.ts が別途担保済み）。
vi.mock("./path-validation.ts", () => ({ validateMdPath: vi.fn() }));

class FakeFSWatcher extends EventEmitter {
  close = vi.fn().mockResolvedValue(undefined);
}

function mockChokidarWatch(): FakeFSWatcher {
  const fake = new FakeFSWatcher();
  vi.mocked(watch).mockReturnValueOnce(fake as unknown as FSWatcher);
  return fake;
}

type FakeWs = { readyState: number; send: ReturnType<typeof vi.fn> };

const WS_OPEN = 1;

function fakeWs(): FakeWs {
  return { readyState: WS_OPEN, send: vi.fn() };
}

beforeEach(() => {
  vi.mocked(watch).mockReset();
  vi.mocked(validateMdPath).mockReset();
});

describe("createMdWatchRegistry.subscribe", () => {
  it("検証成功時、resolvedPath で chokidar.watch を呼び出す", () => {
    vi.mocked(validateMdPath).mockReturnValue({
      ok: true,
      resolvedPath: "/repos/myrepo/doc.md",
      kind: "markdown",
    });
    mockChokidarWatch();
    const broadcastFileChanged = vi.fn();
    const registry = createMdWatchRegistry(() => [], broadcastFileChanged);
    const ws = fakeWs();

    registry.subscribe(ws as never, "myrepo", "doc.md");

    expect(vi.mocked(watch)).toHaveBeenCalledWith(
      "/repos/myrepo/doc.md",
      expect.objectContaining({ ignoreInitial: true }),
    );
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("検証失敗時は chokidar.watch を呼ばず、該当クライアントへ md_subscribe_error を返す", () => {
    vi.mocked(validateMdPath).mockReturnValue({ ok: false });
    const broadcastFileChanged = vi.fn();
    const registry = createMdWatchRegistry(() => [], broadcastFileChanged);
    const ws = fakeWs();

    registry.subscribe(ws as never, "unknown-repo", "doc.md");

    expect(vi.mocked(watch)).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "md_subscribe_error",
        repo: "unknown-repo",
        path: "doc.md",
      }),
    );
  });

  it("ファイル変更検知（change イベント）で md_file_changed が broadcast される", () => {
    vi.mocked(validateMdPath).mockReturnValue({
      ok: true,
      resolvedPath: "/repos/myrepo/doc.md",
      kind: "markdown",
    });
    const fake = mockChokidarWatch();
    const broadcastFileChanged = vi.fn();
    const registry = createMdWatchRegistry(() => [], broadcastFileChanged);
    const ws = fakeWs();
    registry.subscribe(ws as never, "myrepo", "doc.md");

    fake.emit("change");

    expect(broadcastFileChanged).toHaveBeenCalledWith({
      type: "md_file_changed",
      repo: "myrepo",
      path: "doc.md",
    });
  });

  it("chokidar の error イベントにハンドラが付与されている（未処理 error による throw を防ぐ）", () => {
    vi.mocked(validateMdPath).mockReturnValue({
      ok: true,
      resolvedPath: "/repos/myrepo/doc.md",
      kind: "markdown",
    });
    const fake = mockChokidarWatch();
    const registry = createMdWatchRegistry(() => [], vi.fn());
    const ws = fakeWs();
    registry.subscribe(ws as never, "myrepo", "doc.md");

    expect(() => fake.emit("error", new Error("boom"))).not.toThrow();
  });
});

describe("createMdWatchRegistry の refcount", () => {
  it("複数クライアントが同一ファイルを購読中、1クライアントが unsubscribe しても watch は継続する（close されない）", () => {
    vi.mocked(validateMdPath).mockReturnValue({
      ok: true,
      resolvedPath: "/repos/myrepo/doc.md",
      kind: "markdown",
    });
    const fake = mockChokidarWatch();
    const registry = createMdWatchRegistry(() => [], vi.fn());
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    registry.subscribe(ws1 as never, "myrepo", "doc.md");
    registry.subscribe(ws2 as never, "myrepo", "doc.md");

    expect(vi.mocked(watch)).toHaveBeenCalledTimes(1);

    registry.unsubscribeClient(ws1 as never);

    expect(fake.close).not.toHaveBeenCalled();
  });

  it("全クライアントが unsubscribe すると watch が解除される", () => {
    vi.mocked(validateMdPath).mockReturnValue({
      ok: true,
      resolvedPath: "/repos/myrepo/doc.md",
      kind: "markdown",
    });
    const fake = mockChokidarWatch();
    const registry = createMdWatchRegistry(() => [], vi.fn());
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    registry.subscribe(ws1 as never, "myrepo", "doc.md");
    registry.subscribe(ws2 as never, "myrepo", "doc.md");

    registry.unsubscribeClient(ws1 as never);
    registry.unsubscribeClient(ws2 as never);

    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("同一クライアントが別ファイルを subscribe すると旧ファイルの購読から自動的に外れる（旧watchは購読者0なら解除される）", () => {
    vi.mocked(validateMdPath).mockReturnValueOnce({
      ok: true,
      resolvedPath: "/repos/myrepo/a.md",
      kind: "markdown",
    });
    const fakeA = mockChokidarWatch();
    const registry = createMdWatchRegistry(() => [], vi.fn());
    const ws = fakeWs();
    registry.subscribe(ws as never, "myrepo", "a.md");

    vi.mocked(validateMdPath).mockReturnValueOnce({
      ok: true,
      resolvedPath: "/repos/myrepo/b.md",
      kind: "markdown",
    });
    const fakeB = mockChokidarWatch();
    registry.subscribe(ws as never, "myrepo", "b.md");

    expect(fakeA.close).toHaveBeenCalledTimes(1);
    expect(fakeB.close).not.toHaveBeenCalled();
    expect(vi.mocked(watch)).toHaveBeenCalledTimes(2);
  });

  it("旧ファイルに他クライアントの購読が残っている場合、切替後も旧watchは解除されない", () => {
    vi.mocked(validateMdPath).mockReturnValue({
      ok: true,
      resolvedPath: "/repos/myrepo/a.md",
      kind: "markdown",
    });
    const fakeA = mockChokidarWatch();
    const registry = createMdWatchRegistry(() => [], vi.fn());
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    registry.subscribe(ws1 as never, "myrepo", "a.md");
    registry.subscribe(ws2 as never, "myrepo", "a.md");

    vi.mocked(validateMdPath).mockReturnValueOnce({
      ok: true,
      resolvedPath: "/repos/myrepo/b.md",
      kind: "markdown",
    });
    mockChokidarWatch();
    registry.subscribe(ws1 as never, "myrepo", "b.md");

    expect(fakeA.close).not.toHaveBeenCalled();
  });

  it("購読していないクライアントに unsubscribeClient を呼んでも例外を投げない", () => {
    const registry = createMdWatchRegistry(() => [], vi.fn());
    const ws = fakeWs();

    expect(() => registry.unsubscribeClient(ws as never)).not.toThrow();
    expect(vi.mocked(watch)).not.toHaveBeenCalled();
  });

  it("同一クライアントが今まさに購読中の同じファイルへ再 subscribe しても watch を張り直さない（旧watchをcloseしない）", () => {
    vi.mocked(validateMdPath).mockReturnValue({
      ok: true,
      resolvedPath: "/repos/myrepo/doc.md",
      kind: "markdown",
    });
    const fake = mockChokidarWatch();
    const registry = createMdWatchRegistry(() => [], vi.fn());
    const ws = fakeWs();
    registry.subscribe(ws as never, "myrepo", "doc.md");

    registry.subscribe(ws as never, "myrepo", "doc.md");

    expect(vi.mocked(watch)).toHaveBeenCalledTimes(1);
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("同一ファイルを別ラベル（repo/path）で購読する複数クライアントへは、それぞれの購読ラベルで md_file_changed が届く", () => {
    vi.mocked(validateMdPath).mockImplementation((_entries, repo, path) => {
      // symlink 経由の別名パス等、異なる (repo, path) が同一実体
      // （resolvedPath）に解決するケースを模す。
      return {
        ok: true,
        resolvedPath: "/repos/myrepo/real.md",
        kind: "markdown",
      };
    });
    const fake = mockChokidarWatch();
    const broadcastFileChanged = vi.fn();
    const registry = createMdWatchRegistry(() => [], broadcastFileChanged);
    const wsReal = fakeWs();
    const wsLink = fakeWs();
    registry.subscribe(wsReal as never, "myrepo", "real.md");
    registry.subscribe(wsLink as never, "myrepo", "link.md");

    fake.emit("change");

    expect(broadcastFileChanged).toHaveBeenCalledWith({
      type: "md_file_changed",
      repo: "myrepo",
      path: "real.md",
    });
    expect(broadcastFileChanged).toHaveBeenCalledWith({
      type: "md_file_changed",
      repo: "myrepo",
      path: "link.md",
    });
    expect(broadcastFileChanged).toHaveBeenCalledTimes(2);
  });

  it("同一ファイル・同一ラベルで購読する複数クライアントへは、変更通知が重複配信されない", () => {
    vi.mocked(validateMdPath).mockReturnValue({
      ok: true,
      resolvedPath: "/repos/myrepo/doc.md",
      kind: "markdown",
    });
    const fake = mockChokidarWatch();
    const broadcastFileChanged = vi.fn();
    const registry = createMdWatchRegistry(() => [], broadcastFileChanged);
    registry.subscribe(fakeWs() as never, "myrepo", "doc.md");
    registry.subscribe(fakeWs() as never, "myrepo", "doc.md");

    fake.emit("change");

    expect(broadcastFileChanged).toHaveBeenCalledTimes(1);
  });

  it("ファイル削除（unlink イベント）でも md_file_changed が broadcast される", () => {
    // セルフレビュー指摘対応: 削除後もクライアントが再フェッチできるよう
    // unlink も通知対象に含める（GET /api/md/file 側の 404 をクライアントが
    // 検知できるようにするため）。
    vi.mocked(validateMdPath).mockReturnValue({
      ok: true,
      resolvedPath: "/repos/myrepo/doc.md",
      kind: "markdown",
    });
    const fake = mockChokidarWatch();
    const broadcastFileChanged = vi.fn();
    const registry = createMdWatchRegistry(() => [], broadcastFileChanged);
    registry.subscribe(fakeWs() as never, "myrepo", "doc.md");

    fake.emit("unlink");

    expect(broadcastFileChanged).toHaveBeenCalledWith({
      type: "md_file_changed",
      repo: "myrepo",
      path: "doc.md",
    });
  });

  it("unsubscribeClient に match（repo/path）を渡した場合、現在の購読ラベルと一致しなければ解除しない", () => {
    // セルフレビュー指摘対応: 順序が入れ替わった／遅延した md_unsubscribe
    // （旧ファイル a.md 向け）が、直後に成立した新しい購読（b.md）を誤って
    // 解除してしまわないことを検証する。
    vi.mocked(validateMdPath).mockReturnValueOnce({
      ok: true,
      resolvedPath: "/repos/myrepo/a.md",
      kind: "markdown",
    });
    mockChokidarWatch();
    const registry = createMdWatchRegistry(() => [], vi.fn());
    const ws = fakeWs();
    registry.subscribe(ws as never, "myrepo", "a.md");

    vi.mocked(validateMdPath).mockReturnValueOnce({
      ok: true,
      resolvedPath: "/repos/myrepo/b.md",
      kind: "markdown",
    });
    const fakeB = mockChokidarWatch();
    registry.subscribe(ws as never, "myrepo", "b.md");

    // 遅延して届いた a.md 向けの md_unsubscribe。現在の購読は既に b.md のため
    // 一致せず、無視されるべき。
    registry.unsubscribeClient(ws as never, { repo: "myrepo", path: "a.md" });

    expect(fakeB.close).not.toHaveBeenCalled();
  });

  it("watch() が同期的に例外を投げても throw せず md_subscribe_error を返し、幻の購読状態も残らない（直後の subscribe で正常に watch が成立する）", () => {
    // セルフレビュー指摘対応: subscribe() は ensureWatchEntry（chokidar.watch
    // の確立）を先に行い、成功した後で購読状態を登録する。逆順だと watch() の
    // 同期例外時に「購読状態はあるが対応する WatchEntry が無い」幻の購読が
    // 残り、同一 resolvedPath への再 subscribe が fast path でラベル更新のみ
    // して早期 return するため、以後 watch が張られないままライブ更新が
    // 恒久的に無効化されてしまう不具合を防ぐ。
    // レビュー指摘対応（PR #87）: subscribe() は ws.on("message") リスナから
    // 同期的に呼ばれるため、例外を漏らすと uncaughtException でプロセスが
    // 落ちる。watch() の同期例外は捕捉して md_subscribe_error に変換する。
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(validateMdPath).mockReturnValue({
      ok: true,
      resolvedPath: "/repos/myrepo/doc.md",
      kind: "markdown",
    });
    vi.mocked(watch).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const registry = createMdWatchRegistry(() => [], vi.fn());
    const ws = fakeWs();

    try {
      expect(() =>
        registry.subscribe(ws as never, "myrepo", "doc.md"),
      ).not.toThrow();
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "md_subscribe_error",
          repo: "myrepo",
          path: "doc.md",
        }),
      );

      const fake = mockChokidarWatch();
      registry.subscribe(ws as never, "myrepo", "doc.md");

      expect(vi.mocked(watch)).toHaveBeenCalledTimes(2);
      expect(fake.close).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("unsubscribeClient に match（repo/path）を渡した場合、現在の購読ラベルと一致すれば解除する", () => {
    vi.mocked(validateMdPath).mockReturnValue({
      ok: true,
      resolvedPath: "/repos/myrepo/doc.md",
      kind: "markdown",
    });
    const fake = mockChokidarWatch();
    const registry = createMdWatchRegistry(() => [], vi.fn());
    const ws = fakeWs();
    registry.subscribe(ws as never, "myrepo", "doc.md");

    registry.unsubscribeClient(ws as never, {
      repo: "myrepo",
      path: "doc.md",
    });

    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});

describe("createMdWatchRegistry.closeAll", () => {
  it("保持している全 chokidar watch を close し、購読状態も破棄する", async () => {
    vi.mocked(validateMdPath).mockReturnValueOnce({
      ok: true,
      resolvedPath: "/repos/myrepo/a.md",
      kind: "markdown",
    });
    const fakeA = mockChokidarWatch();
    vi.mocked(validateMdPath).mockReturnValueOnce({
      ok: true,
      resolvedPath: "/repos/myrepo/b.md",
      kind: "markdown",
    });
    const fakeB = mockChokidarWatch();
    const registry = createMdWatchRegistry(() => [], vi.fn());
    registry.subscribe(fakeWs() as never, "myrepo", "a.md");
    registry.subscribe(fakeWs() as never, "myrepo", "b.md");

    await registry.closeAll();

    expect(fakeA.close).toHaveBeenCalledTimes(1);
    expect(fakeB.close).toHaveBeenCalledTimes(1);
  });

  it("closeAll 後に同一クライアントが unsubscribeClient を呼んでも例外を投げない（購読状態も破棄済み）", async () => {
    vi.mocked(validateMdPath).mockReturnValue({
      ok: true,
      resolvedPath: "/repos/myrepo/doc.md",
      kind: "markdown",
    });
    mockChokidarWatch();
    const registry = createMdWatchRegistry(() => [], vi.fn());
    const ws = fakeWs();
    registry.subscribe(ws as never, "myrepo", "doc.md");

    await registry.closeAll();

    expect(() => registry.unsubscribeClient(ws as never)).not.toThrow();
  });
});

describe("handleMdClientMessage", () => {
  function fakeRegistry(): {
    subscribe: MockedFunction<MdWatchRegistry["subscribe"]>;
    unsubscribeClient: MockedFunction<MdWatchRegistry["unsubscribeClient"]>;
  } {
    return {
      subscribe: vi.fn<MdWatchRegistry["subscribe"]>(),
      unsubscribeClient: vi.fn<MdWatchRegistry["unsubscribeClient"]>(),
    };
  }

  it("md_subscribe メッセージを受信すると registry.subscribe が repo/path 付きで呼ばれる", () => {
    const registry = fakeRegistry();
    const ws = fakeWs();

    handleMdClientMessage(
      registry,
      ws as never,
      JSON.stringify({ type: "md_subscribe", repo: "myrepo", path: "doc.md" }),
    );

    expect(registry.subscribe).toHaveBeenCalledWith(ws, "myrepo", "doc.md");
  });

  it("md_unsubscribe メッセージを受信すると registry.unsubscribeClient が repo/path の match 付きで呼ばれる", () => {
    // セルフレビュー指摘対応: 順序が入れ替わった／遅延した md_unsubscribe が、
    // その後に成立した別ファイルの購読を誤って解除しないよう、
    // handleMdClientMessage は repo/path を match として unsubscribeClient へ渡す
    // （unsubscribeClient 側の照合は createMdWatchRegistry.subscribe/unsubscribeClient
    // の describe 群で別途検証する）。
    const registry = fakeRegistry();
    const ws = fakeWs();

    handleMdClientMessage(
      registry,
      ws as never,
      JSON.stringify({
        type: "md_unsubscribe",
        repo: "myrepo",
        path: "doc.md",
      }),
    );

    expect(registry.unsubscribeClient).toHaveBeenCalledWith(ws, {
      repo: "myrepo",
      path: "doc.md",
    });
  });

  it("不正な JSON は無視される（例外を投げない）", () => {
    const registry = fakeRegistry();
    const ws = fakeWs();

    expect(() =>
      handleMdClientMessage(registry, ws as never, "not-json{"),
    ).not.toThrow();
    expect(registry.subscribe).not.toHaveBeenCalled();
    expect(registry.unsubscribeClient).not.toHaveBeenCalled();
  });

  it("repo/path が文字列でない md_subscribe は無視される", () => {
    const registry = fakeRegistry();
    const ws = fakeWs();

    handleMdClientMessage(
      registry,
      ws as never,
      JSON.stringify({ type: "md_subscribe", repo: 123, path: "doc.md" }),
    );

    expect(registry.subscribe).not.toHaveBeenCalled();
  });

  it("repo/path が文字列でない md_unsubscribe は無視される", () => {
    const registry = fakeRegistry();
    const ws = fakeWs();

    handleMdClientMessage(
      registry,
      ws as never,
      JSON.stringify({ type: "md_unsubscribe", repo: 123, path: "doc.md" }),
    );

    expect(registry.unsubscribeClient).not.toHaveBeenCalled();
  });

  it("未知の type のメッセージは無視される", () => {
    const registry = fakeRegistry();
    const ws = fakeWs();

    handleMdClientMessage(
      registry,
      ws as never,
      JSON.stringify({ type: "unknown_type" }),
    );

    expect(registry.subscribe).not.toHaveBeenCalled();
    expect(registry.unsubscribeClient).not.toHaveBeenCalled();
  });
});
