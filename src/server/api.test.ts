import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import type { FSWatcher } from "chokidar";
import { watch } from "chokidar";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  attachWebSocketServer,
  isAllowedHost,
  isAllowedOrigin,
  registerApiRoutes,
} from "./api.ts";
import type { FleetAgentAdditionDeps } from "./api.ts";
import { createMemoryBoardCache } from "./cache.ts";
import type { FleetEntry } from "./manifest.ts";
import type { FleetWatcher } from "./watcher.ts";

// Issue #88: md_subscribe/md_unsubscribe（Issue #67）ブロックが実 chokidar・
// 固定 sleep に依存し、負荷の高い CI で偽陽性・偽陰性を招きうるため、
// src/server/md/watch.test.ts と同じパターンで chokidar 自体をモックする。
// このモジュールモックはファイル全体（このファイルが依存する api.ts →
// md/watch.ts → chokidar の依存グラフ全体）に透過的に効く。他の describe
// ブロックは chokidar に依存しないため影響しない。
vi.mock("chokidar", () => ({ watch: vi.fn() }));

describe("isAllowedHost", () => {
  it("localhost を許可する", () => {
    expect(isAllowedHost("localhost")).toBe(true);
  });

  it("127.0.0.1 を許可する", () => {
    expect(isAllowedHost("127.0.0.1")).toBe(true);
  });

  it("ポート番号付きの localhost / 127.0.0.1 を許可する", () => {
    expect(isAllowedHost("localhost:4317")).toBe(true);
    expect(isAllowedHost("127.0.0.1:4317")).toBe(true);
  });

  it("それ以外のホストは拒否する", () => {
    expect(isAllowedHost("evil.example.com")).toBe(false);
    expect(isAllowedHost("evil.example.com:4317")).toBe(false);
  });

  it("Host ヘッダが無い場合は拒否する", () => {
    expect(isAllowedHost(undefined)).toBe(false);
    expect(isAllowedHost(null)).toBe(false);
    expect(isAllowedHost("")).toBe(false);
  });
});

describe("isAllowedOrigin", () => {
  it("Origin ヘッダが無い場合は許容する（非ブラウザからの直接アクセス等）", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin(null)).toBe(true);
  });

  it("http://localhost 系の Origin を許可する", () => {
    expect(isAllowedOrigin("http://localhost")).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
  });

  it("http://127.0.0.1 系の Origin を許可する", () => {
    expect(isAllowedOrigin("http://127.0.0.1")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:5173")).toBe(true);
  });

  it("https の localhost / 127.0.0.1 も許可する", () => {
    expect(isAllowedOrigin("https://localhost:5173")).toBe(true);
    expect(isAllowedOrigin("https://127.0.0.1:5173")).toBe(true);
  });

  it("それ以外の Origin は拒否する", () => {
    expect(isAllowedOrigin("http://evil.example.com")).toBe(false);
    expect(isAllowedOrigin("https://evil.example.com:5173")).toBe(false);
  });

  it("不正な形式の Origin は拒否する", () => {
    expect(isAllowedOrigin("not-a-valid-origin")).toBe(false);
  });
});

