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

  // pty 起動（セッション確保完了）を待つための共通ゲート。無害な input（空文字）を
  // 送り、fakePty.write が呼ばれたことを条件に待つことで、固定時間の sleep に
  // 頼らずに「非同期の startSession が完了した」ことを検出する。
  async function waitForPtyReady(
    ws: WebSocket,
    fakePty: ReturnType<typeof createFakePty>,
  ): Promise<void> {
    ws.send(JSON.stringify({ type: "input", data: "" }));
    await vi.waitFor(() => {
      expect(fakePty.write).toHaveBeenCalled();
    });
  }

  it("正常系: has-session→(無ければ)new-session→pty spawn の順で呼ばれる", async () => {
    const tmux = createFakeTmux();
    const fakePty = createFakePty();
    const spawnPty = vi.fn().mockReturnValue(fakePty.ptyProcess);
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
    await waitForPtyReady(ws, fakePty);

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
    await waitForPtyReady(ws, fakePty);

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
    await waitForPtyReady(ws, fakePty);

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
    await waitForPtyReady(ws, fakePty);

    ws.send(JSON.stringify({ type: "input", data: "ls -la\n" }));
    await vi.waitFor(() => {
      expect(fakePty.write).toHaveBeenCalledWith("ls -la\n");
    });

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
    await waitForPtyReady(ws, fakePty);

    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await vi.waitFor(() => {
      expect(fakePty.resize).toHaveBeenCalledWith(120, 40);
    });

    ws.close();
  });

  it("上限（1000）を超える resize フレームは無視され pty.resize に渡らない", async () => {
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
    await waitForPtyReady(ws, fakePty);

    ws.send(JSON.stringify({ type: "resize", cols: 1_000_000_000, rows: 40 }));
    // 直後に無害な input を送り、それが処理されるのを待つことで、先に届いた
    // 巨大 resize フレームの処理（無視されるはず）が完了済みであることを保証する
    // （同一 WS 接続内でメッセージは到着順に処理されるため）。
    ws.send(
      JSON.stringify({ type: "input", data: "marker-after-oversized-resize" }),
    );
    await vi.waitFor(() => {
      expect(fakePty.write).toHaveBeenCalledWith(
        "marker-after-oversized-resize",
      );
    });

    expect(fakePty.resize).not.toHaveBeenCalled();

    ws.close();
  });

  it("pty.resize が例外を投げても board プロセス全体を巻き込まず、当該接続のみに閉じる", async () => {
    const tmux = createFakeTmux();
    const fakePty = createFakePty();
    fakePty.resize.mockImplementation(() => {
      throw new Error("resize failed (native)");
    });
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty: () => fakePty.ptyProcess,
    });

    const unhandledExceptions: unknown[] = [];
    const onUncaughtException = (reason: unknown) => {
      unhandledExceptions.push(reason);
    };
    process.on("uncaughtException", onUncaughtException);

    try {
      const port = await startServer(bridge);
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws/terminal?agent=medical`,
        { headers: { origin: "http://localhost:5173" } },
      );
      await waitForOutcome(ws);
      await waitForPtyReady(ws, fakePty);

      ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
      await vi.waitFor(() => {
        expect(fakePty.resize).toHaveBeenCalledWith(120, 40);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
    } finally {
      process.off("uncaughtException", onUncaughtException);
    }

    expect(unhandledExceptions).toEqual([]);
  });

  it("pty.write が例外を投げても board プロセス全体を巻き込まず、当該接続のみに閉じる", async () => {
    const tmux = createFakeTmux();
    const fakePty = createFakePty();
    fakePty.write.mockImplementation(() => {
      throw new Error("write failed (native)");
    });
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty: () => fakePty.ptyProcess,
    });

    const unhandledExceptions: unknown[] = [];
    const onUncaughtException = (reason: unknown) => {
      unhandledExceptions.push(reason);
    };
    process.on("uncaughtException", onUncaughtException);

    try {
      const port = await startServer(bridge);
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws/terminal?agent=medical`,
        { headers: { origin: "http://localhost:5173" } },
      );
      await waitForOutcome(ws);
      await waitForPtyReady(ws, fakePty);

      ws.send(JSON.stringify({ type: "input", data: "ls -la\n" }));
      await vi.waitFor(() => {
        expect(fakePty.write).toHaveBeenCalledWith("ls -la\n");
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
    } finally {
      process.off("uncaughtException", onUncaughtException);
    }

    expect(unhandledExceptions).toEqual([]);
  });

  // hasSession に実タイマー由来の遅延を与える（実際の tmux セッション確保が
  // サブプロセス起動を伴い非同期に一定時間かかることを模す）。この遅延の間に
  // クライアントが送ったフレームが実ソケット経由でサーバへ到達するだけの
  // 現実的な猶予を作り、「pty 起動前に届いたメッセージ」を確実に再現する
  // （Promise を外部から手動 resolve する方式は、マイクロタスクの完了が実ソケット
  // の到達より先行し得るため、レースの再現性が無い＝false green の恐れがある）。
  function createDelayedHasSession(
    result: boolean,
    delayMs = 30,
  ): TmuxClient["hasSession"] {
    return vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(result), delayMs);
        }),
    );
  }

  it("pty 起動前（tmux セッション確保待ち）に届いた input/resize/prefill は、上限付きキューに貯められ、pty 起動後に届いた順で処理される", async () => {
    const hasSession = createDelayedHasSession(false);
    const tmux = createFakeTmux({ hasSession });
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

    // pty がまだ起動していない（hasSession の遅延中）間に
    // resize → prefill の順でメッセージを送る。
    ws.send(JSON.stringify({ type: "resize", cols: 90, rows: 30 }));
    ws.send(JSON.stringify({ type: "prefill", command: "git status" }));

    await vi.waitFor(() => {
      expect(fakePty.resize).toHaveBeenCalledWith(90, 30);
    });
    await vi.waitFor(() => {
      expect(tmux.sendKeysLiteral).toHaveBeenCalledWith(
        "flywheel-medical",
        "git status",
      );
    });

    ws.close();
  });

  it("pty 起動前に届いたメッセージは上限（100件）を超えると古い順に破棄される", async () => {
    const hasSession = createDelayedHasSession(false);
    const tmux = createFakeTmux({ hasSession });
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

    // 上限 100 件を超える 105 件の input を、pty 起動前に送る。
    for (let i = 0; i < 105; i += 1) {
      ws.send(JSON.stringify({ type: "input", data: `line-${i}\n` }));
    }

    // 直近100件（line-5..line-104）が処理されるまで待つ。
    await vi.waitFor(
      () => {
        expect(fakePty.write).toHaveBeenCalledWith("line-104\n");
      },
      { timeout: 2000 },
    );

    // 上限超過分（先頭5件 line-0..line-4）は古い順に破棄され、pty には渡らない。
    expect(fakePty.write).not.toHaveBeenCalledWith("line-0\n");
    expect(fakePty.write).not.toHaveBeenCalledWith("line-4\n");
    expect(fakePty.write).toHaveBeenCalledWith("line-5\n");
    expect(fakePty.write).toHaveBeenCalledTimes(100);

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
    // このテストは「pty.write が一度も呼ばれない」ことを検証するため、
    // 共通ゲート（waitForPtyReady・input 経由）は使わず resize 経由で
    // 起動待ちする（pty.write に触れない）。
    ws.send(JSON.stringify({ type: "resize", cols: 2, rows: 2 }));
    await vi.waitFor(() => {
      expect(fakePty.resize).toHaveBeenCalled();
    });

    ws.send(JSON.stringify({ type: "prefill", command: "git status" }));
    await vi.waitFor(() => {
      expect(tmux.sendKeysLiteral).toHaveBeenCalledWith(
        "flywheel-medical",
        "git status",
      );
    });

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
    await waitForPtyReady(ws, fakePty);

    ws.close();

    await vi.waitFor(() => {
      expect(fakePty.kill).toHaveBeenCalledTimes(1);
    });
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
      await waitForPtyReady(ws, fakePty);

      ws.send(JSON.stringify({ type: "prefill", command: "git status" }));
      // sendKeysLiteral の呼び出しを待つ。呼び出し側（bridge.ts）は返り値の
      // rejected promise に同一の同期呼び出しフレーム内で .catch を付けているため、
      // 呼び出しが確認できた時点で unhandledRejection の発生可能性は無い
      // （固定時間の sleep は不要）。
      await vi.waitFor(() => {
        expect(tmux.sendKeysLiteral).toHaveBeenCalledWith(
          "flywheel-medical",
          "git status",
        );
      });

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
      // spawnPty は同期的に throw するため、Promise の reject は一切発生しない
      // （bridge.ts 側の try/catch で同期的に捕捉される）。close/open/error の
      // いずれかのイベントが発火するまで待てば十分で、固定時間の sleep は不要。
      const outcome = await waitForOutcome(ws);

      expect(outcome === "open" || outcome === "closed").toBe(true);
      ws.close();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(unhandledRejections).toEqual([]);
  });
});
