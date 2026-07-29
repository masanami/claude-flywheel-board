import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

// Issue #67 セルフレビュー指摘対応: 「WS 切断（close）でも該当クライアントを
// 集合から除去する」という完了条件は、attachWebSocketServer 側の
// `ws.on("close", () => mdWatchRegistry.unsubscribeClient(ws))` という配線
// そのものが正しく効いていることを検証しなければ担保できない。api.test.ts の
// 実 chokidar 統合テストは「クラッシュしないこと」しか確認できず（broadcast は
// readyState === OPEN のクライアントのみへ送るため、配線が無くても常に
// 例外は起きない）、close ハンドラを削除しても green のままになりうる。
//
// ここでは "./md/watch.ts" をこのファイル単位でモックし（watcher.chokidar.test.ts
// が chokidar をファイル単位でモックするのと同じ手法）、attachWebSocketServer が
// 生成したレジストリの unsubscribeClient / subscribe が実際にどう呼ばれるかを
// 直接検証する。

const unsubscribeClient = vi.fn();
const subscribe = vi.fn();
const closeAll = vi.fn().mockResolvedValue(undefined);
const handleMdClientMessage = vi.fn();

vi.mock("./md/watch.ts", () => ({
  createMdWatchRegistry: vi.fn(() => ({
    subscribe,
    unsubscribeClient,
    closeAll,
  })),
  handleMdClientMessage,
}));

const { attachWebSocketServer, registerApiRoutes } = await import("./api.ts");
const { createMemoryBoardCache } = await import("./cache.ts");

describe("attachWebSocketServer と md watch レジストリの配線（Issue #67）", () => {
  let server: ReturnType<typeof serve> | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
    unsubscribeClient.mockClear();
    subscribe.mockClear();
    closeAll.mockClear();
    handleMdClientMessage.mockClear();
  });

  async function startServer(): Promise<ServerAddress> {
    const cache = createMemoryBoardCache();
    const app = new Hono();
    registerApiRoutes(app, cache, () => []);

    await new Promise<void>((resolve, reject) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () =>
        resolve(),
      );
      server?.on("error", reject);
    });
    if (!server) {
      throw new Error("server が起動していない");
    }
    attachWebSocketServer(server, cache, () => []);
    return server.address() as AddressInfo;
  }

  type ServerAddress = AddressInfo;

  it("WS close イベントで mdWatchRegistry.unsubscribeClient(ws) が呼ばれる（配線の回帰確認）", async () => {
    const address = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { origin: "http://localhost:5173" },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("message", () => resolve());
      ws.once("error", reject);
    });

    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
    // クライアント側の close イベントはサーバ側ハンドラの完了を保証しない
    // ため、ひと呼吸置いてからサーバ側の呼び出しを確認する。
    await vi.waitFor(() => {
      expect(unsubscribeClient).toHaveBeenCalledTimes(1);
    });
  });

  it("WS message イベント受信時、handleMdClientMessage(registry, ws, 生データ) が呼ばれる（配線の回帰確認）", async () => {
    const address = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { origin: "http://localhost:5173" },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("message", () => resolve());
      ws.once("error", reject);
    });

    const rawMessage = JSON.stringify({
      type: "md_subscribe",
      repo: "myrepo",
      path: "doc.md",
    });
    ws.send(rawMessage);

    // セルフレビュー指摘対応: 「送信が throw しない」だけでは
    // ws.on("message", ...) 自体を削除しても green のままになってしまう
    // ため、実際に handleMdClientMessage が期待どおりの引数（レジストリ・
    // 生の JSON 文字列）で呼ばれたことを直接 assert する。
    await vi.waitFor(() => {
      expect(handleMdClientMessage).toHaveBeenCalledWith(
        expect.objectContaining({ subscribe, unsubscribeClient }),
        expect.anything(),
        rawMessage,
      );
    });

    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
  });

  // セルフレビュー指摘対応: ws.on("close", ...) の配線テストは実 TCP 接続を
  // close することで検証できるが、close を伴わない異常切断（'error' のみ発火する
  // ケース）は実ネットワーク越しに再現するのが難しい。代わりに attachWebSocketServer
  // が返す wss（BoardWebSocketServer.wss）へ、EventEmitter ベースの偽 ws を
  // 直接 "connection" として emit することで、実際に登録された
  // ws.on("error", ...) ハンドラそのものを検証する（HTTP サーバも実ネットワークも
  // 経由しない分、高速かつ決定的）。
  class FakeConnectionWs extends EventEmitter {
    readyState = 1; // WebSocket.OPEN 相当
    send = vi.fn();
  }

  it("WS error イベントで mdWatchRegistry.unsubscribeClient(ws) が呼ばれる（配線の回帰確認）", async () => {
    const { createMemoryBoardCache } = await import("./cache.ts");
    const cache = createMemoryBoardCache();
    const fakeServer = new EventEmitter();
    const { wss } = attachWebSocketServer(fakeServer as never, cache, () => []);

    const fakeWs = new FakeConnectionWs();
    wss.emit("connection", fakeWs, {});
    fakeWs.emit("error", new Error("boom"));

    expect(unsubscribeClient).toHaveBeenCalledWith(fakeWs);
  });

  it("closeMdWatches() を呼ぶと mdWatchRegistry.closeAll() が呼ばれる（配線の回帰確認）", async () => {
    const { createMemoryBoardCache } = await import("./cache.ts");
    const cache = createMemoryBoardCache();
    const fakeServer = new EventEmitter();
    const { closeMdWatches } = attachWebSocketServer(
      fakeServer as never,
      cache,
      () => [],
    );

    await closeMdWatches();

    expect(closeAll).toHaveBeenCalledTimes(1);
  });
});
