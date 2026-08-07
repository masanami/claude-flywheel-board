import type { AddressInfo } from "node:net";
import * as net from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { attachWebSocketServer } from "./api.ts";
import { createMemoryBoardCache } from "./cache.ts";
import {
  LISTEN_HOSTNAME,
  attachTerminalUpgradeRouting,
  createApp,
  getServeOptions,
} from "./index.ts";
import type { FleetEntry } from "./manifest.ts";
import { createTerminalWebSocketServer } from "./pty/bridge.ts";

describe("getServeOptions", () => {
  it("常に 127.0.0.1 を hostname として返す", () => {
    const options = getServeOptions();

    expect(options.hostname).toBe("127.0.0.1");
    expect(LISTEN_HOSTNAME).toBe("127.0.0.1");
  });

  it("port を指定してもホストは 127.0.0.1 のまま変わらない", () => {
    const options = getServeOptions(0);

    expect(options.port).toBe(0);
    expect(options.hostname).toBe("127.0.0.1");
  });
});

describe("server smoke test", () => {
  let server: ReturnType<typeof serve> | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("127.0.0.1 に実際に bind し、リクエストへ応答する", async () => {
    // port: 0 で OS に空きポートを割り当てさせ、実際に listen する。
    await new Promise<void>((resolve, reject) => {
      server = serve(getServeOptions(0), (info) => {
        expect(info.address).toBe("127.0.0.1");
        resolve();
      });
      server.on("error", reject);
    });

    const address = server?.address();
    if (!address || typeof address === "string") {
      throw new Error("server address が取得できない");
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/does-not-exist`,
    );
    // 静的ファイルが無いので 404 だが、127.0.0.1 で応答が返ってくること自体を確認する。
    expect(response.status).toBe(404);
  });
});

describe("createApp", () => {
  it("Hono アプリを構築できる", () => {
    const app = createApp();
    expect(app.fetch).toBeTypeOf("function");
  });
});

// Issue #62: md 系エンドポイント（別チケット）はすべて manifest から repo ルートを
// 解決するため、createApp / getServeOptions が getFleetEntries コールバックを
// registerApiRoutes まで供給できることを確認する（既存呼び出し元は省略可能な
// ままであることが後方互換の条件）。registerApiRoutes の本体はまだ getFleetEntries
// を参照しないため、ここで検証できるのは「後方互換」と「構築時に eager 評価しない
// こと」までであり、「渡した値が実際に消費される」ことの検証は最初の md エンドポイント
// を追加するチケット側の責務とする。
describe("createApp / getServeOptions の getFleetEntries 供給経路（Issue #62）", () => {
  it("getFleetEntries を渡しても既存の fetch 挙動（404）は変わらない（後方互換）", async () => {
    const cache = createMemoryBoardCache();
    const getFleetEntries = (): readonly FleetEntry[] => [
      { name: "medical", path: "/repos/medical-agent" },
    ];

    const app = createApp(cache, getFleetEntries);
    const res = await app.request("/does-not-exist");

    expect(res.status).toBe(404);
  });

  it("createApp 構築処理自体は getFleetEntries を呼び出さない（eager 評価の回帰ガード）", () => {
    const cache = createMemoryBoardCache();
    const getFleetEntries = vi.fn((): readonly FleetEntry[] => [
      { name: "medical", path: "/repos/x" },
    ]);

    createApp(cache, getFleetEntries);

    expect(getFleetEntries).not.toHaveBeenCalled();
  });

  it("getServeOptions に getFleetEntries を渡しても hostname/port は変わらない", () => {
    const cache = createMemoryBoardCache();
    const getFleetEntries = (): readonly FleetEntry[] => [];

    const options = getServeOptions(0, cache, getFleetEntries);

    expect(options.hostname).toBe("127.0.0.1");
    expect(options.port).toBe(0);
  });

  it("getServeOptions 経由でも GET /api/board が動作する（登録経路の疎通確認）", async () => {
    const cache = createMemoryBoardCache();
    cache.replaceAgent({
      name: "medical",
      path: "/agents/medical-agent",
      challenges: [],
      parseErrors: [],
    });
    const getFleetEntries = (): readonly FleetEntry[] => [
      { name: "medical", path: "/repos/medical-agent" },
    ];

    const options = getServeOptions(0, cache, getFleetEntries);
    const res = await options.fetch(
      new Request("http://127.0.0.1/api/board", {
        headers: { host: "localhost" },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents[0].name).toBe("medical");
  });
});

describe("attachTerminalUpgradeRouting（/ws と /ws/terminal の共存）", () => {
  let server: ReturnType<typeof serve> | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function startServerWithBothRoutes(): Promise<number> {
    const cache = createMemoryBoardCache();
    await new Promise<void>((resolve, reject) => {
      server = serve(
        {
          fetch: () => new Response("not found", { status: 404 }),
          hostname: "127.0.0.1",
          port: 0,
        },
        () => resolve(),
      );
      server.on("error", reject);
    });
    if (!server) throw new Error("server が起動していない");

    attachWebSocketServer(server, cache, () => []);
    const terminalWebSocketServer = createTerminalWebSocketServer({
      getFleetEntries: () => [
        { name: "medical", path: "/repos/medical-agent" },
      ],
      tmux: {
        hasSession: vi.fn().mockResolvedValue(true),
        newSession: vi.fn().mockResolvedValue(undefined),
        sendKeysLiteral: vi.fn().mockResolvedValue(undefined),
      },
      spawnPty: vi.fn().mockReturnValue({
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      }),
    });
    attachTerminalUpgradeRouting(server, terminalWebSocketServer);

    const address = server.address() as AddressInfo;
    return address.port;
  }

  it("既存の /ws への接続は引き続き snapshot を受信できる", async () => {
    const port = await startServerWithBothRoutes();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: "http://localhost:5173" },
    });
    const message = await new Promise<string>((resolve, reject) => {
      ws.once("message", (data) => resolve(data.toString()));
      ws.once("error", reject);
    });

    expect(JSON.parse(message).type).toBe("snapshot");
    ws.close();
  });

  it("/ws/terminal?agent=<登録名> への接続は確立できる", async () => {
    const port = await startServerWithBothRoutes();

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?agent=medical`,
      { headers: { origin: "http://localhost:5173" } },
    );
    const result = await new Promise<"open" | "closed" | "error">((resolve) => {
      ws.once("open", () => resolve("open"));
      ws.once("close", () => resolve("closed"));
      ws.once("error", () => resolve("error"));
    });

    expect(result).toBe("open");
    ws.close();
  });

  it("/ws でも /ws/terminal でもない upgrade リクエストは destroy される", async () => {
    const port = await startServerWithBothRoutes();

    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });

    const closed = await new Promise<boolean>((resolve) => {
      socket.once("close", () => resolve(true));
      socket.write(
        [
          "GET /not-a-known-path HTTP/1.1",
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

    expect(closed).toBe(true);
    socket.destroy();
  });
});

// addFleetEntry（Issue #121）のテストは fleet-agent-addition.test.ts へ移設した
// （Issue #122 セルフレビュー指摘対応: 実装が fleet-agent-addition.ts へ切り出され
// たのに合わせ、ファイル名とテスト対象の対応を保つため）。
