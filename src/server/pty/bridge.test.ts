import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { FleetEntry } from "../manifest.ts";
import { createTerminalWebSocketServer } from "./bridge.ts";
import type { PtyProcess } from "./pty-process.ts";
import type { TmuxClient } from "./tmux.ts";

const MEDICAL_ENTRY: FleetEntry = {
  name: "medical",
  path: "/repos/medical-agent",
};
const FLEET_ENTRIES: FleetEntry[] = [MEDICAL_ENTRY];

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

/** 手動 resolve できる Promise。deferred な hasSession を組み立てるために使う。 */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * 実ソケットを介さず bridge 内部の "connection" ハンドラを直接駆動するための
 * fake WebSocket。message の投入・close を呼び出し側から同期的に制御できるため、
 * 「pty 起動前キューイング」のテストで、固定時間の sleep や実ソケット到達の
 * タイミングに依存しない決定的な検証ができる。
 */
function createFakeWebSocket(): {
  ws: WebSocket;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emitMessage: (raw: string) => void;
} {
  const emitter = new EventEmitter();
  let readyState: number = WebSocket.OPEN;
  const send = vi.fn();
  const close = vi.fn(() => {
    readyState = WebSocket.CLOSED;
    emitter.emit("close");
  });

  const fakeWs = {
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    send,
    close,
    get readyState() {
      return readyState;
    },
  };

  return {
    ws: fakeWs as unknown as WebSocket,
    send,
    close,
    emitMessage: (raw: string) => {
      emitter.emit("message", raw);
    },
  };
}

/**
 * fake WebSocket を、実ソケット・実 upgrade を経由せず bridge の
 * `wss.emit("connection", ...)` へ直接流し込んで接続を確立する。
 */
