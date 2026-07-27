import type { AddressInfo } from "node:net";
import * as net from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
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

// Issue #62: md 系エンドポイント（別チケット）の受け皿として、fleet entries を
// 遅延参照できる getFleetEntries コールバックを registerApiRoutes に供給できることを
// 確認する。md エンドポイント自体はまだ存在せず、この関数の本体はまだ getFleetEntries
// を一切参照しないため、ここで検証できるのは以下の2点に限られる（「受け手に渡した値が
// 実際に使われる」ところまではこのチケットの範囲では検証できない。それは最初の md
// エンドポイントを追加するチケット側で担保する）。
// (1) 第3引数を渡しても既存エンドポイントの挙動に回帰が無いこと（後方互換）
// (2) ルート登録処理自体は getFleetEntries を呼び出さない（今後 md ハンドラを
//     この関数内に追加する際、登録時点での eager 評価を持ち込まないための回帰ガード）
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
