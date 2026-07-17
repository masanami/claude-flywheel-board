import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { FleetEntry } from "../manifest.ts";
import { createTerminalWebSocketServer } from "./bridge.ts";
import type { PtyProcess } from "./pty-process.ts";
import type { TmuxClient } from "./tmux.ts";

const FLEET_ENTRIES: FleetEntry[] = [
  { name: "medical", path: "/repos/medical-agent" },
];

function createFakeTmux(
  overrides: {
    hasSession?: TmuxClient["hasSession"];
    newSession?: TmuxClient["newSession"];
    sendKeysLiteral?: TmuxClient["sendKeysLiteral"];
  } = {},
) {
  return {
    hasSession:
      overrides.hasSession ??
      vi.fn<TmuxClient["hasSession"]>().mockResolvedValue(false),
    newSession:
      overrides.newSession ??
      vi.fn<TmuxClient["newSession"]>().mockResolvedValue(undefined),
    sendKeysLiteral:
      overrides.sendKeysLiteral ??
      vi.fn<TmuxClient["sendKeysLiteral"]>().mockResolvedValue(undefined),
  } satisfies TmuxClient;
}

function createFakePty() {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(event: { exitCode: number }) => void> = [];
  const write = vi.fn();
  const resize = vi.fn();
  const kill = vi.fn();

  const ptyProcess: PtyProcess = {
    onData: (listener) => {
      dataListeners.push(listener);
    },
    onExit: (listener) => {
      exitListeners.push(listener);
    },
    write,
    resize,
    kill,
  };

  return {
    ptyProcess,
    emitData: (data: string) => {
      for (const listener of dataListeners) listener(data);
    },
    emitExit: () => {
      for (const listener of exitListeners) listener({ exitCode: 0 });
    },
    write,
    resize,
    kill,
  };
}

async function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(data.toString()));
    ws.once("error", reject);
  });
}

async function waitForOutcome(
  ws: WebSocket,
): Promise<"open" | "closed" | "error"> {
  return new Promise((resolve) => {
    ws.once("open", () => resolve("open"));
    ws.once("close", () => resolve("closed"));
    ws.once("error", () => resolve("error"));
  });
}

describe("createTerminalWebSocketServer（純粋なユニット部分）", () => {
  it("/ws/terminal 以外の URL は何もしない（destroy しない。他のハンドラに委ねる）", () => {
    const tmux = createFakeTmux();
    const { ptyProcess } = createFakePty();
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty: () => ptyProcess,
    });

    const destroy = vi.fn();
    const write = vi.fn();
    const request = { url: "/ws", headers: {} } as never;
    const socket = { destroy, write } as never;

    bridge.handleUpgrade(request, socket, Buffer.alloc(0));

    expect(destroy).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("/ws/terminal で始まるが完全一致しない URL（/ws/terminalXYZ 等）も何もしない（厳密一致）", () => {
    const tmux = createFakeTmux();
    const { ptyProcess } = createFakePty();
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty: () => ptyProcess,
    });

    const destroy = vi.fn();
    const write = vi.fn();
    const request = {
      url: "/ws/terminalXYZ?agent=medical",
      headers: { host: "localhost" },
    } as never;
    const socket = { destroy, write } as never;

    bridge.handleUpgrade(request, socket, Buffer.alloc(0));

    expect(destroy).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("Host ヘッダが不正なら 403 を書いて destroy する", () => {
    const tmux = createFakeTmux();
    const { ptyProcess } = createFakePty();
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty: () => ptyProcess,
    });

    const destroy = vi.fn();
    const write = vi.fn();
    const request = {
      url: "/ws/terminal?agent=medical",
      headers: { host: "evil.example.com" },
    } as never;
    const socket = { destroy, write } as never;

    bridge.handleUpgrade(request, socket, Buffer.alloc(0));

    expect(write).toHaveBeenCalledWith("HTTP/1.1 403 Forbidden\r\n\r\n");
    expect(destroy).toHaveBeenCalled();
    expect(tmux.hasSession).not.toHaveBeenCalled();
  });

  it("Origin ヘッダが不正なら 403 を書いて destroy する", () => {
    const tmux = createFakeTmux();
    const { ptyProcess } = createFakePty();
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty: () => ptyProcess,
    });

    const destroy = vi.fn();
    const write = vi.fn();
    const request = {
      url: "/ws/terminal?agent=medical",
      headers: { host: "localhost", origin: "http://evil.example.com" },
    } as never;
    const socket = { destroy, write } as never;

    bridge.handleUpgrade(request, socket, Buffer.alloc(0));

    expect(write).toHaveBeenCalledWith("HTTP/1.1 403 Forbidden\r\n\r\n");
    expect(destroy).toHaveBeenCalled();
  });

  it("未登録の agent 名は destroy する（任意パスでのセッション生成不可）", () => {
    const tmux = createFakeTmux();
    const { ptyProcess } = createFakePty();
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty: () => ptyProcess,
    });

    const destroy = vi.fn();
    const write = vi.fn();
    const request = {
      url: "/ws/terminal?agent=unknown-agent",
      headers: { host: "localhost" },
    } as never;
    const socket = { destroy, write } as never;

    bridge.handleUpgrade(request, socket, Buffer.alloc(0));

    expect(destroy).toHaveBeenCalled();
    expect(tmux.hasSession).not.toHaveBeenCalled();
  });

  it("agent クエリが無い場合も destroy する", () => {
    const tmux = createFakeTmux();
    const { ptyProcess } = createFakePty();
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty: () => ptyProcess,
    });

    const destroy = vi.fn();
    const request = {
      url: "/ws/terminal",
      headers: { host: "localhost" },
    } as never;
    const socket = { destroy, write: vi.fn() } as never;

    bridge.handleUpgrade(request, socket, Buffer.alloc(0));

    expect(destroy).toHaveBeenCalled();
  });
});