describe("registerApiRoutes", () => {
  function buildApp() {
    const cache = createMemoryBoardCache();
    cache.replaceAgent({
      name: "medical",
      path: "/agents/medical-agent",
      challenges: [
        {
          id: "C-001",
          title: "テスト課題",
          status: "着手中",
          needsHuman: false,
        },
      ],
      parseErrors: [],
    });
    cache.replaceJournal("medical", [
      {
        date: "2026-07-02",
        seq: 1,
        touched_issues: [{ id: "C-001", from: "未着手", to: "着手中" }],
        delegations: [],
        pr_urls: [],
        pending_approvals: [],
        decisions: [],
      },
    ]);
    const app = new Hono();
    registerApiRoutes(app, cache, () => []);
    return app;
  }

  it("GET /api/board は BoardSnapshot を返す", async () => {
    const app = buildApp();
    const res = await app.request("/api/board", {
      headers: { host: "localhost" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].name).toBe("medical");
    expect(body.agents[0].challenges[0].id).toBe("C-001");
  });

  it("GET /api/log はクエリパラメータが揃っていれば LogEntry[] を返す", async () => {
    const app = buildApp();
    const res = await app.request("/api/log?agent=medical&challenge=C-001", {
      headers: { host: "localhost" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      { ts: "2026-07-02", source: "journal", text: "未着手 → 着手中" },
    ]);
  });

  it("GET /api/log は agent クエリが欠落していると 400 を返す", async () => {
    const app = buildApp();
    const res = await app.request("/api/log?challenge=C-001", {
      headers: { host: "localhost" },
    });

    expect(res.status).toBe(400);
  });

  it("GET /api/log は challenge クエリが欠落していると 400 を返す", async () => {
    const app = buildApp();
    const res = await app.request("/api/log?agent=medical", {
      headers: { host: "localhost" },
    });

    expect(res.status).toBe(400);
  });

  it("Host ヘッダが不正な /api/* リクエストは 403 を返す", async () => {
    const app = buildApp();
    const res = await app.request("/api/board", {
      headers: { host: "evil.example.com" },
    });

    expect(res.status).toBe(403);
  });

  it("Origin ヘッダが不正な /api/* リクエストは 403 を返す", async () => {
    const app = buildApp();
    const res = await app.request("/api/board", {
      headers: { host: "localhost", origin: "http://evil.example.com" },
    });

    expect(res.status).toBe(403);
  });
});

describe("GET /api/md/tree（Issue #65）", () => {
  let tempRoot: string;
  let repoRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "api-md-tree-test-"));
    repoRoot = path.join(tempRoot, "repo");
    fs.mkdirSync(repoRoot);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("getFleetEntries から取得した repo 配下の .md 一覧を { repos } で返す", async () => {
    fs.writeFileSync(path.join(repoRoot, "doc.md"), "# doc");
    fs.writeFileSync(path.join(repoRoot, "notes.txt"), "not markdown");

    const cache = createMemoryBoardCache();
    const app = new Hono();
    const getFleetEntries = (): readonly FleetEntry[] => [
      { name: "myrepo", path: repoRoot },
    ];
    registerApiRoutes(app, cache, getFleetEntries);

    const res = await app.request("/api/md/tree", {
      headers: { host: "localhost" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ repos: [{ name: "myrepo", files: ["doc.md"] }] });
  });

  it("不正な Host ヘッダの /api/md/tree リクエストは 403 を返す（既存の Host/Origin 検証を継承）", async () => {
    const cache = createMemoryBoardCache();
    const app = new Hono();
    registerApiRoutes(app, cache, () => []);

    const res = await app.request("/api/md/tree", {
      headers: { host: "evil.example.com" },
    });

    expect(res.status).toBe(403);
  });
});

describe("GET /api/md/file（Issue #66）", () => {
  let tempRoot: string;
  let repoRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "api-md-file-test-"));
    repoRoot = path.join(tempRoot, "repo");
    fs.mkdirSync(repoRoot);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function buildAppWithRepo() {
    const cache = createMemoryBoardCache();
    const app = new Hono();
    const getFleetEntries = (): readonly FleetEntry[] => [
      { name: "myrepo", path: repoRoot },
    ];
    registerApiRoutes(app, cache, getFleetEntries);
    return app;
  }

  it("検証通過した .md ファイルの内容を { content } で返す", async () => {
    fs.writeFileSync(path.join(repoRoot, "doc.md"), "# doc content");
    const app = buildAppWithRepo();

    const res = await app.request("/api/md/file?repo=myrepo&path=doc.md", {
      headers: { host: "localhost" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ content: "# doc content" });
  });

  it("存在しないファイルは 404 を返す", async () => {
    const app = buildAppWithRepo();

    const res = await app.request("/api/md/file?repo=myrepo&path=missing.md", {
      headers: { host: "localhost" },
    });

    expect(res.status).toBe(404);
  });

  // chmod 0o000 は root 実行（コンテナ CI 等）だと権限ビットが無視されて
  // 読み取れてしまい、404 も console.warn も発生しない。Windows も同様に
  // POSIX 権限ビットが効かないため、両環境ではスキップする。
  const canTestUnreadable =
    process.platform !== "win32" && process.getuid?.() !== 0;

  it.skipIf(!canTestUnreadable)(
    "検証・stat 通過後に読み取りが失敗する場合（権限無し等）も 404 を返す（500 で存在有無を漏らさない）",
    async () => {
      const unreadablePath = path.join(repoRoot, "unreadable.md");
      fs.writeFileSync(unreadablePath, "# secret");
      fs.chmodSync(unreadablePath, 0o000);
      const app = buildAppWithRepo();

      try {
        const res = await app.request(
          "/api/md/file?repo=myrepo&path=unreadable.md",
          { headers: { host: "localhost" } },
        );

        expect(res.status).toBe(404);
      } finally {
        // afterEach の rmSync がディレクトリごと削除できるよう権限を戻す。
        fs.chmodSync(unreadablePath, 0o644);
      }
    },
  );

  it.skipIf(!canTestUnreadable)(
    "検証通過後の読み取り失敗はクライアントへ 404 を返しつつ console.warn で記録する（運用時の切り分けのため。設定ミス等を「.md が読めない」と見分けられなくしないという動機は tree.ts の repo ルート走査失敗記録と同じだが、tree.ts の非ルート走査失敗の黙殺方針をそのまま踏襲したものではない）",
    async () => {
      const unreadablePath = path.join(repoRoot, "unreadable-logged.md");
      fs.writeFileSync(unreadablePath, "# secret");
      fs.chmodSync(unreadablePath, 0o000);
      const app = buildAppWithRepo();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        await app.request(
          "/api/md/file?repo=myrepo&path=unreadable-logged.md",
          {
            headers: { host: "localhost" },
          },
        );

        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        fs.chmodSync(unreadablePath, 0o644);
        warnSpy.mockRestore();
      }
    },
  );

  it("存在しない repo 名は 404 を返す", async () => {
    const app = buildAppWithRepo();

    const res = await app.request("/api/md/file?repo=unknown&path=doc.md", {
      headers: { host: "localhost" },
    });

    expect(res.status).toBe(404);
  });

  it(".md 以外の拡張子は 404 を返す", async () => {
    fs.writeFileSync(path.join(repoRoot, "notes.txt"), "not markdown");
    const app = buildAppWithRepo();

    const res = await app.request("/api/md/file?repo=myrepo&path=notes.txt", {
      headers: { host: "localhost" },
    });

    expect(res.status).toBe(404);
  });

  it("../ を含む相対パスで repo 外への脱出を試みると 404 を返す", async () => {
    fs.writeFileSync(path.join(tempRoot, "outside.md"), "# outside");
    const app = buildAppWithRepo();

    const res = await app.request(
      "/api/md/file?repo=myrepo&path=../outside.md",
      { headers: { host: "localhost" } },
    );

    expect(res.status).toBe(404);
  });

  it("絶対パスを path クエリに渡すと 404 を返す", async () => {
    const outsideAbsolutePath = path.join(tempRoot, "abs-outside.md");
    fs.writeFileSync(outsideAbsolutePath, "# outside abs");
    const app = buildAppWithRepo();

    const res = await app.request(
      `/api/md/file?repo=myrepo&path=${encodeURIComponent(outsideAbsolutePath)}`,
      { headers: { host: "localhost" } },
    );

    expect(res.status).toBe(404);
  });

  it("シンボリックリンク経由で repo 外の実体を指す場合は 404 を返す", async () => {
    const outsideDir = path.join(tempRoot, "outside-dir");
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, "secret.md"), "# secret");
    fs.symlinkSync(
      path.join(outsideDir, "secret.md"),
      path.join(repoRoot, "link.md"),
    );
    const app = buildAppWithRepo();

    const res = await app.request("/api/md/file?repo=myrepo&path=link.md", {
      headers: { host: "localhost" },
    });

    expect(res.status).toBe(404);
  });

  it("repo / path クエリパラメータが欠落している場合は 404 を返す", async () => {
    fs.writeFileSync(path.join(repoRoot, "doc.md"), "# doc content");
    const app = buildAppWithRepo();

    const resNoRepo = await app.request("/api/md/file?path=doc.md", {
      headers: { host: "localhost" },
    });
    const resNoPath = await app.request("/api/md/file?repo=myrepo", {
      headers: { host: "localhost" },
    });
    const resNeither = await app.request("/api/md/file", {
      headers: { host: "localhost" },
    });

    expect(resNoRepo.status).toBe(404);
    expect(resNoPath.status).toBe(404);
    expect(resNeither.status).toBe(404);
  });

  it("検証通過済みファイルが 1MB 超の場合は本文を読み込まずに 413 を返す", async () => {
    const oversizedPath = path.join(repoRoot, "oversized.md");
    fs.writeFileSync(oversizedPath, "a".repeat(1024 * 1024 + 1));
    const app = buildAppWithRepo();
    const readFileSpy = vi.spyOn(fs.promises, "readFile");

    try {
      const res = await app.request(
        "/api/md/file?repo=myrepo&path=oversized.md",
        { headers: { host: "localhost" } },
      );

      expect(res.status).toBe(413);
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      // 先行アサーション（413判定）が失敗した場合でも spy を確実に解除し、
      // 後続テストへ漏れないようにする。
      readFileSpy.mockRestore();
    }
  });

  it("マルチバイト文字のみで構成され UTF-16 コードユニット数は 1MB 未満だがバイト数は 1MB 超のファイルは 413 を返す（バイト基準の判定であることの回帰ガード）", async () => {
    // "あ" は UTF-8 で3バイト・UTF-16では1コードユニット。350,000文字なら
    // バイト数は 1,050,000（1MB超）だが文字数（コードユニット数）は 1MB 未満となり、
    // サイズ判定が stat.size（バイト）ではなく content.length（文字数）等に
    // リファクタされた場合の回帰を検出できる。
    const multibytePath = path.join(repoRoot, "multibyte.md");
    const multibyteContent = "あ".repeat(350000);
    fs.writeFileSync(multibytePath, multibyteContent);
    expect(Buffer.byteLength(multibyteContent, "utf-8")).toBeGreaterThan(
      1024 * 1024,
    );
    expect(multibyteContent.length).toBeLessThan(1024 * 1024);
    const app = buildAppWithRepo();

    const res = await app.request(
      "/api/md/file?repo=myrepo&path=multibyte.md",
      { headers: { host: "localhost" } },
    );

    expect(res.status).toBe(413);
  });

  it("ファイルサイズが 1MB ちょうどの場合は 200 を返す", async () => {
    const exactPath = path.join(repoRoot, "exact.md");
    fs.writeFileSync(exactPath, "a".repeat(1024 * 1024));
    const app = buildAppWithRepo();

    const res = await app.request("/api/md/file?repo=myrepo&path=exact.md", {
      headers: { host: "localhost" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toHaveLength(1024 * 1024);
  });

  it("ファイルサイズが 1MB 未満の場合は 200 を返す", async () => {
    const underPath = path.join(repoRoot, "under.md");
    fs.writeFileSync(underPath, "a".repeat(1024 * 1024 - 1));
    const app = buildAppWithRepo();

    const res = await app.request("/api/md/file?repo=myrepo&path=under.md", {
      headers: { host: "localhost" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toHaveLength(1024 * 1024 - 1);
  });

  it("不正な Host ヘッダの /api/md/file リクエストは 403 を返す（既存の Host/Origin 検証を継承）", async () => {
    const app = buildAppWithRepo();

    const res = await app.request("/api/md/file?repo=myrepo&path=doc.md", {
      headers: { host: "evil.example.com" },
    });

    expect(res.status).toBe(403);
  });
});

// Issue #62: fleet entries を遅延参照できる getFleetEntries コールバックを
// registerApiRoutes に供給できることを確認する。GET /api/md/tree（Issue #65）は
// 上の describe で別途検証済みのため、ここで検証するのは以下の2点に限る。
// (1) 第3引数を渡しても既存エンドポイントの挙動に回帰が無いこと（後方互換）
// (2) /api/board へのリクエストのみでは getFleetEntries を呼び出さない
//     （md 系ハンドラ内でのみリクエストのたびに呼び出す設計の回帰ガード。
//     ルート登録時点での eager 評価を持ち込まないことも同時に確認する）
describe("registerApiRoutes の getFleetEntries 供給経路（Issue #62）", () => {
  it("getFleetEntries を渡しても GET /api/board の応答は変わらない（後方互換）", async () => {
    const cache = createMemoryBoardCache();
    cache.replaceAgent({
      name: "medical",
      path: "/agents/medical-agent",
      challenges: [],
      parseErrors: [],
    });
    const app = new Hono();
    const getFleetEntries = (): readonly FleetEntry[] => [
      { name: "medical", path: "/repos/medical-agent" },
    ];

    registerApiRoutes(app, cache, getFleetEntries);
    const res = await app.request("/api/board", {
      headers: { host: "localhost" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents[0].name).toBe("medical");
  });

  it("ルート登録処理自体は getFleetEntries を呼び出さない（eager 評価の回帰ガード）", async () => {
    const cache = createMemoryBoardCache();
    const app = new Hono();
    const getFleetEntries = vi.fn((): readonly FleetEntry[] => [
      { name: "medical", path: "/repos/x" },
    ]);

    registerApiRoutes(app, cache, getFleetEntries);
    await app.request("/api/board", { headers: { host: "localhost" } });

    expect(getFleetEntries).not.toHaveBeenCalled();
  });
});

describe("attachWebSocketServer 統合テスト", () => {
  let server: ReturnType<typeof serve> | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("接続確立時に snapshot メッセージを受信できる", async () => {
    const cache = createMemoryBoardCache();
    cache.replaceAgent({
      name: "medical",
      path: "/agents/medical-agent",
      challenges: [],
      parseErrors: [],
    });
    const app = new Hono();
    registerApiRoutes(app, cache, () => []);

    await new Promise<void>((resolve, reject) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () =>
        resolve(),
      );
      server.on("error", reject);
    });
    if (!server) {
      throw new Error("server が起動していない");
    }
    attachWebSocketServer(server, cache, () => []);

    const address = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { origin: "http://localhost:5173" },
    });

    const message = await new Promise<string>((resolve, reject) => {
      ws.on("message", (data) => resolve(data.toString()));
      ws.on("error", reject);
    });

    const parsed = JSON.parse(message);
    expect(parsed.type).toBe("snapshot");
    expect(parsed.board.agents).toHaveLength(1);
    expect(parsed.board.agents[0].name).toBe("medical");

    ws.close();
  });

  it("不正な Origin ヘッダのハンドシェイクは拒否される", async () => {
    const cache = createMemoryBoardCache();
    const app = new Hono();
    registerApiRoutes(app, cache, () => []);

    await new Promise<void>((resolve, reject) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () =>
        resolve(),
      );
      server.on("error", reject);
    });
    if (!server) {
      throw new Error("server が起動していない");
    }
    attachWebSocketServer(server, cache, () => []);

    const address = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { origin: "http://evil.example.com" },
    });

    const result = await new Promise<"open" | "closed" | "error">((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("close", () => resolve("closed"));
      ws.on("error", () => resolve("error"));
    });

    expect(result).not.toBe("open");
  });

  it("クエリ付きの /ws?x への upgrade も pathname 一致で処理される（半開き接続で残さない）", async () => {
    const cache = createMemoryBoardCache();
    const app = new Hono();
    registerApiRoutes(app, cache, () => []);

    await new Promise<void>((resolve, reject) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () =>
        resolve(),
      );
      server.on("error", reject);
    });
    if (!server) {
      throw new Error("server が起動していない");
    }
    attachWebSocketServer(server, cache, () => []);

    const address = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws?x`, {
      headers: { origin: "http://localhost:5173" },
    });

    const message = await new Promise<string>((resolve, reject) => {
      ws.on("message", (data) => resolve(data.toString()));
      ws.on("error", reject);
    });

    const parsed = JSON.parse(message);
    expect(parsed.type).toBe("snapshot");

    // close イベントを待ってから終える（切断処理が残ったまま次の後始末
    // （afterEach の server.close()）に進まないようにするため）。
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
  });

  it("/ws 以外の URL の upgrade リクエストはソケットに触れない（/ws/terminal 等、別ハンドラとの共存のため）", async () => {
    const cache = createMemoryBoardCache();
    const app = new Hono();
    registerApiRoutes(app, cache, () => []);

    await new Promise<void>((resolve, reject) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () =>
        resolve(),
      );
      server.on("error", reject);
    });
    if (!server) {
      throw new Error("server が起動していない");
    }
    attachWebSocketServer(server, cache, () => []);

    const address = server.address() as AddressInfo;
    const socket = net.connect(address.port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });

    const closedWithinTimeout = await new Promise<boolean>((resolve) => {
      socket.once("close", () => resolve(true));
      socket.write(
        [
          "GET /ws/terminal?agent=medical HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
      setTimeout(() => resolve(false), 200);
    });

    expect(closedWithinTimeout).toBe(false);
    socket.destroy();
  });
});

describe("attachWebSocketServer の md_subscribe / md_unsubscribe（Issue #67）", () => {
  let server: ReturnType<typeof serve> | undefined;
  let tempRoot: string;
  let repoRoot: string;

  // src/server/md/watch.test.ts と同じ FakeFSWatcher パターン。close は
  // Promise を返す chokidar.FSWatcher の契約に合わせる。
  class FakeFSWatcher extends EventEmitter {
    close = vi.fn().mockResolvedValue(undefined);
  }

  function mockChokidarWatch(): FakeFSWatcher {
    const fake = new FakeFSWatcher();
    vi.mocked(watch).mockReturnValueOnce(fake as unknown as FSWatcher);
    return fake;
  }

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "api-md-watch-test-"));
    repoRoot = path.join(tempRoot, "repo");
    fs.mkdirSync(repoRoot);
    vi.mocked(watch).mockReset();
  });

  afterEach(() => {
    server?.close();
    server = undefined;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  async function waitUntil(
    condition: () => boolean,
    { timeoutMs = 3000, intervalMs = 20 } = {},
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (condition()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`waitUntil: タイムアウトしました（${timeoutMs}ms）`);
  }

  async function connectClient(
    getFleetEntries: () => readonly FleetEntry[],
  ): Promise<WebSocket> {
    const cache = createMemoryBoardCache();
    const app = new Hono();
    registerApiRoutes(app, cache, getFleetEntries);

    await new Promise<void>((resolve, reject) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () =>
        resolve(),
      );
      server.on("error", reject);
    });
    if (!server) {
      throw new Error("server が起動していない");
    }
    attachWebSocketServer(server, cache, getFleetEntries);

    const address = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { origin: "http://localhost:5173" },
    });
    // snapshot（接続直後の1通目）を待ち、以降のテストは md_* メッセージだけを
    // 見れば済むようにする。
    await new Promise<void>((resolve, reject) => {
      ws.once("message", () => resolve());
      ws.once("error", reject);
    });
    return ws;
  }

  function collectMessages(ws: WebSocket): unknown[] {
    const messages: unknown[] = [];
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
    });
    return messages;
  }

  it("存在しない repo への md_subscribe は md_subscribe_error を該当クライアントへ返す", async () => {
    const ws = await connectClient(() => []);
    const messages = collectMessages(ws);

    ws.send(
      JSON.stringify({ type: "md_subscribe", repo: "unknown", path: "doc.md" }),
    );

    await waitUntil(() => messages.length > 0);
    expect(messages[0]).toEqual({
      type: "md_subscribe_error",
      repo: "unknown",
      path: "doc.md",
    });

    ws.close();
  });

  // Issue #67 完了条件（AC-7 の WS 経路）: `../` を含むパス・絶対パス・
  // シンボリックリンク経由の repo 外パス・`.md` 以外の拡張子はすべて
  // md_subscribe_error を返し、watch を開始しない。HTTP 側（GET /api/md/file、
  // 上の describe("GET /api/md/file（Issue #66）")）と同じ拒否ケースを、
  // WS md_subscribe 経路でも単体テストとして担保する。パス検証（validateMdPath）
  // の合否自体は path-validation.test.ts で単体テストとして担保済みのため
  // ここでは再検証しない。「watch が開始されない」ことは、chokidar をモックし
  // `vi.mocked(watch)` が呼ばれていないことを直接アサートして確認する
  // （Issue #88: 実ファイルへの書き込み＋固定 sleep 待機での間接確認は
  // 決定的でなく負荷の高い CI で偽陰性を招きうるため廃止）。
  describe("md_subscribe のパス検証（#63 共有ロジックの WS 経路適用）", () => {
    async function assertSubscribeRejectedAndNoWatch(
      getFleetEntries: () => readonly FleetEntry[],
      subscribeMessage: { repo: string; path: string },
    ): Promise<void> {
      const ws = await connectClient(getFleetEntries);
      const messages = collectMessages(ws);

      ws.send(JSON.stringify({ type: "md_subscribe", ...subscribeMessage }));
      await waitUntil(() => messages.length > 0);
      expect(messages[0]).toEqual({
        type: "md_subscribe_error",
        ...subscribeMessage,
      });
      expect(vi.mocked(watch)).not.toHaveBeenCalled();

      ws.close();
    }

    it("../ を含む相対パスで repo 外への脱出を試みると md_subscribe_error を返し watch を開始しない", async () => {
      const outsidePath = path.join(tempRoot, "outside.md");
      fs.writeFileSync(outsidePath, "# outside");
      const getFleetEntries = (): readonly FleetEntry[] => [
        { name: "myrepo", path: repoRoot },
      ];

      await assertSubscribeRejectedAndNoWatch(getFleetEntries, {
        repo: "myrepo",
        path: "../outside.md",
      });
    });

    it("絶対パスを path に渡すと md_subscribe_error を返し watch を開始しない", async () => {
      const outsideAbsolutePath = path.join(tempRoot, "abs-outside.md");
      fs.writeFileSync(outsideAbsolutePath, "# outside abs");
      const getFleetEntries = (): readonly FleetEntry[] => [
        { name: "myrepo", path: repoRoot },
      ];

      await assertSubscribeRejectedAndNoWatch(getFleetEntries, {
        repo: "myrepo",
        path: outsideAbsolutePath,
      });
    });

    it("シンボリックリンク経由で repo 外の実体を指す場合は md_subscribe_error を返し watch を開始しない", async () => {
      const outsideDir = path.join(tempRoot, "outside-dir");
      fs.mkdirSync(outsideDir);
      const secretPath = path.join(outsideDir, "secret.md");
      fs.writeFileSync(secretPath, "# secret");
      fs.symlinkSync(secretPath, path.join(repoRoot, "link.md"));
      const getFleetEntries = (): readonly FleetEntry[] => [
        { name: "myrepo", path: repoRoot },
      ];

      await assertSubscribeRejectedAndNoWatch(getFleetEntries, {
        repo: "myrepo",
        path: "link.md",
      });
    });

    it(".md 以外の拡張子は md_subscribe_error を返し watch を開始しない", async () => {
      const notesPath = path.join(repoRoot, "notes.txt");
      fs.writeFileSync(notesPath, "not markdown");
      const getFleetEntries = (): readonly FleetEntry[] => [
        { name: "myrepo", path: repoRoot },
      ];

      await assertSubscribeRejectedAndNoWatch(getFleetEntries, {
        repo: "myrepo",
        path: "notes.txt",
      });
    });
  });

  it("有効な .md ファイルを md_subscribe すると、ファイル変更時に md_file_changed を受信する", async () => {
    const docPath = path.join(repoRoot, "doc.md");
    fs.writeFileSync(docPath, "# doc");
    const getFleetEntries = (): readonly FleetEntry[] => [
      { name: "myrepo", path: repoRoot },
    ];
    const fake = mockChokidarWatch();
    const ws = await connectClient(getFleetEntries);
    const messages = collectMessages(ws);

    ws.send(
      JSON.stringify({ type: "md_subscribe", repo: "myrepo", path: "doc.md" }),
    );
    // chokidar はモックされているため実ファイル監視の確立を待つ必要はなく、
    // サーバ側で subscribe 処理が完了した（chokidar.watch が呼ばれた）ことを
    // 待てば足りる。以降は FakeFSWatcher へ change イベントを同期的に注入する。
    await waitUntil(() => vi.mocked(watch).mock.calls.length > 0);
    // セルフレビュー指摘対応: fake.emit("change") は watch() へ渡された引数と
    // 無関係に発火できてしまうため、これだけでは「サーバが実 validateMdPath で
    // 解決した正しい resolvedPath を chokidar.watch へ渡している」ことを検証
    // できない。呼び出し引数を明示的にアサートし、この経路の実効性を担保する。
    expect(vi.mocked(watch)).toHaveBeenCalledWith(
      fs.realpathSync(docPath),
      expect.objectContaining({ ignoreInitial: true }),
    );
    fake.emit("change");

    await waitUntil(() =>
      messages.some((m) => (m as { type?: string }).type === "md_file_changed"),
    );
    const changed = messages.find(
      (m) => (m as { type?: string }).type === "md_file_changed",
    );
    expect(changed).toEqual({
      type: "md_file_changed",
      repo: "myrepo",
      path: "doc.md",
    });

    ws.close();
  });

  it("md_unsubscribe 後はファイル変更を通知されない", async () => {
    const docPath = path.join(repoRoot, "doc.md");
    fs.writeFileSync(docPath, "# doc");
    const getFleetEntries = (): readonly FleetEntry[] => [
      { name: "myrepo", path: repoRoot },
    ];
    const fake = mockChokidarWatch();
    const ws = await connectClient(getFleetEntries);
    const messages = collectMessages(ws);

    ws.send(
      JSON.stringify({ type: "md_subscribe", repo: "myrepo", path: "doc.md" }),
    );
    await waitUntil(() => vi.mocked(watch).mock.calls.length > 0);
    ws.send(
      JSON.stringify({
        type: "md_unsubscribe",
        repo: "myrepo",
        path: "doc.md",
      }),
    );
    // unsubscribe により refcount が 0 になり chokidar watch が close される
    // （＝サーバ側で unsubscribe 処理が完了した）ことを待つ。
    await waitUntil(() => fake.close.mock.calls.length > 0);
    fake.emit("change");

    // セルフレビュー指摘対応: 「届かないこと」自体には決定的な待ち条件が無い
    // ため、固定 sleep ではなく「往復が保証されたセンチネル」で待つ。
    // fake.emit("change") は同期呼び出しであり、それが引き起こす（本来は
    // 起きないはずの）サーバ→クライアント送信は、この直後に送るセンチネルの
    // 処理より必ず先に発生する。同一 WS 接続上の送信順序は保存されるため、
    // センチネルの応答が届いた時点で md_file_changed が来ていなければ、以後も
    // 届かないと判定できる。センチネルには存在しない repo への md_subscribe を
    // 使う（validateMdPath がエントリ探索の時点で同期的に弾くため chokidar には
    // 触れず、本テストの前提を汚さない）。
    ws.send(
      JSON.stringify({
        type: "md_subscribe",
        repo: "sentinel-unknown-repo",
        path: "sentinel.md",
      }),
    );
    await waitUntil(() =>
      messages.some(
        (m) =>
          (m as { type?: string; repo?: string }).type ===
            "md_subscribe_error" &&
          (m as { repo?: string }).repo === "sentinel-unknown-repo",
      ),
    );

    expect(
      messages.some((m) => (m as { type?: string }).type === "md_file_changed"),
    ).toBe(false);

    ws.close();
  });

  it("WS 切断後もファイル変更検知でサーバがクラッシュしない（クリーンアップの回帰確認）", async () => {
    const docPath = path.join(repoRoot, "doc.md");
    fs.writeFileSync(docPath, "# doc");
    const getFleetEntries = (): readonly FleetEntry[] => [
      { name: "myrepo", path: repoRoot },
    ];
    const fake = mockChokidarWatch();
    const ws = await connectClient(getFleetEntries);

    ws.send(
      JSON.stringify({ type: "md_subscribe", repo: "myrepo", path: "doc.md" }),
    );
    await waitUntil(() => vi.mocked(watch).mock.calls.length > 0);

    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
    // WS close ハンドラでの unsubscribeClient 完了（refcount 0 による
    // chokidar watch の close 呼び出し）を待ってからイベントを発火する。
    await waitUntil(() => fake.close.mock.calls.length > 0);

    // 切断後の変更検知が例外を投げないことを確認する（クラッシュしなければ成功）。
    expect(() => fake.emit("change")).not.toThrow();
  });
});

// Issue #62: attachWebSocketServer 版の getFleetEntries 供給経路。registerApiRoutes と
// 同じ観点（後方互換・アタッチ/接続時に eager 評価しないこと）を検証する。ただし
// registerApiRoutes 側と同様、この関数の本体はまだ getFleetEntries を一切参照しない
// ため、ここで検証できるのは「後方互換」と「eager 評価しない」の2点までであり、
// 「値が実際に消費される」ところまではこのチケットの範囲では検証できない。
describe("attachWebSocketServer の getFleetEntries 供給経路（Issue #62）", () => {
  let server: ReturnType<typeof serve> | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("getFleetEntries を渡しても snapshot 受信は変わらない（後方互換）", async () => {
    const cache = createMemoryBoardCache();
    cache.replaceAgent({
      name: "medical",
      path: "/agents/medical-agent",
      challenges: [],
      parseErrors: [],
    });
    const app = new Hono();
    registerApiRoutes(app, cache, () => []);

    await new Promise<void>((resolve, reject) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () =>
        resolve(),
      );
      server.on("error", reject);
    });
    if (!server) {
      throw new Error("server が起動していない");
    }
    const getFleetEntries = (): readonly FleetEntry[] => [
      { name: "medical", path: "/repos/medical-agent" },
    ];
    attachWebSocketServer(server, cache, getFleetEntries);

    const address = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { origin: "http://localhost:5173" },
    });

    const message = await new Promise<string>((resolve, reject) => {
      ws.on("message", (data) => resolve(data.toString()));
      ws.on("error", reject);
    });

    const parsed = JSON.parse(message);
    expect(parsed.type).toBe("snapshot");
    expect(parsed.board.agents[0].name).toBe("medical");

    ws.close();
  });

  it("WS アタッチ時・接続確立時のいずれでも getFleetEntries は呼び出されない（eager 評価の回帰ガード）", async () => {
    const cache = createMemoryBoardCache();
    const app = new Hono();
    registerApiRoutes(app, cache, () => []);

    await new Promise<void>((resolve, reject) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () =>
        resolve(),
      );
      server.on("error", reject);
    });
    if (!server) {
      throw new Error("server が起動していない");
    }
    const getFleetEntries = vi.fn((): readonly FleetEntry[] => [
      { name: "medical", path: "/repos/x" },
    ]);
    attachWebSocketServer(server, cache, getFleetEntries);

    expect(getFleetEntries).not.toHaveBeenCalled();

    // アタッチ時点だけでなく、実際に WS 接続を確立した後も呼び出されないことを
    // 確認する（接続確立ハンドラ内で eager に評価するケースの回帰ガード）。
    const address = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { origin: "http://localhost:5173" },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("message", () => resolve());
      ws.once("error", reject);
    });

    expect(getFleetEntries).not.toHaveBeenCalled();
    ws.close();
  });
});

// Issue #122: POST /api/fleet/agents（エージェント追加のオーケストレーション）。
// CLAUDE.md のテスト方針（状態ファイルの読み取りはフィクスチャの実ファイルで検証する）
// を書き込み側にも適用し、実際に一時ディレクトリ・一時 fleet.tsv に対して発行して
// 検証する（モックで済ませない。fleetWatcher のみフェイクに差し替える）。
describe("POST /api/fleet/agents（Issue #122）", () => {
  const ENV_KEY = "FLYWHEEL_FLEET_MANIFEST";
  let originalEnv: string | undefined;
  let tmpDir: string;
  let fleetManifestPath: string;
  let existingAgentPath: string;

  beforeEach(() => {
    originalEnv = process.env[ENV_KEY];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-fleet-agents-test-"));
    existingAgentPath = path.join(tmpDir, "existing-agent");
    fs.mkdirSync(existingAgentPath);
    fleetManifestPath = path.join(tmpDir, "fleet.tsv");
    fs.writeFileSync(
      fleetManifestPath,
      `existing-agent\t${existingAgentPath}\n`,
      "utf-8",
    );
    process.env[ENV_KEY] = fleetManifestPath;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createFakeFleetWatcher(
    overrides?: Partial<FleetWatcher>,
  ): FleetWatcher & { addAgentWatch: ReturnType<typeof vi.fn> } {
    return {
      addAgentWatch: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as FleetWatcher & { addAgentWatch: ReturnType<typeof vi.fn> };
  }

  function buildApp(opts?: {
    fleetWatcher?: FleetWatcher;
    fleetEntries?: FleetEntry[];
    omitDeps?: boolean;
    resolveDeps?: boolean;
  }) {
    const cache = createMemoryBoardCache();
    const app = new Hono();
    const fleetEntries =
      opts?.fleetEntries ??
      ([{ name: "existing-agent", path: existingAgentPath }] as FleetEntry[]);
    const fleetWatcher = opts?.fleetWatcher ?? createFakeFleetWatcher();
    const resolveDeps = opts?.resolveDeps ?? true;
    const deps: FleetAgentAdditionDeps | undefined = opts?.omitDeps
      ? undefined
      : {
          fleetEntries,
          getFleetWatcher: () => (resolveDeps ? fleetWatcher : undefined),
        };
    registerApiRoutes(app, cache, () => fleetEntries, deps);
    return { app, fleetEntries, fleetWatcher, cache };
  }

  function postAgent(
    app: Hono,
    body: unknown,
    headers?: Record<string, string>,
  ) {
    return app.request("/api/fleet/agents", {
      method: "POST",
      headers: {
        host: "localhost",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  it("正常系: 201 でエージェントを返し、ディレクトリ作成・git init・fleet.tsv 追記・監視登録が行われる", async () => {
    const newRepoPath = path.join(tmpDir, "new-agent");
    const { app, fleetEntries, fleetWatcher } = buildApp();

    const res = await postAgent(app, { name: "new-agent", path: newRepoPath });

    expect(res.status).toBe(201);
    const bodyJson = await res.json();
    expect(bodyJson).toEqual({
      agent: { name: "new-agent", path: newRepoPath },
    });

    expect(fs.existsSync(newRepoPath)).toBe(true);
    expect(fs.existsSync(path.join(newRepoPath, ".git"))).toBe(true);

    const manifestContent = fs.readFileSync(fleetManifestPath, "utf-8");
    expect(manifestContent).toContain(`new-agent\t${newRepoPath}`);

    expect(fleetEntries).toEqual([
      { name: "existing-agent", path: existingAgentPath },
      { name: "new-agent", path: newRepoPath },
    ]);

    expect(fleetWatcher.addAgentWatch).toHaveBeenCalledTimes(1);
    expect(fleetWatcher.addAgentWatch).toHaveBeenCalledWith({
      name: "new-agent",
      path: newRepoPath,
    });
  });

  it("name が欠落したリクエストは 400 と構造化エラーを返す（fs には触れない）", async () => {
    const newRepoPath = path.join(tmpDir, "no-name-agent");
    const { app } = buildApp();

    const res = await postAgent(app, { path: newRepoPath });

    expect(res.status).toBe(400);
    const bodyJson = await res.json();
    expect(typeof bodyJson.error).toBe("string");
    expect(fs.existsSync(newRepoPath)).toBe(false);
  });

  it("path が欠落したリクエストは 400 を返す", async () => {
    const { app } = buildApp();

    const res = await postAgent(app, { name: "no-path-agent" });

    expect(res.status).toBe(400);
    const bodyJson = await res.json();
    expect(typeof bodyJson.error).toBe("string");
  });

  it("path が相対パスの場合は 400 を返し、ディレクトリを作成しない", async () => {
    const { app } = buildApp();

    const res = await postAgent(app, {
      name: "relative-path-agent",
      path: "relative/path/to/agent",
    });

    expect(res.status).toBe(400);
    const bodyJson = await res.json();
    expect(bodyJson.error).toMatch(/絶対パス/);
    expect(fs.existsSync(path.join(tmpDir, "relative", "path"))).toBe(false);
  });

  it('name が予約接尾辞 "-shell" の場合は 400 を返し、作成したディレクトリを後始末する', async () => {
    const newRepoPath = path.join(tmpDir, "reserved-suffix-agent");
    const { app, fleetEntries } = buildApp();

    const res = await postAgent(app, {
      name: "foo-shell",
      path: newRepoPath,
    });

    expect(res.status).toBe(400);
    const bodyJson = await res.json();
    expect(bodyJson.error).toMatch(/-shell/);
    expect(fs.existsSync(newRepoPath)).toBe(false);
    expect(fleetEntries).toEqual([
      { name: "existing-agent", path: existingAgentPath },
    ]);
    expect(fs.readFileSync(fleetManifestPath, "utf-8")).not.toContain(
      "foo-shell",
    );
  });

  it("既存 fleet と name が重複する場合は 400 を返し、ディレクトリを作成しない（副作用なし）", async () => {
    const newRepoPath = path.join(tmpDir, "dup-name-agent");
    const { app } = buildApp();

    const res = await postAgent(app, {
      name: "existing-agent",
      path: newRepoPath,
    });

    expect(res.status).toBe(400);
    const bodyJson = await res.json();
    expect(bodyJson.error).toMatch(/existing-agent.*重複/s);
    expect(fs.existsSync(newRepoPath)).toBe(false);
  });

  it("既存 fleet と path が重複する場合は 400 を返し、既存ディレクトリに git init を実行しない（既存エージェントへの影響なし）", async () => {
    const { app } = buildApp();

    const res = await postAgent(app, {
      name: "another-name",
      path: existingAgentPath,
    });

    expect(res.status).toBe(400);
    const bodyJson = await res.json();
    expect(bodyJson.error).toMatch(/重複/);
    expect(fs.existsSync(existingAgentPath)).toBe(true);
    // 既存エージェントのディレクトリに git init が実行されていないこと
    // （まだ git 化されていない既存ディレクトリを、無関係な失敗リクエストの
    // 副作用で書き換えないことの確認）。
    expect(fs.existsSync(path.join(existingAgentPath, ".git"))).toBe(false);
  });

  it("fleet.tsv 側にのみ存在する（in-memory 未反映の）重複 path で appendFleetEntry が失敗した場合も、実行済みの git init をロールバックする", async () => {
    // fleetEntries（in-memory）には無いが、fleet.tsv（ディスク）には既に登録
    // されている既存の未 git 化ディレクトリを path に指定する。事前チェック
    // （in-memory 突合）はすり抜けるため、mkdir（no-op）→ git init が実行された
    // 後、権威側検証である appendFleetEntry のファイル読み込みベースの重複
    // チェックで初めて失敗する。この経路でも git init の後始末が行われることを
    // 確認する（セルフレビュー指摘対応の回帰テスト）。
    const manualAgentPath = path.join(tmpDir, "manual-agent");
    fs.mkdirSync(manualAgentPath);
    fs.appendFileSync(
      fleetManifestPath,
      `manual-agent\t${manualAgentPath}\n`,
      "utf-8",
    );
    // buildApp の既定 fleetEntries は fleet.tsv の内容を反映しない固定配列
    // （既存の existing-agent のみ）のため、manual-agent は in-memory 上は
    // 未知のまま。
    const { app } = buildApp();

    const res = await postAgent(app, {
      name: "manual-agent",
      path: manualAgentPath,
    });

    expect(res.status).toBe(400);
    const bodyJson = await res.json();
    expect(bodyJson.error).toMatch(/重複/);
    expect(fs.existsSync(manualAgentPath)).toBe(true);
    expect(fs.existsSync(path.join(manualAgentPath, ".git"))).toBe(false);
  });

  it("path の前後に空白があっても trim 後に絶対パスと判定され、成功する", async () => {
    const targetPath = path.join(tmpDir, "leading-space-agent");
    const { app } = buildApp();

    const res = await postAgent(app, {
      name: "leading-space-agent",
      path: ` ${targetPath} `,
    });

    expect(res.status).toBe(201);
    const bodyJson = await res.json();
    expect(bodyJson.agent).toEqual({
      name: "leading-space-agent",
      path: targetPath,
    });
  });

  it("末尾改行の無い fleet.tsv へ追記した直後にロールバックしても、直前の行が壊れない（回帰テスト）", async () => {
    // 末尾改行の無い fleet.tsv を用意する。
    fs.writeFileSync(
      fleetManifestPath,
      `existing-agent\t${existingAgentPath}`,
      "utf-8",
    );
    const newRepoPath = path.join(tmpDir, "no-trailing-newline-agent");
    const fleetWatcher = createFakeFleetWatcher({
      addAgentWatch: vi
        .fn()
        .mockRejectedValue(new Error("watcher は close 済みです")),
    });
    const { app } = buildApp({ fleetWatcher });

    const res = await postAgent(app, {
      name: "no-trailing-newline-agent",
      path: newRepoPath,
    });

    expect(res.status).toBe(500);
    const manifestContent = fs.readFileSync(fleetManifestPath, "utf-8");
    expect(manifestContent).not.toContain("no-trailing-newline-agent");
    // ロールバック前に存在した行が、改行の連結崩れなどで壊れていないこと。
    expect(manifestContent).toContain(`existing-agent\t${existingAgentPath}`);
  });

  it("既に存在する（未登録の）ディレクトリを path に指定した場合、成功してもそのディレクトリは削除されない", async () => {
    const preexistingPath = path.join(tmpDir, "preexisting");
    fs.mkdirSync(preexistingPath);
    fs.writeFileSync(path.join(preexistingPath, "keep.txt"), "keep-me");

    const { app } = buildApp();
    const res = await postAgent(app, {
      name: "preexisting-agent",
      path: preexistingPath,
    });

    expect(res.status).toBe(201);
    expect(fs.existsSync(preexistingPath)).toBe(true);
    expect(fs.existsSync(path.join(preexistingPath, "keep.txt"))).toBe(true);
    expect(fs.existsSync(path.join(preexistingPath, ".git"))).toBe(true);
  });

  it("既に git 初期化済みのディレクトリを指定した場合、git init を再実行せず成功する", async () => {
    const gitRepoPath = path.join(tmpDir, "already-git");
    fs.mkdirSync(gitRepoPath);
    fs.mkdirSync(path.join(gitRepoPath, ".git"));
    fs.writeFileSync(path.join(gitRepoPath, ".git", "marker"), "keep-me");

    const { app } = buildApp();
    const res = await postAgent(app, {
      name: "already-git-agent",
      path: gitRepoPath,
    });

    expect(res.status).toBe(201);
    // 既存 .git の中身が変更されていない（git init を再実行してマーカーファイルが
    // 消えていない）ことを確認する。
    expect(fs.existsSync(path.join(gitRepoPath, ".git", "marker"))).toBe(true);
  });

  it("動的監視登録（addAgentWatch）失敗時、作成したディレクトリ・fleet.tsv 追記・fleetEntries 配列をすべて後始末する（500 を返す）", async () => {
    const newRepoPath = path.join(tmpDir, "watch-fail-agent");
    const fleetWatcher = createFakeFleetWatcher({
      addAgentWatch: vi
        .fn()
        .mockRejectedValue(new Error("watcher は close 済みです")),
    });
    const before = fs.readFileSync(fleetManifestPath, "utf-8");
    const { app, fleetEntries } = buildApp({ fleetWatcher });

    const res = await postAgent(app, {
      name: "watch-fail-agent",
      path: newRepoPath,
    });

    expect(res.status).toBe(500);
    const bodyJson = await res.json();
    expect(bodyJson.error).toMatch(/監視登録/);

    expect(fs.existsSync(newRepoPath)).toBe(false);
    expect(fs.readFileSync(fleetManifestPath, "utf-8")).toBe(before);
    expect(fleetEntries).toEqual([
      { name: "existing-agent", path: existingAgentPath },
    ]);
  });

  it("動的監視登録失敗のロールバック中に、別リクエストが追記した行は消さない（内容ベースロールバックの回帰テスト）", async () => {
    const newRepoPath = path.join(tmpDir, "watch-fail-agent");
    const concurrentEntryPath = path.join(tmpDir, "concurrent-agent");
    const fleetWatcher = createFakeFleetWatcher({
      // addAgentWatch 呼び出し中（await で待たされている間）に、別の
      // リクエストが fleet.tsv へ追記を終えた状況を模倣してから失敗する。
      addAgentWatch: vi.fn().mockImplementation(async () => {
        fs.appendFileSync(
          fleetManifestPath,
          `concurrent-agent\t${concurrentEntryPath}\n`,
          "utf-8",
        );
        throw new Error("watcher は close 済みです");
      }),
    });
    const { app, fleetEntries } = buildApp({ fleetWatcher });

    const res = await postAgent(app, {
      name: "watch-fail-agent",
      path: newRepoPath,
    });

    expect(res.status).toBe(500);
    const manifestContent = fs.readFileSync(fleetManifestPath, "utf-8");
    // 自分が追記しようとした行は消えている。
    expect(manifestContent).not.toContain("watch-fail-agent");
    // 割り込んだ別リクエストの行は残っている（バイトオフセット truncate では
    // ここが巻き添えで消えてしまっていた）。
    expect(manifestContent).toContain(
      `concurrent-agent\t${concurrentEntryPath}`,
    );
    expect(manifestContent).toContain(`existing-agent\t${existingAgentPath}`);
    expect(fleetEntries).toEqual([
      { name: "existing-agent", path: existingAgentPath },
    ]);
  });

  it("mkdir 失敗（パス途中に非ディレクトリのファイルが存在する）は 500 を返す", async () => {
    const blockingFilePath = path.join(tmpDir, "not-a-directory");
    fs.writeFileSync(blockingFilePath, "i am a file, not a directory");
    const newRepoPath = path.join(blockingFilePath, "nested-agent");
    const { app, fleetEntries } = buildApp();

    const res = await postAgent(app, {
      name: "nested-agent",
      path: newRepoPath,
    });

    expect(res.status).toBe(500);
    const bodyJson = await res.json();
    expect(bodyJson.error).toMatch(/ディレクトリの作成/);
    expect(fleetEntries).toEqual([
      { name: "existing-agent", path: existingAgentPath },
    ]);
  });

  it('name が予約接尾辞 "-shell" かつ path が未 git 化の既存ディレクトリの場合、400 を返し git init を実行しない', async () => {
    const preexistingPath = path.join(tmpDir, "preexisting-not-git");
    fs.mkdirSync(preexistingPath);

    const { app } = buildApp();
    const res = await postAgent(app, {
      name: "bar-shell",
      path: preexistingPath,
    });

    expect(res.status).toBe(400);
    const bodyJson = await res.json();
    expect(bodyJson.error).toMatch(/-shell/);
    // 事前バリデーション（validateFleetEntryFields の再利用）が mkdir/git init
    // より先に走るため、既存ディレクトリに .git が作られない。
    expect(fs.existsSync(path.join(preexistingPath, ".git"))).toBe(false);
  });

  it("path の前後に空白を含む場合でも、mkdir・fleet.tsv 追記・監視登録がすべて同一の正規化済みパスを使う", async () => {
    const trimmedPath = path.join(tmpDir, "trailing-space-agent");
    const { app, fleetEntries, fleetWatcher } = buildApp();

    const res = await postAgent(app, {
      name: "  trailing-space-agent  ",
      path: `${trimmedPath} `,
    });

    expect(res.status).toBe(201);
    const bodyJson = await res.json();
    expect(bodyJson.agent).toEqual({
      name: "trailing-space-agent",
      path: trimmedPath,
    });
    // 空白付きのパス（例: "…/trailing-space-agent "）が作られていない。
    expect(fs.existsSync(`${trimmedPath} `)).toBe(false);
    expect(fs.existsSync(trimmedPath)).toBe(true);
    const manifestContent = fs.readFileSync(fleetManifestPath, "utf-8");
    expect(manifestContent).toContain(`trailing-space-agent\t${trimmedPath}\n`);
    expect(fleetEntries).toContainEqual({
      name: "trailing-space-agent",
      path: trimmedPath,
    });
    expect(fleetWatcher.addAgentWatch).toHaveBeenCalledWith({
      name: "trailing-space-agent",
      path: trimmedPath,
    });
  });

  it("fleetAgentAdditionDeps 未供給（起動配線されていない）場合は 503 を返す", async () => {
    const { app } = buildApp({ omitDeps: true });

    const res = await postAgent(app, {
      name: "new-agent",
      path: path.join(tmpDir, "new-agent"),
    });

    expect(res.status).toBe(503);
  });

  it("fleetWatcher が未解決（起動シーケンス完了前）の場合は 503 を返す", async () => {
    const { app } = buildApp({ resolveDeps: false });

    const res = await postAgent(app, {
      name: "new-agent",
      path: path.join(tmpDir, "new-agent"),
    });

    expect(res.status).toBe(503);
  });

  it("不正な Host ヘッダの POST リクエストは 403 を返す（既存の Host/Origin 検証を継承）", async () => {
    const { app } = buildApp();

    const res = await postAgent(
      app,
      { name: "new-agent", path: path.join(tmpDir, "new-agent") },
      { host: "evil.example.com" },
    );

    expect(res.status).toBe(403);
  });

  it("追加成功後も既存エージェントの cache 内容には影響しない", async () => {
    const newRepoPath = path.join(tmpDir, "new-agent-no-impact");
    const cache = createMemoryBoardCache();
    cache.replaceAgent({
      name: "existing-agent",
      path: existingAgentPath,
      challenges: [
        { id: "C-1", title: "既存課題", status: "未分類", needsHuman: false },
      ],
      parseErrors: [],
    });
    const app = new Hono();
    const fleetEntries: FleetEntry[] = [
      { name: "existing-agent", path: existingAgentPath },
    ];
    const fleetWatcher = createFakeFleetWatcher();
    const deps: FleetAgentAdditionDeps = {
      fleetEntries,
      getFleetWatcher: () => fleetWatcher,
    };
    registerApiRoutes(app, cache, () => fleetEntries, deps);

    const res = await postAgent(app, {
      name: "new-agent-no-impact",
      path: newRepoPath,
    });

    expect(res.status).toBe(201);
    const existing = cache
      .getSnapshot()
      .agents.find((a) => a.name === "existing-agent");
    expect(existing?.challenges).toEqual([
      { id: "C-1", title: "既存課題", status: "未分類", needsHuman: false },
    ]);
  });
});
