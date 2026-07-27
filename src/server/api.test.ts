import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  attachWebSocketServer,
  isAllowedHost,
  isAllowedOrigin,
  registerApiRoutes,
} from "./api.ts";
import { createMemoryBoardCache } from "./cache.ts";
import type { FleetEntry } from "./manifest.ts";

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

  it("検証・stat 通過後に読み取りが失敗する場合（権限無し等）も 404 を返す（500 で存在有無を漏らさない）", async () => {
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
  });

  it("検証通過後の読み取り失敗はクライアントへ 404 を返しつつ console.warn で記録する（運用時の切り分けのため。設定ミス等を「.md が読めない」と見分けられなくしないという動機は tree.ts の repo ルート走査失敗記録と同じだが、tree.ts の非ルート走査失敗の黙殺方針をそのまま踏襲したものではない）", async () => {
    const unreadablePath = path.join(repoRoot, "unreadable-logged.md");
    fs.writeFileSync(unreadablePath, "# secret");
    fs.chmodSync(unreadablePath, 0o000);
    const app = buildAppWithRepo();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await app.request("/api/md/file?repo=myrepo&path=unreadable-logged.md", {
        headers: { host: "localhost" },
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      fs.chmodSync(unreadablePath, 0o644);
      warnSpy.mockRestore();
    }
  });

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