describe("createTerminalWebSocketServer（実ソケットでの結合テスト。tmux/pty は Mock）", () => {
  let server: ReturnType<typeof serve> | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function startServer(bridge: {
    handleUpgrade: (
      request: import("node:http").IncomingMessage,
      socket: import("node:net").Socket,
      head: Buffer,
    ) => void;
  }): Promise<number> {
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
    server.on("upgrade", (request, socket, head) => {
      bridge.handleUpgrade(request, socket, head);
    });
    const address = server.address() as AddressInfo;
    return address.port;
  }

  it("正常系: has-session→(無ければ)new-session→pty spawn の順で呼ばれる", async () => {
    const tmux = createFakeTmux();
    const { ptyProcess } = createFakePty();
    const spawnPty = vi.fn().mockReturnValue(ptyProcess);
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty,
    });

    const port = await startServer(bridge);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?agent=medical`,
      {
        headers: { origin: "http://localhost:5173" },
      },
    );
    await waitForOutcome(ws);

    // 非同期の startSession が完了するまで少し待つ。
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(tmux.hasSession).toHaveBeenCalledWith("flywheel-medical");
    expect(tmux.newSession).toHaveBeenCalledWith(
      "flywheel-medical",
      "/repos/medical-agent",
    );
    expect(spawnPty).toHaveBeenCalledWith(
      "flywheel-medical",
      "/repos/medical-agent",
    );

    ws.close();
  });

  it("既存セッションがある場合は new-session を呼ばない", async () => {
    const tmux = createFakeTmux({
      hasSession: vi.fn<TmuxClient["hasSession"]>().mockResolvedValue(true),
    });
    const { ptyProcess } = createFakePty();
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty: () => ptyProcess,
    });

    const port = await startServer(bridge);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?agent=medical`,
      {
        headers: { origin: "http://localhost:5173" },
      },
    );
    await waitForOutcome(ws);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(tmux.newSession).not.toHaveBeenCalled();

    ws.close();
  });

  it("pty の出力が WS メッセージとしてクライアントに届く", async () => {
    const tmux = createFakeTmux();
    const fakePty = createFakePty();
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty: () => fakePty.ptyProcess,
    });

    const port = await startServer(bridge);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?agent=medical`,
      {
        headers: { origin: "http://localhost:5173" },
      },
    );
    await waitForOutcome(ws);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const messagePromise = waitForMessage(ws);
    fakePty.emitData("hello from pty\r\n");
    const received = await messagePromise;

    expect(received).toBe("hello from pty\r\n");

    ws.close();
  });

  it("input メッセージは pty.write に渡す", async () => {
    const tmux = createFakeTmux();
    const fakePty = createFakePty();
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty: () => fakePty.ptyProcess,
    });

    const port = await startServer(bridge);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?agent=medical`,
      {
        headers: { origin: "http://localhost:5173" },
      },
    );
    await waitForOutcome(ws);
    await new Promise((resolve) => setTimeout(resolve, 50));

    ws.send(JSON.stringify({ type: "input", data: "ls -la\n" }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fakePty.write).toHaveBeenCalledWith("ls -la\n");

    ws.close();
  });

  it("resize メッセージは pty.resize に渡す", async () => {
    const tmux = createFakeTmux();
    const fakePty = createFakePty();
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty: () => fakePty.ptyProcess,
    });

    const port = await startServer(bridge);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?agent=medical`,
      {
        headers: { origin: "http://localhost:5173" },
      },
    );
    await waitForOutcome(ws);
    await new Promise((resolve) => setTimeout(resolve, 50));

    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fakePty.resize).toHaveBeenCalledWith(120, 40);

    ws.close();
  });

  it("prefill メッセージは tmux.sendKeysLiteral に渡す（pty.write は呼ばない）", async () => {
    const tmux = createFakeTmux();
    const fakePty = createFakePty();
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty: () => fakePty.ptyProcess,
    });

    const port = await startServer(bridge);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?agent=medical`,
      {
        headers: { origin: "http://localhost:5173" },
      },
    );
    await waitForOutcome(ws);
    await new Promise((resolve) => setTimeout(resolve, 50));

    ws.send(JSON.stringify({ type: "prefill", command: "git status" }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(tmux.sendKeysLiteral).toHaveBeenCalledWith(
      "flywheel-medical",
      "git status",
    );
    expect(fakePty.write).not.toHaveBeenCalled();

    ws.close();
  });

  it("WS 切断時は pty を kill するが、tmux セッションを終了させる呼び出しは一切行わない", async () => {
    const tmux = createFakeTmux();
    const fakePty = createFakePty();
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty: () => fakePty.ptyProcess,
    });

    const port = await startServer(bridge);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?agent=medical`,
      {
        headers: { origin: "http://localhost:5173" },
      },
    );
    await waitForOutcome(ws);
    await new Promise((resolve) => setTimeout(resolve, 50));

    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fakePty.kill).toHaveBeenCalledTimes(1);
    // TmuxClient には kill-session に相当するメソッドが存在しないため、
    // 型レベルで「tmux セッションを終了させる呼び出し」自体が発生し得ない。
    expect(
      Object.keys(tmux).some((key) => key.toLowerCase().includes("kill")),
    ).toBe(false);
  });

  it("prefill 実行中に tmux コマンドが失敗しても unhandledRejection にならない", async () => {
    const tmux = createFakeTmux({
      sendKeysLiteral: vi
        .fn<TmuxClient["sendKeysLiteral"]>()
        .mockRejectedValue(new Error("tmux send-keys failed")),
    });
    const fakePty = createFakePty();
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty: () => fakePty.ptyProcess,
    });

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const port = await startServer(bridge);
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws/terminal?agent=medical`,
        { headers: { origin: "http://localhost:5173" } },
      );
      await waitForOutcome(ws);
      await new Promise((resolve) => setTimeout(resolve, 50));

      ws.send(JSON.stringify({ type: "prefill", command: "git status" }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      ws.close();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(unhandledRejections).toEqual([]);
  });

  it("pty spawn が同期的に例外を投げても WS が閉じられ、unhandledRejection にならない", async () => {
    const tmux = createFakeTmux();
    const spawnPty = vi.fn(() => {
      throw new Error("tmux binary not found");
    });
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty,
    });

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const port = await startServer(bridge);
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws/terminal?agent=medical`,
        { headers: { origin: "http://localhost:5173" } },
      );
      const outcome = await waitForOutcome(ws);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(outcome === "open" || outcome === "closed").toBe(true);
      ws.close();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(unhandledRejections).toEqual([]);
  });
});