function connectFakeWebSocket(
  bridge: ReturnType<typeof createTerminalWebSocketServer>,
  entry: FleetEntry = MEDICAL_ENTRY,
) {
  const fake = createFakeWebSocket();
  bridge.wss.emit("connection", fake.ws, {} as never, entry);
  return fake;
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

  // 契約確認: bridge.ts の該当 catch（コメント「該当タブでの入力/リサイズが
  // 失われるのみ。board 全体を巻き込む必要は無い」）は接続を close() しない
  // 「隔離して継続する」実装であり、「該当接続を閉じる」実装ではない。
  // テストの見出し・アサーションはこの実挙動に一致させる（readyState だけでなく、
  // 後続の別種メッセージが引き続き処理されることまで検証し、「閉じていないだけで
  // 実は壊れている」誤検知を防ぐ）。
  it("pty.resize が例外を投げても board プロセス全体を巻き込まず、該当操作のみ失われて接続は閉じずに継続する", async () => {
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

      // readyState だけでなく、例外の後も別種のメッセージ（input）が
      // 引き続き処理されることを確認する（接続が生きたまま機能し続けている
      // ことの証明。閉じていないだけで実は詰まっている、を検知できるように）。
      ws.send(
        JSON.stringify({ type: "input", data: "marker-after-resize-throw" }),
      );
      await vi.waitFor(() => {
        expect(fakePty.write).toHaveBeenCalledWith("marker-after-resize-throw");
      });

      ws.close();
    } finally {
      process.off("uncaughtException", onUncaughtException);
    }

    expect(unhandledExceptions).toEqual([]);
  });

  it("pty.write が例外を投げても board プロセス全体を巻き込まず、該当操作のみ失われて接続は閉じずに継続する", async () => {
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

      // readyState だけでなく、例外の後も別種のメッセージ（resize）が
      // 引き続き処理されることを確認する（write が今後も例外を投げ続けても、
      // 接続自体・他メッセージの処理は影響を受けないことの証明）。
      ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
      await vi.waitFor(() => {
        expect(fakePty.resize).toHaveBeenCalledWith(100, 30);
      });

      ws.close();
    } finally {
      process.off("uncaughtException", onUncaughtException);
    }

    expect(unhandledExceptions).toEqual([]);
  });

  it("pty 起動前（tmux セッション確保待ち）に届いた input/resize/prefill は、上限付きキューに貯められ、pty 起動後に届いた順で処理される（invocationCallOrder で順序を完全検証）", async () => {
    // deferred な hasSession（手動 resolve できる Promise）と、直接操作できる
    // fake WebSocket を使う。実ソケット・固定時間の sleep に頼らず、
    // 「メッセージ投入 → セッション確保を明示的に再開」という手順を決定的に
    // 再現できる（bridge の "connection" ハンドラを wss.emit で直接駆動するため、
    // 実ソケット到達のタイミング競合が原理的に発生しない）。
    const hasSessionDeferred = createDeferred<boolean>();
    const sendKeysLiteral = vi
      .fn<TmuxClient["sendKeysLiteral"]>()
      .mockResolvedValue(undefined);
    const tmux = createFakeTmux({
      hasSession: vi.fn(() => hasSessionDeferred.promise),
      sendKeysLiteral,
    });
    const fakePty = createFakePty();
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty: () => fakePty.ptyProcess,
    });

    const { emitMessage } = connectFakeWebSocket(bridge);

    // pty がまだ起動していない（hasSession が pending）間に
    // resize → prefill の順でメッセージを投入する。
    emitMessage(JSON.stringify({ type: "resize", cols: 90, rows: 30 }));
    emitMessage(JSON.stringify({ type: "prefill", command: "git status" }));

    // ここまでは pty 未起動のため、どちらの処理も走っていないはず
    // （キューに貯められているだけであることの確認）。
    expect(fakePty.resize).not.toHaveBeenCalled();
    expect(sendKeysLiteral).not.toHaveBeenCalled();

    // セッション確保を明示的に再開する。
    hasSessionDeferred.resolve(false);

    await vi.waitFor(() => {
      expect(sendKeysLiteral).toHaveBeenCalledWith(
        "flywheel-medical",
        "git status",
      );
    });
    expect(fakePty.resize).toHaveBeenCalledWith(90, 30);

    // 届いた順（resize→prefill）で処理されたことを、2つの異なる mock 間で
    // 共有される invocationCallOrder により完全に検証する。
    const resizeOrder = fakePty.resize.mock.invocationCallOrder[0];
    const sendKeysOrder = sendKeysLiteral.mock.invocationCallOrder[0];
    if (resizeOrder === undefined || sendKeysOrder === undefined) {
      throw new Error("invocationCallOrder が記録されていない");
    }
    expect(resizeOrder).toBeLessThan(sendKeysOrder);
  });

  it("pty 起動前に届いたメッセージは上限（100件）を超えると古い順に破棄される（保持内容を完全一致で検証）", async () => {
    const hasSessionDeferred = createDeferred<boolean>();
    const tmux = createFakeTmux({
      hasSession: vi.fn(() => hasSessionDeferred.promise),
    });
    const fakePty = createFakePty();
    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => FLEET_ENTRIES,
      tmux,
      spawnPty: () => fakePty.ptyProcess,
    });

    const { emitMessage } = connectFakeWebSocket(bridge);

    // 上限 100 件を超える 105 件の input を、pty 起動前（hasSession pending 中）
    // に投入する。
    for (let i = 0; i < 105; i += 1) {
      emitMessage(JSON.stringify({ type: "input", data: `line-${i}\n` }));
    }
    expect(fakePty.write).not.toHaveBeenCalled();

    // セッション確保を明示的に再開する。
    hasSessionDeferred.resolve(false);

    await vi.waitFor(() => {
      expect(fakePty.write).toHaveBeenCalledTimes(100);
    });

    // 保持された内容が「line-5〜line-104」の100件と完全一致すること
    // （破棄位置＝先頭5件 line-0..line-4 が失われることを、境界値の
    // スポットチェックではなく全件の完全一致で固定する）。
    const expectedCalls = Array.from({ length: 100 }, (_, index) => [
      `line-${index + 5}\n`,
    ]);
    expect(fakePty.write.mock.calls).toEqual(expectedCalls);
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

      // 呼び出し確認後、イベントループを明示的に1ターン進めてから判定する。
      // unhandledRejection は現在のマイクロタスクチェーンが尽きた後（次の
      // イベントループのタイミング）で発火するため、setImmediate で1ターン
      // 進めることで、「発火しない」という否定の検証をより確実にする。
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
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
      // （bridge.ts 側の try/catch で同期的に捕捉され、ws.close(1011, ...) が
      // 呼ばれる）。open/closed/error の択一を許容すると、たまたま open が
      // 先に観測された実行では「実際に閉じたか」を一切検証しないまま緑になって
      // しまう。必ず close イベントを待ち、WebSocket.CLOSED を検証する。
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
      });

      expect(ws.readyState).toBe(WebSocket.CLOSED);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(unhandledRejections).toEqual([]);
  });
});
